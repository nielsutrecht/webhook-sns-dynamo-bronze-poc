import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { stackName } from "../config";
import { lambdaRole, lambdaCode } from "../utils";

interface AnalyticsArgs {
  bronzeBucket: aws.s3.Bucket;
  silverBucket: aws.s3.Bucket;
  goldBucket: aws.s3.Bucket;
  athenaResultsBucket: aws.s3.Bucket;
}

export class AnalyticsComponent extends pulumi.ComponentResource {
  readonly glueDatabase: aws.glue.CatalogDatabase;
  readonly athenaWorkgroup: aws.athena.Workgroup;
  readonly silverTriggerQueue: aws.sqs.Queue;

  constructor(name: string, args: AnalyticsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("sns-bronze-poc:components:Analytics", name, {}, opts);
    const parent = { parent: this };

    // Glue database
    this.glueDatabase = new aws.glue.CatalogDatabase("glue-database", {
      name: pulumi.interpolate`webhook_${stackName}`,
    }, parent);

    // Athena workgroup
    this.athenaWorkgroup = new aws.athena.Workgroup("athena-workgroup", {
      name: pulumi.interpolate`webhook-${stackName}`,
      configuration: {
        engineVersion: {
          selectedEngineVersion: "Athena engine version 3",
        },
        resultConfiguration: {
          outputLocation: pulumi.interpolate`s3://${args.athenaResultsBucket.bucket}/`,
        },
        bytesScannedCutoffPerQuery: 1 * 1024 * 1024 * 1024, // 1 GB
        enforceWorkgroupConfiguration: true,
      },
      forceDestroy: true,
    }, parent);

    // Silver trigger SQS DLQ + queue
    const silverTriggerDlq = new aws.sqs.Queue("silver-trigger-dlq", {
      name: pulumi.interpolate`silver-trigger-dlq-${stackName}`,
      messageRetentionSeconds: 1209600, // 14 days
    }, parent);

    this.silverTriggerQueue = new aws.sqs.Queue("silver-trigger-queue", {
      name: pulumi.interpolate`silver-trigger-${stackName}`,
      visibilityTimeoutSeconds: 300, // must be >= Lambda timeout
      redrivePolicy: pulumi.jsonStringify({
        deadLetterTargetArn: silverTriggerDlq.arn,
        maxReceiveCount: 3,
      }),
    }, parent);

    // Allow S3 to send messages to the silver trigger queue
    new aws.sqs.QueuePolicy("silver-trigger-queue-policy", {
      queueUrl: this.silverTriggerQueue.url,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "s3.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: this.silverTriggerQueue.arn,
            Condition: { ArnLike: { "aws:SourceArn": args.bronzeBucket.arn } },
          },
        ],
      }),
    }, parent);

    // S3 event notification: bronze bucket events/ prefix → silver trigger queue
    new aws.s3.BucketNotification("bronze-bucket-notification", {
      bucket: args.bronzeBucket.id,
      queues: [
        {
          queueArn: this.silverTriggerQueue.arn,
          events: ["s3:ObjectCreated:*"],
          filterPrefix: "events/",
        },
      ],
    }, parent);

    // Orchestrator Lambda IAM role
    const orchestratorRole = lambdaRole("orchestrator", [
      {
        name: "athena",
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "athena:StartQueryExecution",
                "athena:GetQueryExecution",
                "athena:GetQueryResults",
                "athena:GetWorkGroup",
              ],
              Resource: pulumi.interpolate`arn:aws:athena:*:*:workgroup/webhook-${stackName}`,
            },
          ],
        }),
      },
      {
        name: "glue",
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "glue:GetDatabase",
                "glue:GetTable",
                "glue:CreateTable",
                "glue:UpdateTable",
                "glue:GetPartitions",
                "glue:BatchCreatePartition",
                "glue:GetPartition",
              ],
              Resource: "*",
            },
          ],
        }),
      },
      {
        name: "s3",
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket"],
              Resource: [args.bronzeBucket.arn, pulumi.interpolate`${args.bronzeBucket.arn}/*`],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:ListBucket",
                       "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
              Resource: [
                args.silverBucket.arn, pulumi.interpolate`${args.silverBucket.arn}/*`,
                args.goldBucket.arn, pulumi.interpolate`${args.goldBucket.arn}/*`,
              ],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:ListBucket",
                       "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
              Resource: [args.athenaResultsBucket.arn, pulumi.interpolate`${args.athenaResultsBucket.arn}/*`],
            },
          ],
        }),
      },
      {
        name: "sqs-receive",
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
            Resource: this.silverTriggerQueue.arn,
          }],
        }),
      },
    ]);

    // Orchestrator Lambda
    const orchestratorLambda = new aws.lambda.Function("orchestrator", {
      name: pulumi.interpolate`orchestrator-${stackName}`,
      runtime: aws.lambda.Runtime.NodeJS20dX,
      handler: "index.handler",
      role: orchestratorRole.arn,
      code: lambdaCode("orchestrator.js"),
      environment: {
        variables: {
          GLUE_DATABASE: this.glueDatabase.name,
          ATHENA_WORKGROUP: this.athenaWorkgroup.name,
          BRONZE_BUCKET: args.bronzeBucket.bucket,
          SILVER_BUCKET: args.silverBucket.bucket,
          GOLD_BUCKET: args.goldBucket.bucket,
          RESULTS_BUCKET: args.athenaResultsBucket.bucket,
        },
      },
      timeout: 300,
      reservedConcurrentExecutions: 1,
    }, parent);

    // SQS event source mapping: silver-trigger → orchestrator
    new aws.lambda.EventSourceMapping("orchestrator-sqs-trigger", {
      eventSourceArn: this.silverTriggerQueue.arn,
      functionName: orchestratorLambda.arn,
      batchSize: 1,
    }, parent);

    this.registerOutputs({
      glueDatabaseName: this.glueDatabase.name,
      athenaWorkgroupName: this.athenaWorkgroup.name,
      silverTriggerQueueUrl: this.silverTriggerQueue.url,
    });
  }
}

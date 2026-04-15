import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { stackName } from "../config";
import { lambdaRole, lambdaCode } from "../utils";

interface IngestionArgs {
  bronzeBucket: aws.s3.Bucket;
}

export class IngestionComponent extends pulumi.ComponentResource {
  readonly topic: aws.sns.Topic;
  readonly firehoseStream: aws.kinesis.FirehoseDeliveryStream;

  constructor(name: string, args: IngestionArgs, opts?: pulumi.ComponentResourceOptions) {
    super("sns-bronze-poc:components:Ingestion", name, {}, opts);
    const parent = { parent: this };

    // SNS topic
    this.topic = new aws.sns.Topic("transactions-topic", {
      name: `transactions-${stackName}`,
    }, parent);

    // Transform Lambda — no AWS permissions needed (transforms data in memory)
    const fieldRules = JSON.stringify({
      "$.occurredAt": "partition-key",
      "$.accountId": "hash",
      "$.customerId": "hash",
      "$.counterpartyIban": "hash",
      "$.description": "drop",
      "$.counterpartyName": "drop",
      "$.bankReference": "drop",
    });

    const transformRole = lambdaRole("firehose-transform");

    const transformLambda = new aws.lambda.Function("firehose-transform", {
      name: `firehose-transform-${stackName}`,
      runtime: aws.lambda.Runtime.NodeJS20dX,
      handler: "index.handler",
      role: transformRole.arn,
      code: lambdaCode("firehose-transform.js"),
      environment: { variables: { FIELD_RULES: fieldRules } },
      timeout: 60,
    }, parent);

    // IAM — Firehose delivery role
    const firehoseRole = new aws.iam.Role("firehose-role", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "firehose.amazonaws.com" }),
      inlinePolicies: [
        {
          name: "s3-delivery",
          policy: pulumi.jsonStringify({
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: ["s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket"],
              Resource: [args.bronzeBucket.arn, pulumi.interpolate`${args.bronzeBucket.arn}/*`],
            }],
          }),
        },
        {
          name: "lambda-invoke",
          policy: pulumi.jsonStringify({
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: "lambda:InvokeFunction",
              Resource: transformLambda.arn,
            }],
          }),
        },
      ],
    }, parent);

    // IAM — SNS role for Firehose subscription
    const snsFirehoseRole = new aws.iam.Role("sns-firehose-role", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "sns.amazonaws.com" }),
      inlinePolicies: [
        {
          name: "firehose-put",
          policy: pulumi.jsonStringify({
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: ["firehose:PutRecord", "firehose:PutRecordBatch"],
              Resource: "*",
            }],
          }),
        },
      ],
    }, parent);

    // Firehose delivery stream
    this.firehoseStream = new aws.kinesis.FirehoseDeliveryStream("bronze-stream", {
      name: `bronze-${stackName}`,
      destination: "extended_s3",
      extendedS3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: args.bronzeBucket.arn,
        prefix: "events/year=!{partitionKeyFromQuery:year}/month=!{partitionKeyFromQuery:month}/day=!{partitionKeyFromQuery:day}/",
        errorOutputPrefix: "errors/",
        bufferingInterval: 60,
        bufferingSize: 64,
        dynamicPartitioningConfiguration: { enabled: true },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: "MetadataExtraction",
              parameters: [
                {
                  parameterName: "MetadataExtractionQuery",
                  parameterValue: "{year:.occurredAt[0:4],month:.occurredAt[5:7],day:.occurredAt[8:10]}",
                },
                { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
              ],
            },
            {
              type: "Lambda",
              parameters: [
                { parameterName: "LambdaArn", parameterValue: transformLambda.arn },
              ],
            },
          ],
        },
      },
    }, parent);

    // SNS → Firehose subscription
    new aws.sns.TopicSubscription("firehose-subscription", {
      topic: this.topic.arn,
      protocol: "firehose",
      endpoint: this.firehoseStream.arn,
      subscriptionRoleArn: snsFirehoseRole.arn,
    }, parent);

    this.registerOutputs({
      topicArn: this.topic.arn,
      firehoseStreamName: this.firehoseStream.name,
    });
  }
}

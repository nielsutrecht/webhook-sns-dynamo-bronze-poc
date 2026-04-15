import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { stackName } from "../config";
import { lambdaRole, lambdaCode } from "../utils";

interface DynamoSinkArgs {
  topic: aws.sns.Topic;
}

export class DynamoSinkComponent extends pulumi.ComponentResource {
  readonly table: aws.dynamodb.Table;
  readonly queue: aws.sqs.Queue;
  readonly dlq: aws.sqs.Queue;

  constructor(name: string, args: DynamoSinkArgs, opts?: pulumi.ComponentResourceOptions) {
    super("sns-bronze-poc:components:DynamoSink", name, {}, opts);
    const parent = { parent: this };

    // DynamoDB table
    this.table = new aws.dynamodb.Table("transactions-table", {
      name: `transactions-${stackName}`,
      billingMode: "PAY_PER_REQUEST",
      hashKey: "transactionId",
      attributes: [{ name: "transactionId", type: "S" }],
    }, parent);

    // SQS DLQ + queue
    this.dlq = new aws.sqs.Queue("dynamo-dlq", {
      name: `transactions-dynamo-dlq-${stackName}`,
      messageRetentionSeconds: 1209600, // 14 days
    }, parent);

    this.queue = new aws.sqs.Queue("dynamo-queue", {
      name: `transactions-dynamo-${stackName}`,
      visibilityTimeoutSeconds: 30,
      redrivePolicy: pulumi.jsonStringify({
        deadLetterTargetArn: this.dlq.arn,
        maxReceiveCount: 3,
      }),
    }, parent);

    // Allow SNS to send messages to the queue
    new aws.sqs.QueuePolicy("dynamo-queue-policy", {
      queueUrl: this.queue.url,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "sns.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: this.queue.arn,
            Condition: { ArnEquals: { "aws:SourceArn": args.topic.arn } },
          },
        ],
      }),
    }, parent);

    // SNS → SQS subscription
    new aws.sns.TopicSubscription("dynamo-subscription", {
      topic: args.topic.arn,
      protocol: "sqs",
      endpoint: this.queue.arn,
      rawMessageDelivery: false,
    }, parent);

    // DynamoDB subscriber Lambda
    const dynamoRole = lambdaRole("dynamo-subscriber", [
      {
        name: "dynamo-put",
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Action: "dynamodb:PutItem",
            Resource: this.table.arn,
          }],
        }),
      },
      {
        name: "sqs-receive",
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
            Resource: this.queue.arn,
          }],
        }),
      },
    ]);

    const dynamoLambda = new aws.lambda.Function("dynamo-subscriber", {
      name: `dynamo-subscriber-${stackName}`,
      runtime: aws.lambda.Runtime.NodeJS20dX,
      handler: "index.handler",
      role: dynamoRole.arn,
      code: lambdaCode("dynamo-subscriber.js"),
      environment: { variables: { TABLE_NAME: this.table.name } },
      timeout: 30,
    }, parent);

    new aws.lambda.EventSourceMapping("dynamo-sqs-trigger", {
      eventSourceArn: this.queue.arn,
      functionName: dynamoLambda.arn,
      batchSize: 10,
      functionResponseTypes: ["ReportBatchItemFailures"],
    }, parent);

    this.registerOutputs({
      tableName: this.table.name,
      queueUrl: this.queue.url,
      dlqUrl: this.dlq.url,
    });
  }
}

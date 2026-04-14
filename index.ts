import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as path from "path";

const stackName = pulumi.getStack();

// ---------------------------------------------------------------------------
// S3 — bronze bucket (task 2.1)
// ---------------------------------------------------------------------------

const bronzeBucket = new aws.s3.Bucket("bronze-bucket", {
  bucket: `webhook-bronze-${stackName}`,
  forceDestroy: true, // allow teardown without manual object deletion
});

export const bronzeBucketName = bronzeBucket.bucket;

// ---------------------------------------------------------------------------
// S3 — silver, gold, and Athena results buckets (tasks 1.1–1.3)
// ---------------------------------------------------------------------------

const silverBucket = new aws.s3.Bucket("silver-bucket", {
  bucket: pulumi.interpolate`webhook-silver-${stackName}`,
  forceDestroy: true,
});

export const silverBucketName = silverBucket.bucket;

const goldBucket = new aws.s3.Bucket("gold-bucket", {
  bucket: pulumi.interpolate`webhook-gold-${stackName}`,
  forceDestroy: true,
});

export const goldBucketName = goldBucket.bucket;

const athenaResultsBucket = new aws.s3.Bucket("athena-results-bucket", {
  bucket: pulumi.interpolate`webhook-athena-results-${stackName}`,
  forceDestroy: true,
});

export const athenaResultsBucketName = athenaResultsBucket.bucket;

// ---------------------------------------------------------------------------
// Glue Data Catalog database (task 2.1)
// ---------------------------------------------------------------------------

const glueDatabase = new aws.glue.CatalogDatabase("glue-database", {
  name: pulumi.interpolate`webhook_${stackName}`,
});

export const glueDatabaseName = glueDatabase.name;

// ---------------------------------------------------------------------------
// Athena workgroup (task 2.2)
// ---------------------------------------------------------------------------

const athenaWorkgroup = new aws.athena.Workgroup("athena-workgroup", {
  name: pulumi.interpolate`webhook-${stackName}`,
  configuration: {
    engineVersion: {
      selectedEngineVersion: "Athena engine version 3", // required for Iceberg MERGE
    },
    resultConfiguration: {
      outputLocation: pulumi.interpolate`s3://${athenaResultsBucket.bucket}/`,
    },
    bytesScannedCutoffPerQuery: 1 * 1024 * 1024 * 1024, // 1 GB
    enforceWorkgroupConfiguration: true,
  },
  forceDestroy: true,
});

export const athenaWorkgroupName = athenaWorkgroup.name;

// ---------------------------------------------------------------------------
// DynamoDB — raw transactions table (task 2.2)
// ---------------------------------------------------------------------------

const transactionsTable = new aws.dynamodb.Table("transactions-table", {
  name: `transactions-${stackName}`,
  billingMode: "PAY_PER_REQUEST",
  hashKey: "transactionId",
  attributes: [{ name: "transactionId", type: "S" }],
});

export const transactionsTableName = transactionsTable.name;

// ---------------------------------------------------------------------------
// SNS topic (task 3.1)
// ---------------------------------------------------------------------------

const topic = new aws.sns.Topic("transactions-topic", {
  name: `transactions-${stackName}`,
});

export const topicArn = topic.arn;

// ---------------------------------------------------------------------------
// SQS — DynamoDB subscriber queue + DLQ (task 3.2)
// ---------------------------------------------------------------------------

const dynamoDlq = new aws.sqs.Queue("dynamo-dlq", {
  name: `transactions-dynamo-dlq-${stackName}`,
  messageRetentionSeconds: 1209600, // 14 days
});

const dynamoQueue = new aws.sqs.Queue("dynamo-queue", {
  name: `transactions-dynamo-${stackName}`,
  visibilityTimeoutSeconds: 30,
  redrivePolicy: pulumi.jsonStringify({
    deadLetterTargetArn: dynamoDlq.arn,
    maxReceiveCount: 3,
  }),
});

// Allow SNS to send messages to the SQS queue
new aws.sqs.QueuePolicy("dynamo-queue-policy", {
  queueUrl: dynamoQueue.url,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: dynamoQueue.arn,
        Condition: { ArnEquals: { "aws:SourceArn": topic.arn } },
      },
    ],
  }),
});

// SNS → SQS subscription (task 3.3)
new aws.sns.TopicSubscription("dynamo-subscription", {
  topic: topic.arn,
  protocol: "sqs",
  endpoint: dynamoQueue.arn,
  rawMessageDelivery: false, // keep SNS envelope so handlers can unwrap it
});

export const dynamoQueueUrl = dynamoQueue.url;
export const dynamoDlqUrl = dynamoDlq.url;

// ---------------------------------------------------------------------------
// SQS — silver trigger queue + DLQ (task 3.1)
// ---------------------------------------------------------------------------

const silverTriggerDlq = new aws.sqs.Queue("silver-trigger-dlq", {
  name: pulumi.interpolate`silver-trigger-dlq-${stackName}`,
  messageRetentionSeconds: 1209600, // 14 days
});

const silverTriggerQueue = new aws.sqs.Queue("silver-trigger-queue", {
  name: pulumi.interpolate`silver-trigger-${stackName}`,
  visibilityTimeoutSeconds: 300, // must be >= Lambda timeout
  redrivePolicy: pulumi.jsonStringify({
    deadLetterTargetArn: silverTriggerDlq.arn,
    maxReceiveCount: 3,
  }),
});

// Allow S3 to send messages to the silver trigger queue (task 3.3)
new aws.sqs.QueuePolicy("silver-trigger-queue-policy", {
  queueUrl: silverTriggerQueue.url,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "s3.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: silverTriggerQueue.arn,
        Condition: { ArnLike: { "aws:SourceArn": bronzeBucket.arn } },
      },
    ],
  }),
});

// S3 event notification: bronze bucket events/ prefix → silver trigger queue (task 3.2)
new aws.s3.BucketNotification("bronze-bucket-notification", {
  bucket: bronzeBucket.id,
  queues: [
    {
      queueArn: silverTriggerQueue.arn,
      events: ["s3:ObjectCreated:*"],
      filterPrefix: "events/",
    },
  ],
});

export const silverTriggerQueueUrl = silverTriggerQueue.url;
export const silverTriggerDlqUrl = silverTriggerDlq.url;

// ---------------------------------------------------------------------------
// Lambda execution role helper
// ---------------------------------------------------------------------------

function lambdaRole(name: string, inlinePolicies: aws.iam.RoleArgs["inlinePolicies"] = []): aws.iam.Role {
  return new aws.iam.Role(`${name}-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
    managedPolicyArns: [aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole],
    inlinePolicies,
  });
}

function lambdaCode(distFile: string): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.FileAsset(path.join("dist", distFile)),
  });
}

// ---------------------------------------------------------------------------
// Webhook Publisher Lambda (tasks 4.3)
// ---------------------------------------------------------------------------

const webhookRole = lambdaRole("webhook-publisher", [
  {
    name: "sns-publish",
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "sns:Publish", Resource: topic.arn }],
    }),
  },
]);

const webhookLambda = new aws.lambda.Function("webhook-publisher", {
  name: `webhook-publisher-${stackName}`,
  runtime: aws.lambda.Runtime.NodeJS20dX,
  handler: "index.handler",
  role: webhookRole.arn,
  code: lambdaCode("webhook-publisher.js"),
  environment: { variables: { TOPIC_ARN: topic.arn } },
  timeout: 10,
});

export const webhookLambdaName = webhookLambda.name;

// ---------------------------------------------------------------------------
// DynamoDB Subscriber Lambda (tasks 5.3–5.4)
// ---------------------------------------------------------------------------

const dynamoRole = lambdaRole("dynamo-subscriber", [
  {
    name: "dynamo-put",
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "dynamodb:PutItem",
        Resource: transactionsTable.arn,
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
        Resource: dynamoQueue.arn,
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
  environment: { variables: { TABLE_NAME: transactionsTable.name } },
  timeout: 30,
});

// SQS event source mapping — batch size 10
new aws.lambda.EventSourceMapping("dynamo-sqs-trigger", {
  eventSourceArn: dynamoQueue.arn,
  functionName: dynamoLambda.arn,
  batchSize: 10,
  functionResponseTypes: ["ReportBatchItemFailures"],
});

// ---------------------------------------------------------------------------
// Firehose Transform Lambda (task 7.4)
// ---------------------------------------------------------------------------

const fieldRules = JSON.stringify({
  "$.occurredAt": "partition-key",
  "$.accountId": "hash",
  "$.customerId": "hash",
  "$.counterpartyIban": "hash",
  "$.description": "drop",
  "$.counterpartyName": "drop",
  "$.bankReference": "drop",
});

// Transform Lambda needs no AWS permissions — it only transforms data in memory
const transformRole = lambdaRole("firehose-transform");

const transformLambda = new aws.lambda.Function("firehose-transform", {
  name: `firehose-transform-${stackName}`,
  runtime: aws.lambda.Runtime.NodeJS20dX,
  handler: "index.handler",
  role: transformRole.arn,
  code: lambdaCode("firehose-transform.js"),
  environment: { variables: { FIELD_RULES: fieldRules } },
  timeout: 60, // Firehose transform timeout must be ≤ stream buffer interval
});

// ---------------------------------------------------------------------------
// IAM — Firehose delivery role (task 8.8)
// ---------------------------------------------------------------------------

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
          Resource: [bronzeBucket.arn, pulumi.interpolate`${bronzeBucket.arn}/*`],
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
});

// IAM — SNS role for Firehose subscription (task 8.8)
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
          // Resource set after stream is created — reference the stream ARN below
          Resource: "*",
        }],
      }),
    },
  ],
});

// ---------------------------------------------------------------------------
// Kinesis Data Firehose delivery stream (tasks 8.1–8.7)
// ---------------------------------------------------------------------------

const firehoseStream = new aws.kinesis.FirehoseDeliveryStream("bronze-stream", {
  name: `bronze-${stackName}`,
  destination: "extended_s3",
  extendedS3Configuration: {
    roleArn: firehoseRole.arn,
    bucketArn: bronzeBucket.arn,

    // Dynamic Hive-partitioned prefix (task 8.4)
    prefix: "events/year=!{partitionKeyFromQuery:year}/month=!{partitionKeyFromQuery:month}/day=!{partitionKeyFromQuery:day}/",
    // Error prefix (task 8.5)
    errorOutputPrefix: "errors/",

    // Buffer: 60s / 64MB — dynamic partitioning requires minimum 64MB (task 8.6)
    bufferingInterval: 60,
    bufferingSize: 64,

    // Dynamic partitioning must be enabled alongside processing (task 8.3)
    dynamicPartitioningConfiguration: { enabled: true },

    processingConfiguration: {
      enabled: true,
      processors: [
        // MetadataExtraction: derive partition keys from occurredAt (task 8.3)
        {
          type: "MetadataExtraction",
          parameters: [
            {
              parameterName: "MetadataExtractionQuery",
              // Use string slicing on the ISO timestamp: "2024-03-15T..."
              parameterValue: "{year:.occurredAt[0:4],month:.occurredAt[5:7],day:.occurredAt[8:10]}",
            },
            { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
          ],
        },
        // Lambda transform: pseudonymize (task 8.2)
        {
          type: "Lambda",
          parameters: [
            { parameterName: "LambdaArn", parameterValue: transformLambda.arn },
          ],
        },
      ],
    },
  },
});

export const firehoseStreamName = firehoseStream.name;

// SNS → Firehose subscription (task 8.7)
new aws.sns.TopicSubscription("firehose-subscription", {
  topic: topic.arn,
  protocol: "firehose",
  endpoint: firehoseStream.arn,
  subscriptionRoleArn: snsFirehoseRole.arn,
});

// ---------------------------------------------------------------------------
// Orchestrator Lambda — IAM role (task 4.1)
// ---------------------------------------------------------------------------

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
          Resource: [bronzeBucket.arn, pulumi.interpolate`${bronzeBucket.arn}/*`],
        },
        {
          Effect: "Allow",
          Action: ["s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:ListBucket",
                   "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
          Resource: [
            silverBucket.arn, pulumi.interpolate`${silverBucket.arn}/*`,
            goldBucket.arn, pulumi.interpolate`${goldBucket.arn}/*`,
          ],
        },
        {
          Effect: "Allow",
          Action: ["s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:ListBucket",
                   "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
          Resource: [athenaResultsBucket.arn, pulumi.interpolate`${athenaResultsBucket.arn}/*`],
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
        Resource: silverTriggerQueue.arn,
      }],
    }),
  },
]);

// ---------------------------------------------------------------------------
// Orchestrator Lambda (task 4.2)
// ---------------------------------------------------------------------------

const orchestratorLambda = new aws.lambda.Function("orchestrator", {
  name: pulumi.interpolate`orchestrator-${stackName}`,
  runtime: aws.lambda.Runtime.NodeJS20dX,
  handler: "index.handler",
  role: orchestratorRole.arn,
  code: lambdaCode("orchestrator.js"),
  environment: {
    variables: {
      GLUE_DATABASE: glueDatabase.name,
      ATHENA_WORKGROUP: athenaWorkgroup.name,
      BRONZE_BUCKET: bronzeBucket.bucket,
      SILVER_BUCKET: silverBucket.bucket,
      GOLD_BUCKET: goldBucket.bucket,
      RESULTS_BUCKET: athenaResultsBucket.bucket,
    },
  },
  timeout: 300, // 5 min — Athena queries can take time; must match SQS visibility timeout
  reservedConcurrentExecutions: 1, // serialise silver MERGE + gold rebuilds
});

// SQS event source mapping: silver-trigger → orchestrator (task 4.3)
new aws.lambda.EventSourceMapping("orchestrator-sqs-trigger", {
  eventSourceArn: silverTriggerQueue.arn,
  functionName: orchestratorLambda.arn,
  batchSize: 1,
});

// ---------------------------------------------------------------------------
// Pulumi config
// ---------------------------------------------------------------------------

const config = new pulumi.Config();
// Set with: pulumi config set developerCidr <your-ip>/32
const developerCidr = config.get("developerCidr") ?? "0.0.0.0/0";

// ---------------------------------------------------------------------------
// Metabase — IAM: EC2 instance role (task 1.1)
// ---------------------------------------------------------------------------

const metabaseEc2Role = new aws.iam.Role("metabase-ec2-role", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
  inlinePolicies: [
    {
      name: "athena",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              // Schema discovery — needed by Metabase on initial connection
              "athena:ListDataCatalogs",
              "athena:GetDataCatalog",
              "athena:ListDatabases",
              "athena:GetDatabase",
              "athena:ListTableMetadata",
              "athena:GetTableMetadata",
              // Query execution
              "athena:StartQueryExecution",
              "athena:GetQueryExecution",
              "athena:GetQueryResults",
              "athena:GetWorkGroup",
              "athena:ListQueryExecutions",
              "athena:StopQueryExecution",
              // Prepared statements — required by Simba JDBC driver on connect
              "athena:CreatePreparedStatement",
              "athena:GetPreparedStatement",
              "athena:DeletePreparedStatement",
              "athena:ListPreparedStatements",
            ],
            Resource: "*",
          },
        ],
      }),
    },
    {
      name: "glue",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "glue:GetDatabase",
              "glue:GetDatabases",
              "glue:GetTable",
              "glue:GetTables",
              "glue:GetPartition",
              "glue:GetPartitions",
              "glue:BatchGetPartition",
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
            Resource: [
              silverBucket.arn, pulumi.interpolate`${silverBucket.arn}/*`,
              goldBucket.arn, pulumi.interpolate`${goldBucket.arn}/*`,
            ],
          },
          {
            Effect: "Allow",
            Action: [
              "s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:ListBucket",
              "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts",
            ],
            Resource: [athenaResultsBucket.arn, pulumi.interpolate`${athenaResultsBucket.arn}/*`],
          },
        ],
      }),
    },
  ],
});

const metabaseInstanceProfile = new aws.iam.InstanceProfile("metabase-instance-profile", {
  role: metabaseEc2Role.name,
});

// ---------------------------------------------------------------------------
// Metabase — IAM: auto-stop Lambda role (task 1.2)
// ---------------------------------------------------------------------------

const metabaseStopRole = lambdaRole("metabase-stop", [
  {
    name: "ec2-stop",
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["ec2:StopInstances", "ec2:DescribeInstances"],
          Resource: "*",
        },
      ],
    }),
  },
]);

// ---------------------------------------------------------------------------
// Metabase — Security group (task 1.3)
// ---------------------------------------------------------------------------
// Restrict ingress to your IP: pulumi config set developerCidr <your-ip>/32

const metabaseSecurityGroup = new aws.ec2.SecurityGroup("metabase-sg", {
  name: pulumi.interpolate`metabase-${stackName}`,
  description: "Metabase - ingress port 3000, all egress",
  ingress: [
    {
      protocol: "tcp",
      fromPort: 3000,
      toPort: 3000,
      cidrBlocks: [developerCidr],
      description: "Metabase UI",
    },
  ],
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
  tags: { Name: pulumi.interpolate`metabase-${stackName}` },
});

// ---------------------------------------------------------------------------
// Metabase — EC2 instance + EBS (tasks 2.1–2.4)
// ---------------------------------------------------------------------------

// Use the same AZ for the instance (EBS volume is inline below)
const firstAz = aws.getAvailabilityZonesOutput({ state: "available" }).apply(azs => azs.names[0]);

const metabaseAmi = aws.ec2.getAmiOutput({
  owners: ["amazon"],
  mostRecent: true,
  filters: [{ name: "name", values: ["al2023-ami-*-x86_64"] }],
});

// User-data: runs on first boot. Mounts EBS, installs Java, downloads Metabase JAR, sets up systemd.
// Subsequent starts: EBS is already mounted via fstab; systemd auto-starts metabase.service.
const metabaseUserData = `#!/bin/bash
set -euo pipefail

MOUNTPOINT="/metabase-data"

# On AL2023 t3 instances: root=nvme0n1, first additional EBS=nvme1n1 (/dev/sdf alias)
DEVICE="/dev/nvme1n1"

# Format only if the volume has no filesystem
if ! blkid "$DEVICE" &>/dev/null; then
  mkfs.ext4 "$DEVICE"
fi

mkdir -p "$MOUNTPOINT"
mount "$DEVICE" "$MOUNTPOINT"

# Persist mount across reboots
FSTAB_ENTRY="$DEVICE $MOUNTPOINT ext4 defaults,nofail 0 2"
grep -qF "$FSTAB_ENTRY" /etc/fstab || echo "$FSTAB_ENTRY" >> /etc/fstab

# Install Java 17 (Amazon Corretto)
dnf install -y java-17-amazon-corretto-headless

# Download Metabase JAR (skip if already present on the persistent volume)
MB_VERSION="v0.52.5"
MB_JAR="$MOUNTPOINT/metabase.jar"
if [ ! -f "$MB_JAR" ]; then
  curl -fsSL "https://downloads.metabase.com/$MB_VERSION/metabase.jar" -o "$MB_JAR"
fi

# Create metabase system user
id -u metabase &>/dev/null || useradd -r -s /bin/false -d "$MOUNTPOINT" metabase
chown -R metabase:metabase "$MOUNTPOINT"

# Write systemd unit
cat > /etc/systemd/system/metabase.service << 'SERVICE'
[Unit]
Description=Metabase
After=network.target

[Service]
Type=simple
User=metabase
Environment=MB_DB_FILE=/metabase-data/metabase.db
Environment=MB_PLUGINS_DIR=/metabase-data/plugins
WorkingDirectory=/metabase-data
ExecStart=/usr/bin/java -jar /metabase-data/metabase.jar
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable metabase
systemctl start metabase
`;

// 8 GB gp3 EBS volume is defined inline on the instance (task 2.1).
// deleteOnTermination=false means the volume survives instance termination;
// re-running pulumi up after destroy will create a fresh volume.
const metabaseInstance = new aws.ec2.Instance("metabase", {
  ami: metabaseAmi.id,
  instanceType: "t3.small",
  iamInstanceProfile: metabaseInstanceProfile.name,
  vpcSecurityGroupIds: [metabaseSecurityGroup.id],
  availabilityZone: firstAz,
  userData: metabaseUserData,
  ebsBlockDevices: [
    {
      deviceName: "/dev/sdf",
      volumeSize: 8,
      volumeType: "gp3",
      deleteOnTermination: false, // persist Metabase state across instance replacement
    },
  ],
  tags: { Name: pulumi.interpolate`metabase-${stackName}` },
});

// task 2.4: export instance ID for the start script.
// Note: public IP changes on each start — that is intentional for this PoC.
// Alternative: allocate an aws.ec2.Eip and associate it with the instance for a stable URL.
export const metabaseInstanceId = metabaseInstance.id;

// ---------------------------------------------------------------------------
// Metabase — auto-stop Lambda (tasks 3.1–3.3)
// ---------------------------------------------------------------------------

const metabaseStopLambda = new aws.lambda.Function("metabase-stop", {
  name: pulumi.interpolate`metabase-stop-${stackName}`,
  runtime: aws.lambda.Runtime.NodeJS20dX,
  handler: "index.handler",
  role: metabaseStopRole.arn,
  code: lambdaCode("metabase-stop.js"),
  environment: { variables: { INSTANCE_ID: metabaseInstance.id } },
  timeout: 10,
});

// ---------------------------------------------------------------------------
// Metabase — SNS topic + alarm (tasks 3.4–3.6)
// ---------------------------------------------------------------------------

// task 3.4: SNS topic that CloudWatch alarm publishes to
const metabaseAlarmTopic = new aws.sns.Topic("metabase-alarm-topic", {
  name: pulumi.interpolate`metabase-idle-alarm-${stackName}`,
});

// task 3.5: wire topic → stop Lambda
new aws.sns.TopicSubscription("metabase-alarm-sub", {
  topic: metabaseAlarmTopic.arn,
  protocol: "lambda",
  endpoint: metabaseStopLambda.arn,
});

// Allow SNS to invoke the stop Lambda
new aws.lambda.Permission("metabase-stop-sns-permission", {
  action: "lambda:InvokeFunction",
  function: metabaseStopLambda.name,
  principal: "sns.amazonaws.com",
  sourceArn: metabaseAlarmTopic.arn,
});

// task 3.6: CloudWatch alarm — CPU < 5% for 2 × 5-minute periods → stop instance
new aws.cloudwatch.MetricAlarm("metabase-idle-alarm", {
  name: pulumi.interpolate`metabase-idle-${stackName}`,
  comparisonOperator: "LessThanThreshold",
  evaluationPeriods: 2,
  metricName: "CPUUtilization",
  namespace: "AWS/EC2",
  period: 300, // 5 minutes
  statistic: "Average",
  threshold: 5,
  dimensions: { InstanceId: metabaseInstance.id },
  alarmActions: [metabaseAlarmTopic.arn],
  // Do not alarm when instance is stopped (no metrics reported)
  treatMissingData: "notBreaching",
  alarmDescription: "Stop Metabase EC2 when idle for 10+ minutes",
});

## 1. Project Scaffold

- [x] 1.1 Initialise Pulumi TypeScript project and configure AWS provider
- [x] 1.2 Add Lambda build toolchain (esbuild)
- [x] 1.3 Define shared `Transaction` TypeScript interface with generic field names
- [x] 1.4 Add sample `Transaction` JSON fixture for local testing

## 2. Storage Infrastructure

- [x] 2.1 Define S3 bucket (bronze) with `errors/` prefix for Firehose failures
- [x] 2.2 Define DynamoDB table with `transactionId` as partition key, on-demand billing

## 3. Messaging Infrastructure

- [x] 3.1 Define SNS topic (standard)
- [x] 3.2 Define SQS queue and DLQ for DynamoDB subscriber
- [x] 3.3 Add SNS → SQS subscription

## 4. Webhook Publisher Lambda

- [x] 4.1 Implement Lambda handler: parse `Transaction` from event payload, publish to SNS
- [x] 4.2 Read `TOPIC_ARN` from environment variable
- [x] 4.3 Add Pulumi resource: Lambda function + IAM role with `sns:Publish`

## 5. DynamoDB Subscriber Lambda

- [x] 5.1 Implement Lambda handler: unwrap SNS envelope, parse `Transaction`, write to DynamoDB
- [x] 5.2 Read `TABLE_NAME` from environment variable
- [x] 5.3 Add Pulumi resource: Lambda function + IAM role with `dynamodb:PutItem`
- [x] 5.4 Add SQS event source mapping (batch size 10)

## 6. Pseudonymization Engine

- [x] 6.1 Implement `FIELD_RULES` parser: load JSON from env var at init, validate actions
- [x] 6.2 Implement `apply` function: iterate fields, apply partition-key / hash / drop / keep
- [x] 6.3 Implement HMAC-SHA256 hashing with hardcoded secret
- [x] 6.4 Implement `partition-key` enforcement: return `ProcessingFailed` if field absent or null
- [x] 6.5 Implement keep-by-default for fields not listed in `FIELD_RULES`

## 7. Firehose Transform Lambda

- [x] 7.1 Implement Firehose transform handler: decode base64 records, unwrap SNS envelope
- [x] 7.2 Wire pseudonymization engine into transform handler
- [x] 7.3 Return per-record `Ok` / `ProcessingFailed` results with base64-encoded output + newline
- [x] 7.4 Add Pulumi resource: Lambda function (no IAM permissions needed)

## 8. Firehose Delivery Stream

- [x] 8.1 Define Firehose delivery stream targeting bronze S3 bucket
- [x] 8.2 Configure data transformation: point to Pseudonymizer Transform Lambda
- [x] 8.3 Configure dynamic partitioning: JQ expressions for `year`/`month`/`day` from `$.occurredAt`
- [x] 8.4 Set S3 prefix: `events/year=!{partitionKeyFromQuery:year}/month=!{partitionKeyFromQuery:month}/day=!{partitionKeyFromQuery:day}/`
- [x] 8.5 Set S3 error prefix: `errors/`
- [x] 8.6 Set buffer: 60s / 5MB
- [x] 8.7 Add SNS → Firehose subscription
- [x] 8.8 Add IAM: Firehose role with `s3:PutObject` and `lambda:InvokeFunction`; SNS with `firehose:PutRecord`

## 9. End-to-End Validation

- [ ] 9.1 Deploy stack with no-op transform Lambda; invoke Webhook Lambda with sample fixture; verify records reach S3 under correct Hive prefix
- [ ] 9.2 Swap in Pseudonymizer Lambda; invoke again; verify hashed fields and dropped fields
- [ ] 9.3 Invoke with a Transaction missing `occurredAt`; verify record appears in `errors/` prefix
- [ ] 9.4 Verify raw Transaction appears in DynamoDB with all fields intact

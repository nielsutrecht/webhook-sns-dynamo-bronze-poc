## 1. Scaffolding

- [x] 1.1 Create `components/` directory
- [x] 1.2 Create `config.ts` — export `stackName` and `developerCidr`
- [x] 1.3 Create `utils.ts` — move `lambdaRole()` and `lambdaCode()` helpers from `index.ts`

## 2. Component: Storage

- [x] 2.1 Create `components/storage.ts` — `StorageComponent` extending `pulumi.ComponentResource`
- [x] 2.2 Move `bronzeBucket`, `silverBucket`, `goldBucket`, `athenaResultsBucket` into `StorageComponent`
- [x] 2.3 Expose all four buckets as public properties

## 3. Component: Ingestion

- [x] 3.1 Create `components/ingestion.ts` — `IngestionComponent`
- [x] 3.2 Move SNS topic, Firehose IAM roles (`firehoseRole`, `snsFirehoseRole`), and Firehose delivery stream into `IngestionComponent`
- [x] 3.3 Move transform Lambda (and its IAM role) into `IngestionComponent`
- [x] 3.4 Expose `topic` and `firehoseStream` as public properties

## 4. Component: DynamoDB Sink

- [x] 4.1 Create `components/dynamo-sink.ts` — `DynamoSinkComponent`
- [x] 4.2 Move DynamoDB table, DynamoDB SQS queue + DLQ, queue policy, SNS subscription, subscriber Lambda (and its IAM role), and SQS event source mapping into `DynamoSinkComponent`
- [x] 4.3 Expose `table`, `queue`, and `dlq` as public properties

## 5. Component: Analytics

- [x] 5.1 Create `components/analytics.ts` — `AnalyticsComponent`
- [x] 5.2 Move Glue database and Athena workgroup into `AnalyticsComponent`
- [x] 5.3 Move silver trigger SQS queue + DLQ, queue policy, and S3 bucket notification into `AnalyticsComponent`
- [x] 5.4 Move orchestrator Lambda (and its IAM role) and SQS event source mapping into `AnalyticsComponent`
- [x] 5.5 Expose `glueDatabase`, `athenaWorkgroup`, and `silverTriggerQueue` as public properties

## 6. Component: Metabase

- [x] 6.1 Create `components/metabase.ts` — `MetabaseComponent`
- [x] 6.2 Move Metabase EC2 IAM role and instance profile into `MetabaseComponent`
- [x] 6.3 Move security group, EC2 instance (with user data and EBS), and auto-stop Lambda role into `MetabaseComponent`
- [x] 6.4 Move auto-stop Lambda, idle alarm SNS topic, SNS subscription, Lambda permission, and CloudWatch alarm into `MetabaseComponent`
- [x] 6.5 Expose `instanceId` as a public property

## 7. Composition root

- [x] 7.1 Rewrite `index.ts` to import and instantiate all five components with correct dependency ordering
- [x] 7.2 Re-export all stack outputs (`bronzeBucketName`, `topicArn`, etc.) from the component properties

## 8. Verification

- [x] 8.1 Run `npm run typecheck` — zero errors
- [x] 8.2 Run `pulumi preview` — output reports 0 to create, 0 to update, 0 to delete

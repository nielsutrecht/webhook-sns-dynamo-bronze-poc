## Why

The EE-106 PoC established bronze storage (raw pseudonymized events in S3). Bronze is append-only and schema-free — it faithfully mirrors raw events but is not suitable for analytics. To demonstrate the full medallion architecture and validate the data pipeline as a foundation for reporting, we need silver (cleaned, deduplicated, structured) and gold (business-level aggregates) layers.

## What Changes

- Add an S3 event notification on the bronze bucket to trigger processing when Firehose delivers a new file
- Add a new SQS queue to buffer bronze S3 notifications
- Add an Orchestrator Lambda that runs Athena SQL to build silver and gold in sequence
- Add a Glue Data Catalog database to register silver and gold Iceberg tables
- Add an Athena workgroup with a dedicated query results bucket
- Add a silver S3 bucket with an Iceberg table: deduplicated pseudonymized transactions, partitioned by date
- Add a gold S3 bucket with three Iceberg aggregate tables: daily spend by account, daily volume by transaction type, daily net flow by account
- Orchestrator Lambda creates Iceberg tables on first run if they don't exist

## Capabilities

### New Capabilities

- `silver-layer`: Near-real-time bronze → silver transform. Reads the specific bronze file that triggered the event, MERGEs records into an Iceberg table on `transactionId` (deduplication). Partitioned by date. Triggered by S3 event → SQS → Lambda.
- `gold-layer`: Rebuilds three Iceberg aggregate tables from silver after each silver update. Full DELETE + INSERT per table. Aggregates: daily spend by account, daily volume by type, daily net flow by account.
- `glue-athena-catalog`: Glue database + Athena workgroup that backs silver and gold table registration. Orchestrator Lambda creates tables on first run.

### Modified Capabilities

## Impact

- New Pulumi resources: 2 S3 buckets, 1 SQS queue, 1 Lambda, 1 Glue database, 1 Athena workgroup, 1 S3 results bucket, S3 event notification on bronze bucket, IAM roles for Lambda (Athena, Glue, S3) and Athena (S3 results)
- New Lambda handler: `src/orchestrator/handler.ts`
- No changes to existing Lambda handlers, SNS/SQS/Firehose pipeline, or DynamoDB path
- Athena queries run against bronze bucket (read) and write to silver/gold buckets — IAM must be scoped accordingly

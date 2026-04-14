## Why

Flow needs a reliable, scalable foundation for ingesting webhook events from external partners into both structured storage (DynamoDB) and a raw bronze layer (S3). This PoC validates the core fan-out pattern — a single event publish fanning out to multiple independent consumers — and establishes pseudonymization as a first-class concern before data lands in the reporting layer.

## What Changes

- New webhook ingestion pipeline: Lambda → SNS → two independent subscribers
- New DynamoDB subscriber: consumes raw events via SQS, persists structured records
- New S3 bronze subscriber: consumes via Kinesis Data Firehose with an inline pseudonymization transform, writes Hive-partitioned JSON
- New pseudonymization engine: config-driven field-level rules (keep / hash / drop / partition-key) applied by the Firehose transform Lambda
- New `Transaction` event type with generic, public-friendly field names (no internal abbreviations)
- New Pulumi infrastructure stack: SNS topic, SQS queue + DLQ, Firehose delivery stream, DynamoDB table, S3 bucket, IAM roles

## Capabilities

### New Capabilities

- `webhook-publisher`: Lambda that accepts a `Transaction` payload and publishes it to SNS
- `dynamo-subscriber`: SQS-triggered Lambda that persists raw `Transaction` records to DynamoDB
- `firehose-bronze-subscriber`: Kinesis Data Firehose delivery stream that receives SNS fan-out, applies pseudonymization via a transform Lambda, and writes batched JSON to S3 with Hive partitioning
- `pseudonymization-engine`: Config-driven field transformer supporting keep / hash (HMAC-SHA256) / drop / partition-key rules via JSONPath selectors

### Modified Capabilities

## Impact

- New AWS resources: SNS topic, SQS queue + DLQ, Kinesis Data Firehose stream, Lambda (×3), DynamoDB table, S3 bucket
- New Pulumi stack (TypeScript) — no existing infrastructure affected
- No external APIs or shared systems modified — this is a self-contained PoC

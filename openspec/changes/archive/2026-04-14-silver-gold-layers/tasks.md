## 1. Infrastructure — Storage

- [x] 1.1 Add silver S3 bucket (`webhook-silver-{stack}`, `forceDestroy: true`)
- [x] 1.2 Add gold S3 bucket (`webhook-gold-{stack}`, `forceDestroy: true`)
- [x] 1.3 Add Athena query results S3 bucket (`webhook-athena-results-{stack}`, `forceDestroy: true`)

## 2. Infrastructure — Glue & Athena

- [x] 2.1 Add Glue Data Catalog database (`webhook_{stack}`)
- [x] 2.2 Add Athena workgroup with output location pointing to results bucket and per-query scan limit (e.g. 1GB)

## 3. Infrastructure — Trigger Pipeline

- [x] 3.1 Add SQS queue for S3 bronze notifications (silver-trigger queue + DLQ)
- [x] 3.2 Add S3 bucket notification on the bronze bucket: filter prefix `events/`, deliver to silver-trigger SQS
- [x] 3.3 Add SQS queue policy allowing `s3.amazonaws.com` to send messages

## 4. Infrastructure — Orchestrator Lambda

- [x] 4.1 Add IAM role for Orchestrator Lambda with permissions: `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`, `glue:GetDatabase`, `glue:GetTable`, `glue:CreateTable`, S3 read on bronze bucket, S3 read/write on silver and gold buckets, S3 read/write on results bucket
- [x] 4.2 Add Orchestrator Lambda (`src/orchestrator/handler.ts`) with env vars: `GLUE_DATABASE`, `ATHENA_WORKGROUP`, `BRONZE_BUCKET`, `SILVER_BUCKET`, `GOLD_BUCKET`, `RESULTS_BUCKET`
- [x] 4.3 Add SQS event source mapping: silver-trigger queue → Orchestrator Lambda, `batchSize: 1`, `maximumConcurrency: 1`

## 5. Orchestrator Lambda — Implementation

- [x] 5.1 Implement Athena query helper: `startQuery(sql)` → poll `GetQueryExecution` until terminal state, throw on FAILED/CANCELLED
- [x] 5.2 Implement `ensureTables()`: run `CREATE TABLE IF NOT EXISTS` DDL for silver Iceberg table and all three gold Iceberg tables via Athena
- [x] 5.3 Implement silver MERGE: extract S3 object key from SQS/S3 event, build Athena `MERGE INTO silver.transactions USING (SELECT * FROM bronze_file) ON transactionId WHEN NOT MATCHED THEN INSERT`
- [x] 5.4 Implement gold rebuild for `daily_spend_by_account`: DELETE all + INSERT SELECT grouped by `accountId`, `DATE(occurredAt)`
- [x] 5.5 Implement gold rebuild for `daily_volume_by_type`: DELETE all + INSERT SELECT grouped by `transactionType`, `DATE(occurredAt)`
- [x] 5.6 Implement gold rebuild for `daily_net_flow_by_account`: DELETE all + INSERT SELECT splitting positive/negative `amountCents` into `creditCents`/`debitCents`, computing `netCents`
- [x] 5.7 Wire `handler.ts`: call `ensureTables()` then silver MERGE then three gold rebuilds in sequence

## 6. Build

- [x] 6.1 Add `orchestrator` entry to `esbuild.mjs` build targets
- [x] 6.2 Update Pulumi Lambda code reference to point to `dist/orchestrator.js`

## 7. End-to-End Validation

- [x] 7.1 Deploy with `pulumi up` and verify all new resources are created
- [x] 7.2 Run the generator (`npm run generate -- --count 50`) and wait for Firehose to deliver (60s buffer)
- [x] 7.3 Confirm Orchestrator Lambda invoked: check CloudWatch logs for successful MERGE and gold rebuilds
- [x] 7.4 Query `silver.transactions` in Athena — verify rows present and `transactionId` is unique
- [x] 7.5 Run the generator again with overlapping data; confirm silver row count does not increase for duplicate `transactionId` values
- [x] 7.6 Query all three gold tables in Athena — verify aggregates are non-empty and sums are plausible

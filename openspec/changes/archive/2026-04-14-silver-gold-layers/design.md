## Context

EE-106 delivered a working bronze pipeline: Webhook Lambda → SNS → Firehose → S3 (pseudonymized NDJSON, Hive-partitioned by date). Bronze is append-only and schema-free.

This change adds two further layers using Athena SQL on top of the existing bronze data — silver (deduplicated, structured Iceberg) and gold (business aggregates) — triggered near-real-time when Firehose delivers each bronze file.

## Goals / Non-Goals

**Goals:**
- Demonstrate the full medallion architecture (bronze → silver → gold) in a single PoC
- Deduplicate transactions in silver using Iceberg MERGE on `transactionId`
- Produce three queryable gold aggregates via Athena
- Keep the pipeline near-real-time (latency bounded by Firehose buffer + Athena query time)
- Keep operating cost close to zero for PoC data volumes

**Non-Goals:**
- Production-grade orchestration (no Airflow, Step Functions, or dbt)
- Backfill of historical bronze data
- Schema enforcement or data quality checks beyond deduplication
- Glue Crawlers or automatic schema inference
- Streaming silver (sub-minute latency)

## Decisions

### Iceberg for both silver and gold
**Decision:** Use Apache Iceberg for both silver and gold tables.

**Rationale:** Iceberg's ACID guarantees simplify two distinct problems:
- Silver: `MERGE INTO` on `transactionId` is safe under concurrent triggers — if two bronze files land simultaneously, both Lambdas can merge without data corruption.
- Gold: `DELETE FROM` + `INSERT INTO` is atomic — gold tables are never in a partially-rebuilt state, so Athena queries during a rebuild return consistent results.

**Alternative considered:** Plain Parquet for gold (rebuilt via DROP + CTAS). Rejected because Athena has no native `INSERT OVERWRITE`, and DROP + CTAS creates a brief window where the table doesn't exist.

### Athena as the compute engine
**Decision:** Athena SQL for all bronze → silver → gold transforms.

**Rationale:** $5/TB scanned, zero infrastructure, no cluster startup time. For PoC data volumes the cost is effectively $0. All transforms are straightforward SQL (MERGE, GROUP BY) — no Spark or Python needed.

**Alternative considered:** AWS Glue Jobs (Spark). Rejected: $0.44/DPU-hour minimum, 2-minute startup, overkill for simple SQL transforms at this scale.

### Incremental bronze read for silver
**Decision:** Each Orchestrator Lambda invocation reads only the specific bronze file that triggered the S3 event, not all of bronze.

**Rationale:** Keeps Athena cost and query time proportional to new data rather than total history. The S3 event notification carries the exact object key.

**Alternative considered:** Full bronze scan on each trigger. Rejected: cost and latency grow linearly with bronze history.

### S3 notification → SQS → Lambda (not direct Lambda trigger)
**Decision:** Route S3 events through SQS before invoking the Orchestrator Lambda.

**Rationale:** SQS provides buffering if multiple bronze files land faster than Lambda can process them, and deduplication if the same S3 event is delivered twice (S3 notifications are at-least-once). Without SQS, concurrent Lambda invocations could race on gold rebuilds.

**Note:** Iceberg ACID handles concurrent silver MERGEs safely, but sequential gold rebuilds are cleaner — SQS with `maxConcurrency: 1` on the event source mapping enforces this.

### Lambda creates Iceberg tables on first run
**Decision:** The Orchestrator Lambda issues `CREATE TABLE IF NOT EXISTS` (Iceberg DDL via Athena) before processing each batch.

**Rationale:** Self-contained for a PoC — no manual setup step, no Pulumi custom resources. Idempotent: subsequent runs skip creation.

**Production path:** Pulumi owns infrastructure (buckets, IAM, Glue database, workgroup); dbt (`dbt-athena-community`) owns table definitions, transform SQL, and schema tests.

### Separate S3 buckets for silver and gold
**Decision:** Three buckets: `webhook-bronze-{stack}`, `webhook-silver-{stack}`, `webhook-gold-{stack}`.

**Rationale:** Clean IAM boundaries per layer. Independent lifecycle policies. Easier to reason about access patterns in a future multi-team setup.

## Risks / Trade-offs

**Athena DDL on first Lambda invocation adds latency** → Mitigation: `CREATE TABLE IF NOT EXISTS` is fast (< 1s) and only incurs overhead once per deploy.

**Gold rebuild time grows with silver table size** → Mitigation: acceptable for PoC volumes. Production would use incremental gold (e.g., partition-level overwrite by day).

**SQS maxConcurrency: 1 means silver/gold processing is sequential** → Mitigation: this is intentional for PoC correctness. Production with higher volume would partition work by date range and run concurrent gold rebuilds per partition.

**Athena query result bucket accumulates query history** → Mitigation: set S3 lifecycle rule to expire results after 7 days.

## Migration Plan

1. `pulumi up` — provisions all new resources (buckets, SQS, Lambda, Glue DB, Athena workgroup)
2. First bronze file landing triggers Orchestrator Lambda, which creates Iceberg tables and runs first MERGE + gold rebuild
3. No changes to existing pipeline — bronze, DynamoDB path, and Firehose are untouched
4. Validate via Athena console: query `silver.transactions`, `gold.daily_spend_by_account`, etc.

Rollback: `pulumi destroy` tears down all new resources. Bronze bucket and DynamoDB table are unaffected (both have `forceDestroy: true` only for teardown convenience).

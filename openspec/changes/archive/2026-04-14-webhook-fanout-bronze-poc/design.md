## Context

Flow needs a proven fan-out ingestion pattern for webhook events. This PoC establishes the pattern with two consumers: DynamoDB for structured raw storage and S3 for a pseudonymized bronze layer. The PoC is self-contained — new AWS resources, no changes to existing systems.

The most unfamiliar component is Kinesis Data Firehose, specifically its data transformation feature and dynamic partitioning. Validating this end-to-end is the primary learning objective.

## Goals / Non-Goals

**Goals:**
- Validate SNS fan-out to SQS and Firehose as independent subscribers
- Validate Firehose data transformation Lambda (pseudonymization inline)
- Validate Firehose dynamic partitioning from event payload fields
- Establish a config-driven pseudonymization engine reusable by future pipelines
- Define a clean, generic `Transaction` event schema suitable for a public repo

**Non-Goals:**
- Production hardening (autoscaling, alerting, cost optimisation)
- HTTP ingress (API Gateway) — not what this PoC is validating
- Silver layer transformation (Parquet/Iceberg) — deferred to future work
- Schema registry or schema enforcement at the SNS layer

## Decisions

### SNS over SQS as the fan-out primitive
Publishing directly to SQS would require the Webhook Lambda to know about every consumer and publish to each queue independently — coupling the publisher to subscriber count. SNS decouples this: one publish fans out to all subscribers, and adding a new consumer requires no changes to the publisher.

*Alternative considered*: EventBridge — richer routing and schema registry, but adds ~0.5s latency and operational overhead not warranted for simple fan-out. SNS is the right primitive here and EventBridge is the natural upgrade path if content-based routing is needed later.

### SQS buffer for DynamoDB path, Firehose for S3 path
SNS can invoke Lambda directly, but direct invocation has no DLQ and relies on SNS's own retry policy (3 retries, then message is lost). SQS provides durable buffering, configurable visibility timeout, and an independent DLQ per subscriber.

For the S3 path, Firehose replaces SQS+Lambda with a managed service that buffers records, batches writes (better S3 efficiency), handles retries to S3 natively, and supports inline transformation. The tradeoff is different error semantics: failed records go to an S3 error prefix rather than a DLQ.

### Firehose transformation Lambda for pseudonymization
The pseudonymization step could live in a standalone Lambda triggered by SQS before writing to S3 (Option A), or inline in the Firehose transform (Option B). Option B was chosen because:
- It removes the SQS queue and standalone Lambda for the S3 path, reducing component count
- Firehose's transform is the correct integration point — it's purpose-built for record transformation before delivery
- The transform Lambda has no AWS permissions (it only transforms data), which is a clean security posture

The tradeoff: the Firehose transform programming model (batched records, base64 encoding, per-record result codes) is more involved than a standard Lambda handler.

### Bronze layer as JSON, not Parquet
The bronze layer must faithfully mirror raw events as they evolve. Parquet requires a Glue Data Catalog schema, which introduces schema-change friction. JSON is schema-free and always consistent with whatever the producer sent. Parquet/Iceberg is deferred to silver layer jobs that explicitly own schema evolution.

### Config-driven pseudonymization with keep-by-default
Field rules are expressed as a JSON map of JSONPath selector → action (`partition-key` / `hash` / `drop` / `keep`), loaded from the `FIELD_RULES` environment variable. Keep-by-default means the config is a PII blocklist rather than an allowlist — shorter config, and consistent with the existing `AnonymizedTransaction` pattern in `flow-data`.

The `partition-key` action is a first-class addition: it marks a field as required for Firehose dynamic partitioning, keeping it in the output and explicitly failing the record (rather than silently routing to the error prefix) if the field is absent.

### Incremental Firehose validation
Firehose's 60-second minimum buffer means each observation cycle costs real time. The end-to-end validation is sequenced: no-op transform first (validates partitioning), then pseudonymization, then `partition-key` enforcement. This isolates failure modes and avoids debugging multiple new behaviours simultaneously.

## Risks / Trade-offs

**Firehose 60s minimum buffer** → Slow iteration cycle during development. Mitigation: incremental validation sequence; test transform logic with unit tests before deploying.

**SNS envelope double-unwrap** → Both the DynamoDB Lambda and the Firehose Transform Lambda must unwrap the SNS notification envelope before parsing the `Transaction`. If SNS changes its envelope format, both need updating. Mitigation: acceptable for a PoC; extract to shared helper if this pattern is promoted to production.

**Dynamic partitioning JQ expression** → If the JQ expression is misconfigured in Pulumi, Firehose silently routes all records to the error prefix. Mitigation: validate partitioning with a no-op transform before layering in pseudonymization.

**Keep-by-default PII risk** → A new field added to `Transaction` will silently pass through to S3 unless `FIELD_RULES` is updated. Mitigation: acceptable for a PoC; a production deployment would add a test asserting full field coverage in the config.

**Hardcoded HMAC secret** → Not suitable for production. Mitigation: documented as PoC-only; production would source the secret from AWS Secrets Manager.

## Migration Plan

No migration required — this is a net-new deployment against a dedicated AWS environment. Teardown is `pulumi destroy`.

## Open Questions

None — all design decisions are resolved for the PoC scope.

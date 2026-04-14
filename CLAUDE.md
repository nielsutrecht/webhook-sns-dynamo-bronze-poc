# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Proof of concept to assess the feasibility of a webhook-triggered event fan-out pipeline as a foundation for event-driven data ingestion at Flow. Two outcomes are assessed: raw event persistence to DynamoDB, and pseudonymized event delivery to S3 bronze storage via Kinesis Data Firehose.

## Architecture

```
Webhook Lambda (direct invocation)
  → SNS Topic
    → SQS → DynamoDB Lambda              → DynamoDB  (raw)
    → Firehose
        → Transform Lambda (pseudonymize)
        → S3                              (bronze, JSON, Hive-partitioned)
```

### Components

- **Webhook Lambda**: accepts a `Transaction` payload directly (no HTTP), publishes raw JSON to SNS
- **SNS Topic**: fan-out hub; one SQS subscription (DynamoDB path) and one Firehose subscription (S3 path)
- **DynamoDB Lambda**: consumes from SQS, unwraps SNS envelope, persists raw `Transaction` to DynamoDB; SQS provides durable retry, backpressure, and DLQ
- **Firehose**: buffers records and delivers to S3; Transform Lambda applies pseudonymization inline before delivery; dynamic partitioning derives Hive prefix from `occurredAt`
- **Transform Lambda**: invoked by Firehose with a batch of records; unwraps SNS envelope, applies `FIELD_RULES`, returns transformed records to Firehose

### Error handling

- **DynamoDB path**: SQS DLQ for individual-record replay
- **S3 path**: Firehose delivers failed/unprocessable records to a dedicated S3 error prefix (batch-level recovery)

## Event schema

Defined in this repo with generic, public-friendly field names:

```typescript
interface Transaction {
  transactionId: string;
  accountId: string;
  customerId: string | null;
  occurredAt: string;
  settledAt: string | null;
  amountCents: number;
  currency: string;
  balanceAfterCents: number | null;
  balanceCurrency: string;
  description: string;
  transactionType: "TRANSFER" | "CASH" | "CREDITCARD" | "DEBITCARD" | "FEES" | "INTEREST" | "PAYMENT";
  status: "settled" | "pending" | "booked" | "captured" | "authorised" | "received";
  accountBic: string;
  counterpartyName: string;
  counterpartyIban: string;
  counterpartyBic: string;
  bankReference: string | null;
  eventId: string;
  isInternal: boolean;
}
```

Key fields for infrastructure:
- `transactionId` — UUID, used as S3 object name
- `occurredAt` — ISO timestamp, used for Firehose dynamic partitioning (`year`/`month`/`day`)

## Pseudonymization config

Configured via `FIELD_RULES` env var on the Transform Lambda (JSON, JSONPath selectors):

```json
{
  "$.occurredAt":       "partition-key",
  "$.accountId":        "hash",
  "$.customerId":       "hash",
  "$.counterpartyIban": "hash",
  "$.description":      "drop",
  "$.counterpartyName": "drop",
  "$.bankReference":    "drop"
}
```

Actions:
- `partition-key` — keep the field; return `ProcessingFailed` for the record if absent or null (makes Firehose partitioning dependencies explicit and enforced at runtime)
- `keep` — pass through unchanged
- `hash` — replace value with HMAC-SHA256 (pseudonymization, not anonymization — same input always produces the same hash, enabling cross-event correlation)
- `drop` — remove field from output

Default policy for fields not listed: **keep**. The config is an explicit blocklist of PII fields.

HMAC secret is hardcoded for this PoC.

## Technology choices

- **Infrastructure**: Pulumi (TypeScript)
- **Lambda runtime**: TypeScript (Node.js)
- **Fan-out**: SNS (right primitive for one-to-many; publisher stays decoupled from subscriber count)
- **DynamoDB path buffering**: SQS (durable retry, DLQ, backpressure)
- **S3 path buffering + delivery**: Kinesis Data Firehose (managed batching, dynamic partitioning, inline transform)
- **Raw storage**: DynamoDB
- **Bronze storage**: S3, JSON — schema stays flexible to mirror raw events as they evolve; Parquet/Iceberg deferred to silver layer jobs
- **Pseudonymization**: HMAC-SHA256 with hardcoded secret (PoC); field selection via JSONPath

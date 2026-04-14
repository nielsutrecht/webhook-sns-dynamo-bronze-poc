## ADDED Requirements

### Requirement: Bronze files trigger silver processing
The system SHALL publish an S3 event notification for every object created under the `events/` prefix of the bronze bucket. Notifications SHALL be delivered to a dedicated SQS queue. The Orchestrator Lambda SHALL be configured with that SQS queue as its event source, with `maxConcurrency: 1` to ensure sequential processing.

#### Scenario: New bronze file triggers orchestrator
- **WHEN** Firehose delivers a new NDJSON file to `s3://webhook-bronze-{stack}/events/...`
- **THEN** an S3 event notification is published to the silver SQS queue within seconds
- **AND** the Orchestrator Lambda is invoked with the S3 object key of the new file

### Requirement: Silver table stores deduplicated pseudonymized transactions
The system SHALL maintain a silver Iceberg table (`silver.transactions`) in the Glue Data Catalog. The table SHALL be partitioned by `year`, `month`, and `day` derived from `occurredAt`. The table SHALL contain one row per unique `transactionId` — duplicate `transactionId` values from repeated bronze writes SHALL be silently absorbed.

#### Scenario: New records are merged into silver
- **WHEN** the Orchestrator Lambda processes a bronze file containing N records
- **THEN** each record is parsed from NDJSON and MERGEd into `silver.transactions` on `transactionId`
- **AND** records with a `transactionId` not yet in silver are inserted
- **AND** records with a `transactionId` already in silver are ignored

#### Scenario: Duplicate transactionId is silently absorbed
- **WHEN** the same `transactionId` appears in two different bronze files (e.g., from repeated generator runs)
- **THEN** the second occurrence is silently skipped — no error, no duplicate row in silver

### Requirement: Silver MERGE reads only the triggering bronze file
The Athena MERGE query used to populate silver SHALL read only the specific S3 object that triggered the invocation, not all of bronze.

#### Scenario: Incremental merge from single file
- **WHEN** a bronze file at `s3://webhook-bronze-{stack}/events/year=2024/month=03/day=15/file.json` triggers the Lambda
- **THEN** the Athena MERGE query reads only that file path as its source
- **AND** bronze files from other dates or previous deliveries are not scanned

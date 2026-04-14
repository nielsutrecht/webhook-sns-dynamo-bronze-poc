## ADDED Requirements

### Requirement: SNS delivers directly to Firehose
The SNS topic SHALL have a Firehose subscription that delivers notifications directly to the delivery stream, with no intermediate SQS queue.

#### Scenario: SNS fan-out to Firehose
- **WHEN** the Webhook Lambda publishes a Transaction to SNS
- **THEN** SNS delivers the notification envelope to the Firehose delivery stream

### Requirement: Firehose invokes Transform Lambda per batch
The Firehose delivery stream SHALL invoke the Pseudonymizer Transform Lambda for each buffered batch of records before writing to S3.

#### Scenario: Batch transformation invoked
- **WHEN** Firehose buffers a batch of records
- **THEN** it invokes the Transform Lambda with the batch and waits for the transformed records before delivery

### Requirement: S3 prefix uses Hive partitioning
Delivered objects SHALL use a Hive-partitioned S3 prefix derived from the `occurredAt` field of the Transaction.

#### Scenario: Record partitioned by event date
- **WHEN** a Transaction with `occurredAt: "2024-03-15T10:00:00Z"` is delivered to S3
- **THEN** the object is written under the prefix `events/year=2024/month=03/day=15/`

### Requirement: Failed records routed to error prefix
Records that cannot be transformed or delivered SHALL be written to a dedicated S3 error prefix.

#### Scenario: Transform Lambda returns ProcessingFailed
- **WHEN** the Transform Lambda returns `ProcessingFailed` for a record
- **THEN** Firehose writes that record to the `errors/` S3 prefix

#### Scenario: Delivery failure after retries
- **WHEN** Firehose cannot deliver a record to S3 after exhausting retries
- **THEN** the record is written to the `errors/` S3 prefix

### Requirement: Buffer at PoC defaults
The Firehose delivery stream SHALL use a buffer of 60 seconds or 5MB, whichever is reached first.

#### Scenario: Time-based flush
- **WHEN** 60 seconds have elapsed since the last flush
- **THEN** Firehose flushes buffered records to S3 regardless of batch size

### Requirement: S3 bucket and prefix configured on delivery stream
The S3 bucket and prefix SHALL be set on the Firehose delivery stream at infrastructure provisioning time, not in application code.

#### Scenario: Delivery stream targets correct bucket
- **WHEN** Firehose delivers records
- **THEN** objects are written to the designated bronze S3 bucket

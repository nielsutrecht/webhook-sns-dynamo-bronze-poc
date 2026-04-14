## ADDED Requirements

### Requirement: Consume from SQS
The Lambda SHALL be triggered by an SQS event source with a batch size of 10.

#### Scenario: Batch of records received
- **WHEN** SQS delivers a batch of one or more messages
- **THEN** the Lambda processes each message in the batch

### Requirement: Unwrap SNS envelope
The Lambda SHALL unwrap the SNS notification envelope before parsing the Transaction.

#### Scenario: SNS-wrapped message parsed
- **WHEN** an SQS message body contains an SNS notification envelope
- **THEN** the Lambda extracts the `Message` field and parses it as a `Transaction`

### Requirement: Persist raw Transaction to DynamoDB
The Lambda SHALL write the raw `Transaction` record to DynamoDB using `transactionId` as the partition key.

#### Scenario: Record written successfully
- **WHEN** a valid Transaction is parsed from the SQS message
- **THEN** the full Transaction object is written to DynamoDB with `transactionId` as the key

### Requirement: Propagate failures to SQS
The Lambda SHALL not catch errors from DynamoDB write failures, allowing SQS to retry the message.

#### Scenario: DynamoDB write fails
- **WHEN** the DynamoDB `PutItem` call throws an error
- **THEN** the Lambda propagates the error, the message remains on the queue, and SQS retries

### Requirement: Dead-letter after max retries
Messages that repeatedly fail SHALL be routed to the DLQ after the configured maximum receive count.

#### Scenario: Message exceeds retry limit
- **WHEN** a message has been received and failed more times than the configured max receive count
- **THEN** SQS moves the message to the dead-letter queue

### Requirement: DynamoDB table configured via environment
The DynamoDB table name SHALL be read from the `TABLE_NAME` environment variable.

#### Scenario: Table name resolved at startup
- **WHEN** the Lambda initialises
- **THEN** it reads `TABLE_NAME` from the environment and uses it for all DynamoDB calls

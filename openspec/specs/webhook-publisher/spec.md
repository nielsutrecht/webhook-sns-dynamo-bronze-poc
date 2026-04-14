## ADDED Requirements

### Requirement: Accept Transaction payload
The Lambda SHALL accept a `Transaction` object as its invocation payload.

#### Scenario: Valid Transaction published
- **WHEN** the Lambda is invoked with a valid `Transaction` JSON payload
- **THEN** the raw Transaction JSON is published to the SNS topic as the message body

#### Scenario: Invocation returns success
- **WHEN** the SNS publish completes without error
- **THEN** the Lambda returns successfully

### Requirement: Reject invalid payload
The Lambda SHALL return an error if the invocation payload cannot be parsed as a `Transaction`.

#### Scenario: Invalid JSON payload
- **WHEN** the Lambda is invoked with a payload that is not valid JSON
- **THEN** the Lambda returns an error and does not publish to SNS

### Requirement: SNS topic configured via environment
The SNS topic ARN SHALL be read from the `TOPIC_ARN` environment variable.

#### Scenario: Topic ARN resolved at startup
- **WHEN** the Lambda initialises
- **THEN** it reads `TOPIC_ARN` from the environment and uses it for all SNS publish calls

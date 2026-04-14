## ADDED Requirements

### Requirement: Load field rules from environment variable
The Transform Lambda SHALL read the `FIELD_RULES` environment variable at initialisation and parse it as a JSON map of JSONPath selector → action.

#### Scenario: Rules loaded at cold start
- **WHEN** the Lambda initialises
- **THEN** it parses `FIELD_RULES` from the environment once and reuses it for all invocations in the lifecycle

#### Scenario: Invalid FIELD_RULES fails fast
- **WHEN** `FIELD_RULES` is not valid JSON
- **THEN** the Lambda throws at initialisation, causing all records in the batch to be retried by Firehose

### Requirement: Apply keep action
Fields with action `keep` SHALL be passed through to the output unchanged.

#### Scenario: Keep field preserved
- **WHEN** a field matches a `keep` rule
- **THEN** the field and its value appear unchanged in the transformed output

### Requirement: Apply hash action
Fields with action `hash` SHALL have their value replaced with an HMAC-SHA256 hex digest of the original value.

#### Scenario: String field hashed
- **WHEN** a field matches a `hash` rule and its value is a non-null string
- **THEN** the field is present in the output with its value replaced by the HMAC-SHA256 hex digest

#### Scenario: Hash is deterministic
- **WHEN** the same field value is hashed twice with the same secret
- **THEN** both hashes are identical, enabling cross-event correlation

#### Scenario: Null field with hash rule
- **WHEN** a field matching a `hash` rule has a null value
- **THEN** the field is removed from the output

### Requirement: Apply drop action
Fields with action `drop` SHALL be removed from the output entirely.

#### Scenario: Dropped field absent from output
- **WHEN** a field matches a `drop` rule
- **THEN** the field does not appear in the transformed output

### Requirement: Apply partition-key action
Fields with action `partition-key` SHALL be kept in the output. If the field is absent or null, the record SHALL be returned as `ProcessingFailed`.

#### Scenario: Partition key field preserved
- **WHEN** a field matches a `partition-key` rule and is present with a non-null value
- **THEN** the field and its value appear unchanged in the transformed output

#### Scenario: Missing partition key fails record
- **WHEN** a field matching a `partition-key` rule is absent from the Transaction
- **THEN** the record is returned to Firehose with result `ProcessingFailed`

#### Scenario: Null partition key fails record
- **WHEN** a field matching a `partition-key` rule has a null value
- **THEN** the record is returned to Firehose with result `ProcessingFailed`

### Requirement: Keep-by-default for unlisted fields
Fields not matched by any rule in `FIELD_RULES` SHALL be passed through to the output unchanged.

#### Scenario: Unlisted field preserved
- **WHEN** a Transaction field has no matching rule in `FIELD_RULES`
- **THEN** the field and its value appear unchanged in the transformed output

### Requirement: Unwrap SNS envelope before applying rules
The Transform Lambda SHALL unwrap the SNS notification envelope before applying field rules to the Transaction.

#### Scenario: SNS envelope unwrapped
- **WHEN** Firehose delivers a record whose base64-decoded data is an SNS notification envelope
- **THEN** the Lambda extracts the `Message` field, parses it as a Transaction, and applies `FIELD_RULES` to the Transaction — not the envelope

### Requirement: Return transformed records to Firehose
The Transform Lambda SHALL return every input record in the response with a matching `recordId` and a `result` of `Ok` or `ProcessingFailed`.

#### Scenario: Successful record returned
- **WHEN** a record is transformed successfully
- **THEN** it is returned with `result: "Ok"` and `data` set to the base64-encoded transformed Transaction followed by a newline

#### Scenario: Failed record returned
- **WHEN** a record cannot be processed (e.g. missing partition key, parse error)
- **THEN** it is returned with `result: "ProcessingFailed"` and Firehose routes it to the error prefix

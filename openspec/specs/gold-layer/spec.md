### Requirement: Gold layer is rebuilt after each silver update
After each successful silver MERGE, the Orchestrator Lambda SHALL rebuild all three gold Iceberg tables from the full silver dataset. Each gold table rebuild SHALL be a full DELETE + INSERT (not incremental). Gold tables SHALL always be queryable — no table shall be in a partially-rebuilt state.

#### Scenario: Gold rebuilt after silver merge
- **WHEN** the silver MERGE completes successfully
- **THEN** the Orchestrator Lambda runs three Athena queries in sequence, one per gold table
- **AND** each query deletes all existing rows and inserts fresh aggregates from silver
- **AND** each gold table is consistent and queryable throughout (Iceberg ACID)

#### Scenario: Gold rebuild failure does not affect silver
- **WHEN** a gold rebuild Athena query fails
- **THEN** the silver table is unaffected and retains its current state
- **AND** the Lambda returns a failure to SQS, which will redeliver for retry

### Requirement: Daily spend by account aggregate
The system SHALL maintain a gold Iceberg table (`gold.daily_spend_by_account`) with one row per `accountId` × calendar day. Each row SHALL contain: `accountId` (hashed), `day` (DATE), `totalCents` (BIGINT, sum of `amountCents`), `txCount` (BIGINT, count of transactions).

#### Scenario: Aggregate reflects all silver transactions for a given account and day
- **WHEN** silver contains 5 transactions for `accountId` = "abc123" on 2024-03-15
- **THEN** `gold.daily_spend_by_account` contains one row: `accountId`="abc123", `day`=2024-03-15, `totalCents`=sum of those 5 amounts, `txCount`=5

### Requirement: Daily volume by transaction type aggregate
The system SHALL maintain a gold Iceberg table (`gold.daily_volume_by_type`) with one row per `transactionType` × calendar day. Each row SHALL contain: `transactionType` (STRING), `day` (DATE), `txCount` (BIGINT), `totalCents` (BIGINT).

#### Scenario: Aggregate groups by type and day
- **WHEN** silver contains 10 PAYMENT transactions and 3 TRANSFER transactions on 2024-03-15
- **THEN** `gold.daily_volume_by_type` contains two rows for that day: one for PAYMENT (count=10) and one for TRANSFER (count=3)

### Requirement: Daily net flow by account aggregate
The system SHALL maintain a gold Iceberg table (`gold.daily_net_flow_by_account`) with one row per `accountId` × calendar day. Each row SHALL contain: `accountId` (STRING), `day` (DATE), `creditCents` (BIGINT, sum of positive `amountCents`), `debitCents` (BIGINT, sum of absolute value of negative `amountCents`), `netCents` (BIGINT, `creditCents` - `debitCents`).

#### Scenario: Credits and debits are split correctly
- **WHEN** silver contains a salary credit of 300000 cents and a rent debit of -120000 cents for an account on the same day
- **THEN** the row for that account and day has `creditCents`=300000, `debitCents`=120000, `netCents`=180000

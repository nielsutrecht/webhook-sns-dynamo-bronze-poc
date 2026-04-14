## ADDED Requirements

### Requirement: Glue database hosts silver and gold tables
The system SHALL provision a Glue Data Catalog database (e.g., `webhook_{stack}`) to register silver and gold Iceberg tables. All Athena queries for silver and gold SHALL reference this database.

#### Scenario: Tables are discoverable via Athena
- **WHEN** the Glue database exists and Iceberg tables have been created
- **THEN** an Athena query `SHOW TABLES IN webhook_dev` lists `transactions`, `daily_spend_by_account`, `daily_volume_by_type`, and `daily_net_flow_by_account`

### Requirement: Athena workgroup scopes query execution
The system SHALL provision a dedicated Athena workgroup for this pipeline. The workgroup SHALL write query results to a dedicated S3 bucket (query results bucket). The workgroup SHALL enforce a per-query data scanned limit to prevent runaway queries.

#### Scenario: Query results are written to the results bucket
- **WHEN** an Athena query completes (success or failure)
- **THEN** the result is written to `s3://webhook-athena-results-{stack}/`
- **AND** no other S3 location is used for query output

### Requirement: Iceberg tables are created on first Lambda invocation
The Orchestrator Lambda SHALL issue `CREATE TABLE IF NOT EXISTS` DDL for each Iceberg table (silver and all three gold tables) via Athena before processing any records. Table creation SHALL be idempotent — subsequent invocations SHALL skip creation silently if tables already exist.

#### Scenario: First invocation creates tables and processes records
- **WHEN** the Orchestrator Lambda is invoked for the first time after deployment
- **THEN** it creates all four Iceberg tables via Athena DDL
- **AND** proceeds to run the silver MERGE and gold rebuilds without manual intervention

#### Scenario: Subsequent invocations skip table creation
- **WHEN** the Orchestrator Lambda is invoked after tables already exist
- **THEN** the `CREATE TABLE IF NOT EXISTS` statements succeed immediately without modifying the tables
- **AND** the Lambda proceeds directly to MERGE and rebuild queries

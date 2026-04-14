## ADDED Requirements

### Requirement: Metabase runs on EC2 with persistent EBS storage
The system SHALL provision an EC2 t3.small instance running Metabase (JAR) with an 8 GB gp3 EBS volume attached at `/metabase-data`. Metabase SHALL use H2 as its backend database, stored on the EBS volume, so that dashboards and connections survive instance stop/start cycles.

#### Scenario: Metabase survives a stop/start cycle
- **WHEN** the EC2 instance is stopped and then started again
- **THEN** Metabase restarts and retains all previously configured connections and dashboards

### Requirement: Metabase authenticates to Athena via IAM instance profile
The system SHALL attach an IAM instance profile to the EC2 instance granting read access to Athena and the relevant S3 buckets (silver, gold, Athena results). The Metabase Athena database connection SHALL leave `access_key` and `secret_key` empty so that the AWS Default Credentials Provider Chain uses the instance profile.

#### Scenario: Metabase can query gold tables without static keys
- **WHEN** the Metabase Athena connection is configured with empty access_key and secret_key
- **THEN** Athena queries against the gold Iceberg tables succeed using the EC2 instance profile credentials

### Requirement: EC2 instance auto-stops after sustained idle period
The system SHALL provision a CloudWatch alarm that monitors `CPUUtilization`. When CPU remains below 5% for two consecutive 5-minute periods, the alarm SHALL trigger an SNS topic that invokes a Lambda function, which calls `ec2:StopInstances` on the Metabase instance.

#### Scenario: Idle instance stops automatically
- **WHEN** the Metabase EC2 instance CPU stays below 5% for 10 consecutive minutes
- **THEN** the CloudWatch alarm transitions to ALARM state
- **AND** the stop Lambda is invoked and calls ec2:StopInstances
- **AND** the instance transitions to stopped state

### Requirement: One-command start with readiness polling
The system SHALL provide a `scripts/metabase-start.sh` script (invocable via `npm run metabase:start`) that: starts the stopped EC2 instance, polls until a public IP is assigned, polls `GET http://<ip>:3000/api/health` until `{"status":"ok"}`, and prints the Metabase URL.

#### Scenario: Start script waits for Metabase to be ready
- **WHEN** the user runs `npm run metabase:start`
- **THEN** the script starts the instance, waits for it to be reachable, and prints the URL only after the health check returns ok

### Requirement: Idempotent dashboard provisioning via setup script
The system SHALL provide a Python setup script (`metabase/setup/__main__.py`) invocable via `npm run metabase:setup` that provisions the Athena database connection and three gold-layer Metabase questions (one per gold table) plus one summary dashboard. The script SHALL be idempotent: running it multiple times SHALL NOT create duplicate connections, questions, or dashboards.

#### Scenario: Setup creates connection and dashboards on first run
- **WHEN** `npm run metabase:setup` is run against a fresh Metabase instance
- **THEN** an Athena database connection is created pointing to the PoC workgroup
- **AND** three questions (daily_spend_by_account, daily_volume_by_type, daily_net_flow_by_account) are created
- **AND** one dashboard containing all three questions is created

#### Scenario: Setup is idempotent on subsequent runs
- **WHEN** `npm run metabase:setup` is run a second time
- **THEN** no duplicate connections, questions, or dashboards are created

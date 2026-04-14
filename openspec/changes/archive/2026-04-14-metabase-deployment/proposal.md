## Why

The PoC now has a complete bronze → silver → gold pipeline with three Athena-queryable aggregate tables, but there is no easy way to visualise the results. Adding Metabase closes the loop: it turns the gold layer into a shareable, interactive dashboard without requiring familiarity with Athena SQL.

## What Changes

- Pulumi provisions an EC2 t3.small instance with an EBS volume running Metabase (JAR, H2 backend)
- An IAM instance profile grants the instance Athena + S3 read access — no explicit AWS keys are needed
- A CloudWatch alarm auto-stops the instance when CPU stays below 5 % for two consecutive 15-minute periods (~30 min idle)
- A `scripts/metabase-start.sh` script (and `npm run metabase:start`) starts the stopped instance, polls until healthy, and prints the public URL
- A Python setup script (adapted from mydata) provisions the Athena connection and three gold-layer dashboards idempotently via the Metabase REST API
- Metabase's own login page serves as authentication — no additional auth layer required for the PoC
- The dynamic public IP behaviour (new IP on each start) is the default; Elastic IP is documented as an alternative

## Capabilities

### New Capabilities
- `metabase-deployment`: EC2-hosted Metabase instance with IAM instance profile, auto-stop alarm, start script, and idempotent dashboard provisioning against gold Iceberg tables

### Modified Capabilities

## Impact

- `index.ts`: new EC2, IAM, CloudWatch, Lambda (auto-stop) resources
- New files: `scripts/metabase-start.sh`, `src/metabase-stop/handler.ts`, `metabase/setup/__main__.py` (adapted), `metabase/dashboards/gold-overview.yaml`
- `package.json`: new `metabase:start` and `metabase:setup` scripts
- AWS cost: ~$0.02/hr when running (t3.small); $0 when stopped (EBS ~$0.80/month)

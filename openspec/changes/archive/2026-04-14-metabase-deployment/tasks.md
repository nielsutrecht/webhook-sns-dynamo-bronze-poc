## 1. IAM & Networking

- [x] 1.1 Add IAM role and instance profile for EC2 with Athena query + S3 read permissions (silver, gold, results buckets)
- [x] 1.2 Add IAM role for the auto-stop Lambda with ec2:StopInstances permission
- [x] 1.3 Add EC2 security group allowing ingress on port 3000 (restrict to developer CIDR via Pulumi config) and all egress

## 2. EC2 & EBS

- [x] 2.1 Add 8 GB gp3 EBS volume resource
- [x] 2.2 Add EC2 t3.small instance with Amazon Linux 2023 AMI, attach IAM instance profile, attach EBS volume at /dev/sdf
- [x] 2.3 Write EC2 user-data script: format + mount EBS at /metabase-data on first boot, install Java, download Metabase JAR, write systemd unit file, enable and start metabase.service
- [x] 2.4 Export the instance ID and a note about dynamic public IP as Pulumi stack outputs; document Elastic IP alternative in a comment in index.ts

## 3. Auto-stop (CloudWatch + Lambda)

- [x] 3.1 Add `src/metabase-stop/handler.ts`: minimal Lambda that calls ec2:StopInstances on the instance ID from env var
- [x] 3.2 Register metabase-stop handler in esbuild.mjs
- [x] 3.3 Provision the metabase-stop Lambda in index.ts with the instance ID env var and the auto-stop IAM role
- [x] 3.4 Add SNS topic for the alarm action
- [x] 3.5 Add SNS subscription wiring the topic to the stop Lambda
- [x] 3.6 Add CloudWatch alarm: CPUUtilization < 5 for 2 × 5-minute periods on the EC2 instance, alarm action = SNS topic

## 4. Start Script

- [x] 4.1 Write `scripts/metabase-start.sh`: start instance via AWS CLI, poll describe-instances for public IP, poll /api/health until ok, print URL
- [x] 4.2 Make script executable (chmod +x)
- [x] 4.3 Add `"metabase:start": "bash scripts/metabase-start.sh"` to package.json scripts
- [x] 4.4 Read METABASE_INSTANCE_ID from env or fall back to `pulumi stack output metabaseInstanceId`

## 5. Setup Script

- [x] 5.1 Create `metabase/setup/` directory with `__main__.py` adapted from mydata: empty access_key/secret_key, PoC workgroup name and results bucket, PoC Glue database
- [x] 5.2 Write three SQL question definitions (one per gold table) inline or as separate .sql files
- [x] 5.3 Write `metabase/dashboards/gold-overview.yaml` defining the dashboard layout with all three questions
- [x] 5.4 Add `requirements.txt` with requests and pyyaml
- [x] 5.5 Add `"metabase:setup": "python -m metabase.setup"` to package.json scripts (or equivalent run path)

## 6. README Update

- [x] 6.1 Add Metabase to the architecture diagram (Mermaid) as a BI layer reading from gold
- [x] 6.2 Add Metabase row to the components table
- [x] 6.3 Add a "Metabase" section under Usage: start, setup, auto-stop, Elastic IP note

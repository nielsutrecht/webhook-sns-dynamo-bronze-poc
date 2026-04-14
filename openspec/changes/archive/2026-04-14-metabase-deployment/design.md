## Context

The PoC already has a working bronze → silver → gold pipeline. The gold layer consists of three Iceberg tables queryable via Athena. The missing piece is a BI layer that makes the data accessible without writing SQL. Metabase is the chosen tool (already used in the mydata reference project); the goal here is the lightest possible deployment that works for a demo.

## Goals / Non-Goals

**Goals:**
- Run Metabase on EC2, reachable via HTTP from a browser
- Zero-key AWS auth: IAM instance profile → Athena (no static credentials)
- Auto-stop when idle to minimise cost (target: ~$0 when not in use)
- One-command start: `npm run metabase:start` starts, waits, prints URL
- Idempotent setup script: provisions Athena connection + 3 gold dashboards via REST API

**Non-Goals:**
- HTTPS / TLS (PoC only; HTTP port 3000 is acceptable)
- High availability or persistent Metabase state (H2 is ephemeral — state resets on termination)
- Custom domain or Elastic IP by default (dynamic IP is accepted; Elastic IP is documented)
- Production-grade Metabase auth (built-in login is sufficient)

## Decisions

### 1. EC2 t3.small with user-data JAR install

**Decision**: Run Metabase as a JAR on a t3.small Amazon Linux 2023 instance using EC2 user-data for first-boot setup.

**Rationale**: Cheapest instance that runs Metabase comfortably (~750 MB RAM). Docker would add complexity with no benefit. JAR install via user-data is idempotent across starts (JAR and config persist on EBS).

**Alternatives**: t3.micro is too small (Metabase needs >512 MB). ECS Fargate is more expensive and overkill for a demo.

### 2. EBS for Metabase home directory (H2 database)

**Decision**: Mount a dedicated 8 GB gp3 EBS volume at `/metabase-data`. Store `MB_DB_FILE` there. Attach to the instance; persist across stop/start cycles.

**Rationale**: Instance stop (not terminate) retains EBS. H2 state (connections, questions, dashboards) survives restarts. 8 GB is far more than needed and costs ~$0.64/month.

**Trade-off**: Terminating the instance destroys Metabase state. Setup script is idempotent to recover.

### 3. IAM instance profile — no static keys

**Decision**: Attach an IAM role to the EC2 instance with `AthenaFullAccess`-like permissions + S3 read on silver/gold/results buckets. Leave `access_key` and `secret_key` empty in the Metabase Athena connection.

**Rationale**: Metabase's Athena driver uses the AWS Default Credentials Provider Chain when keys are blank, which includes EC2 instance profile. Verified against Metabase docs and GitHub issue #40120.

**Alternatives**: Explicit keys in Metabase → requires key rotation, risk of leaking via Metabase config API.

### 4. Auto-stop via CloudWatch + Lambda

**Decision**: CloudWatch alarm on `CPUUtilization < 5` for 2 consecutive 5-minute periods (10 min of sustained idle) triggers an SNS topic, which invokes a small Lambda that calls `ec2:StopInstances`.

**Rationale**: Simpler than EventBridge Scheduler (no cron guessing). Cost-effective: instance stops when forgotten after a demo.

**Alternatives**: Instance scheduled stop via EventBridge cron → stops even when in use. Systems Manager automation → more IAM surface. CloudWatch alarm is the cleanest cost-safety net.

### 5. Start script polling for readiness

**Decision**: `scripts/metabase-start.sh` calls `aws ec2 start-instances`, polls `aws ec2 describe-instances` for public IP, then polls `GET http://<ip>:3000/api/health` until `{"status":"ok"}`, then prints the URL.

**Rationale**: Metabase takes ~60–90 s to start. The script removes the guesswork — user just runs one command and gets a ready URL.

**IP strategy**: Dynamic public IP accepted for PoC. Document: assign Elastic IP if a stable URL is needed.

### 6. Setup script adapted from mydata

**Decision**: Copy `mydata/metabase/setup/__main__.py` into `metabase/setup/`, adapt for PoC: empty `access_key`/`secret_key`, point to the PoC workgroup and results bucket, add three SQL questions (one per gold table) and one dashboard YAML.

**Rationale**: The mydata script is already idempotent and uses only the public Metabase REST API — no changes to the engine needed, only configuration.

**Running the setup**: Invoked via `npm run metabase:setup` after `metabase:start`. Requires `METABASE_HOST`, `METABASE_USER`, `METABASE_PASSWORD` env vars.

## Risks / Trade-offs

- **H2 state loss on termination** → Mitigation: document clearly; setup script is idempotent and recovers all questions/dashboards.
- **Cold start latency (~90 s)** → Mitigation: start script polls and prints URL only when ready; user experience is one command, wait, click link.
- **Dynamic IP breaks bookmarks** → Mitigation: document Elastic IP allocation as a one-line Pulumi addition.
- **HTTP only** → Mitigation: acceptable for PoC on a private/demo network; document HTTPS path (ALB + ACM) for production.
- **Security group open on port 3000** → Mitigation: restrict ingress to a specific CIDR (developer IP) in Pulumi config.

## Migration Plan

1. `pulumi up` provisions EC2, IAM, EBS, CloudWatch alarm, stop Lambda — Metabase installs on first boot via user-data (takes ~3–5 min).
2. `npm run metabase:start` starts the instance and waits for readiness.
3. `npm run metabase:setup` provisions the Athena connection and dashboards.
4. Subsequent uses: `npm run metabase:start` → browse → instance auto-stops after ~10 min idle.

Rollback: `pulumi destroy` removes all resources; no data loss risk (EBS is non-critical state).

#!/usr/bin/env bash
# Start the Metabase EC2 instance, wait for it to be ready, and print the URL.
#
# Prerequisites:
#   - AWS CLI configured (uses AWS_PROFILE / AWS_DEFAULT_REGION from environment)
#   - Instance ID available via METABASE_INSTANCE_ID env var or `pulumi stack output metabaseInstanceId`
#
# Usage:
#   npm run metabase:start
#   METABASE_INSTANCE_ID=i-0abc123 bash scripts/metabase-start.sh

set -euo pipefail

# ── Resolve instance ID ────────────────────────────────────────────────────────

if [ -n "${METABASE_INSTANCE_ID:-}" ]; then
  INSTANCE_ID="$METABASE_INSTANCE_ID"
else
  echo "METABASE_INSTANCE_ID not set, fetching from Pulumi stack output..."
  INSTANCE_ID=$(pulumi stack output metabaseInstanceId 2>/dev/null)
  if [ -z "$INSTANCE_ID" ]; then
    echo "ERROR: Could not determine instance ID. Set METABASE_INSTANCE_ID or run from a Pulumi stack directory." >&2
    exit 1
  fi
fi

echo "Instance: $INSTANCE_ID"

# ── Start the instance ─────────────────────────────────────────────────────────

STATE=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)

if [ "$STATE" = "running" ]; then
  echo "Instance already running."
elif [ "$STATE" = "stopped" ]; then
  echo "Starting instance..."
  aws ec2 start-instances --instance-ids "$INSTANCE_ID" --output text > /dev/null
else
  echo "Instance is in state '$STATE' — waiting for it to settle..."
fi

# ── Wait for running state ─────────────────────────────────────────────────────

echo -n "Waiting for instance to be running"
for i in $(seq 1 60); do
  STATE=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text)
  if [ "$STATE" = "running" ]; then
    echo " running."
    break
  fi
  echo -n "."
  sleep 5
done

if [ "$STATE" != "running" ]; then
  echo "ERROR: Instance did not reach running state." >&2
  exit 1
fi

# ── Get public IP ──────────────────────────────────────────────────────────────

echo -n "Waiting for public IP"
for i in $(seq 1 30); do
  PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)
  if [ "$PUBLIC_IP" != "None" ] && [ -n "$PUBLIC_IP" ]; then
    echo " $PUBLIC_IP"
    break
  fi
  echo -n "."
  sleep 3
done

if [ -z "${PUBLIC_IP:-}" ] || [ "$PUBLIC_IP" = "None" ]; then
  echo "ERROR: Could not get public IP." >&2
  exit 1
fi

METABASE_URL="http://${PUBLIC_IP}:3000"

# ── Poll health endpoint ───────────────────────────────────────────────────────

echo -n "Waiting for Metabase to be ready (this takes ~90 s on cold start)"
for i in $(seq 1 60); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${METABASE_URL}/api/health" 2>/dev/null || true)
  if [ "$HTTP_STATUS" = "200" ]; then
    echo " ready!"
    break
  fi
  echo -n "."
  sleep 5
done

FINAL_STATUS=$(curl -s "${METABASE_URL}/api/health" 2>/dev/null || true)
if echo "$FINAL_STATUS" | grep -q '"status":"ok"'; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Metabase is ready: $METABASE_URL"
  echo " Admin setup (first run): complete setup at the URL above"
  echo " Run setup script: npm run metabase:setup"
  echo " Note: IP changes on each start. For a stable URL, allocate"
  echo "       an Elastic IP and associate it with instance $INSTANCE_ID"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
  echo ""
  echo "WARNING: Metabase may still be starting. Try $METABASE_URL in a minute."
fi

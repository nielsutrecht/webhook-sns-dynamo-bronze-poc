#!/usr/bin/env python3
"""Metabase auto-provisioning for the webhook PoC gold layer.

Provisions an Athena database connection and three gold-layer dashboards via
the Metabase REST API. Idempotent — safe to re-run.

Authentication to Athena uses the EC2 instance profile (access_key/secret_key
are left blank so Metabase falls back to the AWS Default Credentials Provider
Chain, which picks up the attached IAM instance profile).

Required env vars:
    MB_ADMIN_EMAIL    — Metabase admin email (default: admin@example.com)
    MB_ADMIN_PASSWORD — Metabase admin password (no default, required)
    METABASE_URL      — Metabase base URL (default: http://localhost:3000)

Optional env vars (default to dev stack values):
    AWS_REGION              (default: eu-west-1)
    ATHENA_WORKGROUP        (default: webhook-dev)
    ATHENA_RESULTS_BUCKET   (default: s3://webhook-athena-results-dev/)
    GLUE_DATABASE           (default: webhook_dev)
"""

import os
import sys
import time
from pathlib import Path

import yaml

from .client import MetabaseClient, find_card, find_database, find_dashboard

# ── Config ─────────────────────────────────────────────────────────────────────

METABASE_URL   = os.environ.get("METABASE_URL", "http://localhost:3000")
ADMIN_EMAIL    = os.environ.get("MB_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ["MB_ADMIN_PASSWORD"]

AWS_REGION            = os.environ.get("AWS_REGION", "eu-west-1")
ATHENA_WORKGROUP      = os.environ.get("ATHENA_WORKGROUP", "webhook-dev")
ATHENA_RESULTS_BUCKET = os.environ.get("ATHENA_RESULTS_BUCKET", "s3://webhook-athena-results-dev/")
GLUE_DATABASE         = os.environ.get("GLUE_DATABASE", "webhook_dev")

DATABASE_NAME = "Webhook PoC"

SETUP_DIR  = Path(__file__).parent
QUERIES_DIR = SETUP_DIR / "queries"
DASHBOARDS_DIR = Path(__file__).parent.parent / "dashboards"


# ── Dashboard config loader ────────────────────────────────────────────────────

def load_dashboard_configs():
    """Load dashboard YAML configs and resolve SQL query references."""
    configs = []

    for yaml_path in sorted(DASHBOARDS_DIR.glob("*.yaml")):
        with open(yaml_path) as f:
            config = yaml.safe_load(f)

        questions = []
        for section in config.get("sections", []):
            for card in section.get("cards", []):
                query_name = card["query"]
                sql_path = QUERIES_DIR / f"{query_name}.sql"
                if not sql_path.exists():
                    raise FileNotFoundError(f"SQL file not found: {sql_path}")

                sql = sql_path.read_text().strip()
                # Substitute the Glue database name
                sql = sql.replace("{database}", GLUE_DATABASE)

                questions.append({
                    "name": card["name"],
                    "sql": sql,
                    "display": card["display"],
                })

        configs.append({
            "name": config["name"],
            "sections": config["sections"],
            "questions": questions,
        })

    return configs


# ── Onboarding ─────────────────────────────────────────────────────────────────

def maybe_onboard(client):
    """Complete first-run onboarding if not already done."""
    props = client.get("/api/session/properties")
    if props.get("has-user-setup"):
        print("Onboarding already complete, skipping.")
        return False

    setup_token = props.get("setup-token")
    if not setup_token:
        raise RuntimeError("No setup token available and onboarding not complete")

    print("Running first-time onboarding...")
    client.post("/api/setup", json={
        "token": setup_token,
        "user": {
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD,
            "first_name": "Admin",
            "last_name": "User",
            "site_name": DATABASE_NAME,
        },
        "prefs": {
            "site_name": DATABASE_NAME,
            "site_locale": "en",
            "allow_tracking": False,
        },
    })
    print("Onboarding complete.")
    return True


# ── Database connection ────────────────────────────────────────────────────────

def provision_database(client):
    """Create the Athena connection if it doesn't already exist.

    access_key and secret_key are intentionally left blank so Metabase uses
    the AWS Default Credentials Provider Chain (EC2 instance profile).
    """
    existing = find_database(client, DATABASE_NAME)
    if existing:
        print(f"Database '{DATABASE_NAME}' already exists (id={existing['id']}), skipping.")
        return existing["id"]

    print(f"Creating Athena connection '{DATABASE_NAME}'...")
    db = client.post("/api/database", json={
        "name": DATABASE_NAME,
        "engine": "athena",
        "details": {
            "region": AWS_REGION,
            "workgroup": ATHENA_WORKGROUP,
            "s3_staging_dir": ATHENA_RESULTS_BUCKET,
            "access_key": "",   # intentionally blank — uses EC2 instance profile
            "secret_key": "",   # intentionally blank — uses EC2 instance profile
            "catalog": "awsdatacatalog",
        },
    })
    db_id = db["id"]
    print(f"Created database '{DATABASE_NAME}' (id={db_id})")

    print("Waiting for schema sync...")
    time.sleep(15)
    return db_id


# ── Questions ──────────────────────────────────────────────────────────────────

def provision_questions(client, db_id, questions):
    """Create questions (saved queries) if they don't already exist."""
    card_ids = []
    for q in questions:
        existing = find_card(client, q["name"])
        if existing:
            print(f"Question '{q['name']}' already exists (id={existing['id']}), skipping.")
            card_ids.append(existing["id"])
            continue

        print(f"Creating question '{q['name']}'...")
        card = client.post("/api/card", json={
            "name": q["name"],
            "dataset_query": {
                "type": "native",
                "native": {"query": q["sql"]},
                "database": db_id,
            },
            "display": q["display"],
            "visualization_settings": {},
        })
        card_ids.append(card["id"])
        print(f"Created question '{q['name']}' (id={card['id']})")

    return card_ids


# ── Dashboard ──────────────────────────────────────────────────────────────────

def provision_dashboard(client, dashboard_config, card_ids):
    """Create a dashboard with the given cards if it doesn't already exist."""
    dashboard_name = dashboard_config["name"]
    existing = find_dashboard(client, dashboard_name)
    if existing:
        print(f"Dashboard '{dashboard_name}' already exists (id={existing['id']}), skipping.")
        return existing["id"]

    print(f"Creating dashboard '{dashboard_name}'...")
    dash = client.post("/api/dashboard", json={"name": dashboard_name, "parameters": []})
    dash_id = dash["id"]

    dashcards = []
    temp_id = -1
    row = 0
    card_idx = 0

    for section in dashboard_config["sections"]:
        header = section.get("header")
        if header:
            dashcards.append({
                "id": temp_id,
                "card_id": None,
                "row": row,
                "col": 0,
                "size_x": 18,
                "size_y": 1,
                "visualization_settings": {
                    "virtual_card": {
                        "name": None,
                        "display": "text",
                        "visualization_settings": {},
                        "dataset_query": {},
                        "archived": False,
                    },
                    "text": f"## {header}",
                },
            })
            temp_id -= 1
            row += 1

        for card_def in section.get("cards", []):
            w = card_def.get("width", "full")
            width = 18 if w == "full" else 9
            height = card_def.get("height", 8)

            dashcards.append({
                "id": temp_id,
                "card_id": card_ids[card_idx],
                "row": row,
                "col": 0,
                "size_x": width,
                "size_y": height,
            })
            temp_id -= 1
            card_idx += 1
            row += height

    client.put(f"/api/dashboard/{dash_id}", json={"dashcards": dashcards})
    print(f"Created dashboard '{dashboard_name}' (id={dash_id}) with {len(card_ids)} cards")
    return dash_id


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Metabase provisioning — Webhook PoC gold layer")
    print(f"  Metabase:  {METABASE_URL}")
    print(f"  Database:  {GLUE_DATABASE}")
    print(f"  Workgroup: {ATHENA_WORKGROUP}")
    print("=" * 60)

    # Load and validate configs before touching the API
    dashboard_configs = load_dashboard_configs()
    print(f"Loaded {len(dashboard_configs)} dashboard config(s)")

    client = MetabaseClient(METABASE_URL)
    client.wait_for_ready()

    maybe_onboard(client)
    client.authenticate(ADMIN_EMAIL, ADMIN_PASSWORD)

    db_id = provision_database(client)

    for config in dashboard_configs:
        card_ids = provision_questions(client, db_id, config["questions"])
        provision_dashboard(client, config, card_ids)

    print("=" * 60)
    print("Provisioning complete!")
    print(f"Open Metabase at {METABASE_URL}")
    print("=" * 60)


if __name__ == "__main__":
    try:
        main()
    except KeyError as e:
        print(f"ERROR: missing required env var {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

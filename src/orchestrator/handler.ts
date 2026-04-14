/**
 * Orchestrator Lambda — silver + gold pipeline
 *
 * Triggered by S3 event notifications (via SQS) when Firehose delivers a bronze file.
 * For each file:
 *   1. Ensures Glue/Iceberg tables exist (idempotent, cached per Lambda instance)
 *   2. Registers the bronze partition with the Glue catalog
 *   3. MERGEs the new records into the silver Iceberg table (dedup on transactionId)
 *   4. Rebuilds all three gold aggregate tables from silver
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  QueryExecutionState,
} from "@aws-sdk/client-athena";
import type { SQSEvent } from "aws-lambda";

const DB = process.env.GLUE_DATABASE!;
const WORKGROUP = process.env.ATHENA_WORKGROUP!;
const BRONZE_BUCKET = process.env.BRONZE_BUCKET!;
const SILVER_BUCKET = process.env.SILVER_BUCKET!;
const GOLD_BUCKET = process.env.GOLD_BUCKET!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;

const athena = new AthenaClient({});

// Warm-start optimisation: skip DDL on subsequent invocations within the same instance
let tablesEnsured = false;

// ---------------------------------------------------------------------------
// Athena query helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runQuery(sql: string): Promise<void> {
  console.log(`Athena: ${sql.trim().slice(0, 200)}`);
  const { QueryExecutionId } = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: WORKGROUP,
      QueryExecutionContext: { Database: DB },
      ResultConfiguration: { OutputLocation: `s3://${RESULTS_BUCKET}/` },
    })
  );

  while (true) {
    await sleep(1000);
    const { QueryExecution } = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId })
    );
    const state = QueryExecution?.Status?.State;
    if (state === QueryExecutionState.SUCCEEDED) return;
    if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
      const reason = QueryExecution?.Status?.StateChangeReason ?? "unknown";
      throw new Error(`Athena query ${state}: ${reason}\nSQL: ${sql.trim().slice(0, 400)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Table DDL (runs once per Lambda instance)
// ---------------------------------------------------------------------------

async function ensureTables(): Promise<void> {
  if (tablesEnsured) return;

  // Bronze: external JSON table, Hive-partitioned — allows partition-filtered MERGE source
  await runQuery(`
    CREATE EXTERNAL TABLE IF NOT EXISTS ${DB}.bronze_transactions (
      transactionId    STRING,
      accountId        STRING,
      customerId       STRING,
      occurredAt       STRING,
      settledAt        STRING,
      amountCents      BIGINT,
      currency         STRING,
      balanceAfterCents BIGINT,
      balanceCurrency  STRING,
      transactionType  STRING,
      status           STRING,
      accountBic       STRING,
      counterpartyIban STRING,
      counterpartyBic  STRING,
      eventId          STRING,
      isInternal       BOOLEAN
    )
    PARTITIONED BY (year STRING, month STRING, day STRING)
    ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
    STORED AS INPUTFORMAT  'org.apache.hadoop.mapred.TextInputFormat'
               OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat'
    LOCATION 's3://${BRONZE_BUCKET}/events/'
  `);

  // Silver: Iceberg table — deduplicated pseudonymized transactions
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ${DB}.silver_transactions (
      transactionId    STRING,
      accountId        STRING,
      customerId       STRING,
      occurredAt       STRING,
      settledAt        STRING,
      amountCents      BIGINT,
      currency         STRING,
      balanceAfterCents BIGINT,
      balanceCurrency  STRING,
      transactionType  STRING,
      status           STRING,
      accountBic       STRING,
      counterpartyIban STRING,
      counterpartyBic  STRING,
      eventId          STRING,
      isInternal       BOOLEAN,
      year             STRING,
      month            STRING,
      day              STRING
    )
    LOCATION 's3://${SILVER_BUCKET}/transactions/'
    TBLPROPERTIES ('table_type' = 'ICEBERG', 'format' = 'parquet')
  `);

  // Gold: daily spend by account
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ${DB}.gold_daily_spend_by_account (
      accountId  STRING,
      day        DATE,
      totalCents BIGINT,
      txCount    BIGINT
    )
    LOCATION 's3://${GOLD_BUCKET}/daily_spend_by_account/'
    TBLPROPERTIES ('table_type' = 'ICEBERG', 'format' = 'parquet')
  `);

  // Gold: daily volume by transaction type
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ${DB}.gold_daily_volume_by_type (
      transactionType STRING,
      day             DATE,
      txCount         BIGINT,
      totalCents      BIGINT
    )
    LOCATION 's3://${GOLD_BUCKET}/daily_volume_by_type/'
    TBLPROPERTIES ('table_type' = 'ICEBERG', 'format' = 'parquet')
  `);

  // Gold: daily net flow by account (credits vs debits)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ${DB}.gold_daily_net_flow_by_account (
      accountId   STRING,
      day         DATE,
      creditCents BIGINT,
      debitCents  BIGINT,
      netCents    BIGINT
    )
    LOCATION 's3://${GOLD_BUCKET}/daily_net_flow_by_account/'
    TBLPROPERTIES ('table_type' = 'ICEBERG', 'format' = 'parquet')
  `);

  tablesEnsured = true;
  console.log("All tables ensured");
}

// ---------------------------------------------------------------------------
// Silver MERGE (task 5.3)
// ---------------------------------------------------------------------------

function parsePartition(key: string): { year: string; month: string; day: string } {
  const year = key.match(/year=(\d{4})/)?.[1];
  const month = key.match(/month=(\d{2})/)?.[1];
  const day = key.match(/day=(\d{2})/)?.[1];
  if (!year || !month || !day) {
    throw new Error(`Cannot extract partition from S3 key: ${key}`);
  }
  return { year, month, day };
}

async function silverMerge(bucket: string, key: string): Promise<void> {
  const { year, month, day } = parsePartition(key);
  const partitionLocation = `s3://${bucket}/events/year=${year}/month=${month}/day=${day}/`;

  // Register the partition so the external bronze table can see data in it
  await runQuery(`
    ALTER TABLE ${DB}.bronze_transactions
    ADD IF NOT EXISTS PARTITION (year='${year}', month='${month}', day='${day}')
    LOCATION '${partitionLocation}'
  `);

  // MERGE new records into silver; WHEN MATCHED → skip (deduplication)
  await runQuery(`
    MERGE INTO ${DB}.silver_transactions AS target
    USING (
      SELECT
        transactionId, accountId, customerId, occurredAt, settledAt,
        amountCents, currency, balanceAfterCents, balanceCurrency,
        transactionType, status, accountBic, counterpartyIban, counterpartyBic,
        eventId, isInternal, year, month, day
      FROM ${DB}.bronze_transactions
      WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
    ) AS source
    ON target.transactionId = source.transactionId
    WHEN NOT MATCHED THEN INSERT (
      transactionId, accountId, customerId, occurredAt, settledAt,
      amountCents, currency, balanceAfterCents, balanceCurrency,
      transactionType, status, accountBic, counterpartyIban, counterpartyBic,
      eventId, isInternal, year, month, day
    ) VALUES (
      source.transactionId, source.accountId, source.customerId, source.occurredAt,
      source.settledAt, source.amountCents, source.currency, source.balanceAfterCents,
      source.balanceCurrency, source.transactionType, source.status, source.accountBic,
      source.counterpartyIban, source.counterpartyBic, source.eventId, source.isInternal,
      source.year, source.month, source.day
    )
  `);

  console.log(`Silver MERGE complete for ${year}-${month}-${day}`);
}

// ---------------------------------------------------------------------------
// Gold rebuilds (tasks 5.4–5.6)
// ---------------------------------------------------------------------------

// Extract date from ISO timestamp: "2024-03-15T10:00:00Z" → DATE '2024-03-15'
const TO_DAY = `CAST(DATE_PARSE(SUBSTR(occurredAt, 1, 10), '%Y-%m-%d') AS DATE)`;

async function rebuildGold(): Promise<void> {
  // daily_spend_by_account (task 5.4)
  await runQuery(`DELETE FROM ${DB}.gold_daily_spend_by_account WHERE 1=1`);
  await runQuery(`
    INSERT INTO ${DB}.gold_daily_spend_by_account (accountId, day, totalCents, txCount)
    SELECT
      accountId,
      ${TO_DAY}   AS day,
      SUM(amountCents) AS totalCents,
      COUNT(*)         AS txCount
    FROM ${DB}.silver_transactions
    GROUP BY accountId, ${TO_DAY}
  `);

  // daily_volume_by_type (task 5.5)
  await runQuery(`DELETE FROM ${DB}.gold_daily_volume_by_type WHERE 1=1`);
  await runQuery(`
    INSERT INTO ${DB}.gold_daily_volume_by_type (transactionType, day, txCount, totalCents)
    SELECT
      transactionType,
      ${TO_DAY}   AS day,
      COUNT(*)         AS txCount,
      SUM(amountCents) AS totalCents
    FROM ${DB}.silver_transactions
    GROUP BY transactionType, ${TO_DAY}
  `);

  // daily_net_flow_by_account (task 5.6)
  await runQuery(`DELETE FROM ${DB}.gold_daily_net_flow_by_account WHERE 1=1`);
  await runQuery(`
    INSERT INTO ${DB}.gold_daily_net_flow_by_account (accountId, day, creditCents, debitCents, netCents)
    SELECT
      accountId,
      ${TO_DAY}                                                            AS day,
      SUM(CASE WHEN amountCents > 0 THEN amountCents ELSE 0 END)         AS creditCents,
      SUM(CASE WHEN amountCents < 0 THEN ABS(amountCents) ELSE 0 END)    AS debitCents,
      SUM(amountCents)                                                     AS netCents
    FROM ${DB}.silver_transactions
    GROUP BY accountId, ${TO_DAY}
  `);

  console.log("Gold rebuild complete");
}

// ---------------------------------------------------------------------------
// Handler (task 5.7)
// ---------------------------------------------------------------------------

interface S3EventRecord {
  s3: {
    bucket: { name: string };
    object: { key: string };
  };
}

export const handler = async (event: SQSEvent): Promise<void> => {
  await ensureTables();

  for (const sqsRecord of event.Records) {
    const s3Event = JSON.parse(sqsRecord.body) as { Records?: S3EventRecord[] };
    if (!s3Event.Records?.length) continue; // S3 test events have no Records

    for (const s3Record of s3Event.Records) {
      const bucket = s3Record.s3.bucket.name;
      const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, " "));
      console.log(`Processing s3://${bucket}/${key}`);
      await silverMerge(bucket, key);
    }
  }

  await rebuildGold();
};

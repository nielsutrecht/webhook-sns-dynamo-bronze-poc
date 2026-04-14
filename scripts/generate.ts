/**
 * Transaction generator — invokes the webhook Lambda at volume for testing.
 *
 * Usage:
 *   npx tsx scripts/generate.ts [options]
 *
 * Options:
 *   --count        Number of transactions to generate  (default: 100)
 *   --concurrency  Concurrent Lambda invocations        (default: 10)
 *   --function     Lambda function name                 (default: webhook-publisher-dev)
 *   --region       AWS region                           (default: eu-west-1)
 *   --dry-run      Print generated transactions, don't invoke Lambda
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "node:crypto";
import type { Transaction } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const COUNT = Number(args["count"] ?? 100);
const CONCURRENCY = Number(args["concurrency"] ?? 10);
const FUNCTION_NAME = String(args["function"] ?? "webhook-publisher-dev");
const REGION = String(args["region"] ?? "eu-west-1");
const DRY_RUN = "dry-run" in args;

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const KNOWN_BICS = [
  "ABNANL2A", "ADYBNL2A", "ASNBNL21", "BUNQNL2A",
  "INGBNL2A", "KNABNL2H", "NTSBDEB1XXX", "RABONL2U",
  "RBRBNL21", "SNSBNL2A", "TRIONL2U",
];

const CATEGORIES: Array<{
  transactionType: Transaction["transactionType"];
  descriptions: string[];
  counterparties: string[];
  minCents: number;
  maxCents: number;
  weight: number;
}> = [
  {
    transactionType: "PAYMENT",
    descriptions: ["Supermarket", "Grocery store", "Local market"],
    counterparties: ["Lidl", "Aldi", "Rewe", "Edeka", "Albert Heijn"],
    minCents: 500, maxCents: 15000, weight: 25,
  },
  {
    transactionType: "PAYMENT",
    descriptions: ["Restaurant", "Lunch", "Dinner out", "Takeaway"],
    counterparties: ["McDonald's", "Subway", "Vapiano", "Deliveroo"],
    minCents: 800, maxCents: 8000, weight: 20,
  },
  {
    transactionType: "PAYMENT",
    descriptions: ["Electricity bill", "Gas bill", "Internet"],
    counterparties: ["E.ON", "Vattenfall", "Telekom", "1&1"],
    minCents: 4000, maxCents: 18000, weight: 10,
  },
  {
    transactionType: "PAYMENT",
    descriptions: ["Bus ticket", "Train ticket", "Fuel", "Taxi"],
    counterparties: ["BVG", "DB Bahn", "ARAL", "Uber"],
    minCents: 250, maxCents: 12000, weight: 15,
  },
  {
    transactionType: "PAYMENT",
    descriptions: ["Streaming service", "Mobile top-up", "App store"],
    counterparties: ["Netflix", "Spotify", "Apple", "O2"],
    minCents: 800, maxCents: 1999, weight: 10,
  },
  {
    transactionType: "PAYMENT",
    descriptions: ["Online shopping", "Clothing", "Electronics"],
    counterparties: ["Zalando", "Amazon", "H&M", "Media Markt"],
    minCents: 1500, maxCents: 50000, weight: 10,
  },
  {
    transactionType: "TRANSFER",
    descriptions: ["Monthly salary"],
    counterparties: ["Employer AG"],
    minCents: 150000, maxCents: 600000, weight: 5,
  },
  {
    transactionType: "PAYMENT",
    descriptions: ["Monthly rent"],
    counterparties: ["Landlord GmbH", "Wohnbau AG"],
    minCents: 60000, maxCents: 200000, weight: 5,
  },
];

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomIban(): string {
  let iban = "DE";
  for (let i = 0; i < 20; i++) iban += randomInt(0, 9);
  return iban;
}

function weightedCategory() {
  const total = CATEGORIES.reduce((s, c) => s + c.weight, 0);
  let roll = Math.random() * total;
  for (const cat of CATEGORIES) {
    roll -= cat.weight;
    if (roll <= 0) return cat;
  }
  return CATEGORIES[0];
}

function randomDate(daysBack = 365): string {
  const d = new Date();
  d.setDate(d.getDate() - randomInt(0, daysBack));
  d.setHours(randomInt(0, 23), randomInt(0, 59), randomInt(0, 59), 0);
  return d.toISOString().replace(".000Z", "Z");
}

function generateTransaction(userId: string, accountId: string): Transaction {
  const cat = weightedCategory();
  const isCredit = cat.transactionType === "TRANSFER" && cat.descriptions[0] === "Monthly salary";
  const amountCents = isCredit
    ? randomInt(cat.minCents, cat.maxCents)
    : -randomInt(cat.minCents, cat.maxCents);
  const occurredAt = randomDate();

  return {
    transactionId: randomUUID(),
    accountId,
    customerId: userId,
    occurredAt,
    settledAt: occurredAt,
    amountCents,
    currency: "EUR",
    balanceAfterCents: randomInt(0, 500000),
    balanceCurrency: "EUR",
    description: pick(cat.descriptions),
    transactionType: cat.transactionType,
    status: "settled",
    accountBic: pick(KNOWN_BICS),
    counterpartyName: pick(cat.counterparties),
    counterpartyIban: randomIban(),
    counterpartyBic: pick(KNOWN_BICS),
    bankReference: Math.random() > 0.7 ? randomUUID() : null,
    eventId: randomUUID(),
    isInternal: false,
  };
}

function generateBatch(count: number): Transaction[] {
  const numUsers = Math.max(1, Math.floor(count / 10));
  const users = Array.from({ length: numUsers }, (_, i) =>
    `cus_${String(i + 1).padStart(4, "0")}`
  );
  const accounts = Array.from({ length: numUsers * 2 }, (_, i) =>
    `acc_${String(i + 1).padStart(4, "0")}`
  );

  return Array.from({ length: count }, () => {
    const userId = pick(users);
    const accountId = pick(accounts);
    return generateTransaction(userId, accountId);
  });
}

// ---------------------------------------------------------------------------
// Lambda invocation with concurrency control
// ---------------------------------------------------------------------------

async function invokeLambda(client: LambdaClient, tx: Transaction): Promise<void> {
  const payload = Buffer.from(JSON.stringify(tx));
  const response = await client.send(
    new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      Payload: payload,
    })
  );
  if (response.FunctionError) {
    const errorPayload = response.Payload
      ? Buffer.from(response.Payload).toString()
      : "unknown error";
    throw new Error(`Lambda error for ${tx.transactionId}: ${errorPayload}`);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<{ succeeded: number; failed: number }> {
  let index = 0;
  let succeeded = 0;
  let failed = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        await fn(items[i], i);
        succeeded++;
      } catch (err) {
        failed++;
        console.error(`  ✗ ${(err as Error).message}`);
      }
      if ((succeeded + failed) % 10 === 0) {
        process.stdout.write(`\r  ${succeeded + failed}/${items.length} sent (${failed} failed)`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { succeeded, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Generating ${COUNT} transactions...`);
  const transactions = generateBatch(COUNT);

  if (DRY_RUN) {
    console.log(JSON.stringify(transactions.slice(0, 3), null, 2));
    console.log(`... and ${transactions.length - 3} more`);
    return;
  }

  const client = new LambdaClient({ region: REGION });

  console.log(`Invoking ${FUNCTION_NAME} (concurrency: ${CONCURRENCY})...`);
  const start = Date.now();
  const { succeeded, failed } = await runWithConcurrency(
    transactions,
    CONCURRENCY,
    (tx) => invokeLambda(client, tx)
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n\nDone in ${elapsed}s — ${succeeded} succeeded, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

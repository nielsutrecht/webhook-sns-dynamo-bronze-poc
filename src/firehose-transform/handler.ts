import { parseFieldRules, applyRules, type FieldRules } from "../pseudonymization/engine.js";
import type { SnsEnvelope, Transaction } from "../shared/types.js";

interface FirehoseRecord {
  recordId: string;
  approximateArrivalTimestamp: number;
  data: string; // base64-encoded
}

interface FirehoseEvent {
  invocationId: string;
  deliveryStreamArn: string;
  region: string;
  records: FirehoseRecord[];
}

interface FirehoseResultRecord {
  recordId: string;
  result: "Ok" | "Dropped" | "ProcessingFailed";
  data: string; // base64-encoded
}

interface FirehoseResult {
  records: FirehoseResultRecord[];
}

// Parse FIELD_RULES once at init — fails fast on misconfiguration
const fieldRulesJson = process.env.FIELD_RULES;
if (!fieldRulesJson) {
  throw new Error("FIELD_RULES environment variable is not set");
}
const rules: FieldRules = parseFieldRules(fieldRulesJson);

export const handler = async (event: FirehoseEvent): Promise<FirehoseResult> => {
  const records: FirehoseResultRecord[] = event.records.map((record) => {
    try {
      const decoded = Buffer.from(record.data, "base64").toString("utf-8");
      const envelope = JSON.parse(decoded) as SnsEnvelope;
      const transaction = JSON.parse(envelope.Message) as Transaction;

      const result = applyRules(transaction as unknown as Record<string, unknown>, rules);

      if (!result.ok) {
        console.error(`ProcessingFailed for record ${record.recordId}: ${result.reason}`);
        return { recordId: record.recordId, result: "ProcessingFailed", data: record.data };
      }

      // Firehose expects each record to end with a newline (NDJSON in S3)
      const output = JSON.stringify(result.record) + "\n";
      return {
        recordId: record.recordId,
        result: "Ok",
        data: Buffer.from(output).toString("base64"),
      };
    } catch (err) {
      console.error(`ProcessingFailed for record ${record.recordId}:`, err);
      return { recordId: record.recordId, result: "ProcessingFailed", data: record.data };
    }
  });

  return { records };
};

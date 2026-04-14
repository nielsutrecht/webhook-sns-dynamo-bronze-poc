import { createHmac } from "node:crypto";

// PoC: secret is hardcoded. In production, source from AWS Secrets Manager.
const HMAC_SECRET = "poc-secret-do-not-use-in-production";

export type Action = "keep" | "hash" | "drop" | "partition-key";
export type FieldRules = Record<string, Action>;

/**
 * Parse and validate a FIELD_RULES JSON string.
 * Throws if the JSON is invalid or contains unknown actions.
 * Called once at Lambda init to fail fast on misconfiguration.
 */
export function parseFieldRules(json: string): FieldRules {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const validActions: Action[] = ["keep", "hash", "drop", "partition-key"];

  for (const [path, action] of Object.entries(parsed)) {
    if (!validActions.includes(action as Action)) {
      throw new Error(`Invalid action "${action}" for path "${path}". Valid actions: ${validActions.join(", ")}`);
    }
  }

  return parsed as FieldRules;
}

export type ApplyResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Apply field-level rules to a transaction record.
 *
 * Actions (per FIELD_RULES):
 *   partition-key — keep; fail record if absent or null
 *   hash          — replace with HMAC-SHA256 hex; remove if null
 *   drop          — remove from output
 *   keep          — pass through unchanged (explicit)
 *
 * Default (unlisted fields): keep.
 *
 * Supports simple $.fieldName JSONPath selectors for top-level fields.
 */
export function applyRules(
  transaction: Record<string, unknown>,
  rules: FieldRules
): ApplyResult {
  const output: Record<string, unknown> = { ...transaction };

  for (const [path, action] of Object.entries(rules)) {
    const fieldName = extractFieldName(path);
    const value = transaction[fieldName];

    switch (action) {
      case "partition-key": {
        if (value === undefined || value === null) {
          return {
            ok: false,
            reason: `Required partition-key field "${fieldName}" is absent or null`,
          };
        }
        // keep value as-is
        break;
      }

      case "hash": {
        if (value === undefined || value === null) {
          delete output[fieldName];
        } else {
          output[fieldName] = createHmac("sha256", HMAC_SECRET)
            .update(String(value))
            .digest("hex");
        }
        break;
      }

      case "drop": {
        delete output[fieldName];
        break;
      }

      case "keep": {
        // no-op — field already present in output copy
        break;
      }
    }
  }

  return { ok: true, record: output };
}

/**
 * Extract the field name from a simple $.fieldName JSONPath selector.
 * Supports top-level fields only (sufficient for flat Transaction records).
 */
function extractFieldName(path: string): string {
  const match = path.match(/^\$\.(\w+)$/);
  if (!match) {
    throw new Error(`Unsupported JSONPath selector: "${path}". Only $.fieldName is supported.`);
  }
  return match[1];
}

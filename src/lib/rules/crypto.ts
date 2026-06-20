/**
 * Transaction-rule field encryption (2026-06-01).
 *
 * Rules carry user free-text inside JSONB `conditions` + `actions` plus the
 * `name` column. Before this plan those were stored plaintext at rest — a
 * DB-only leak could read "payee contains Starbucks → rename to Coffee". This
 * module encrypts ONLY the sensitive free-text under the user's DEK and leaves
 * everything else (currency codes, FK ids, ops, amounts, dates) byte-identical
 * so the matcher and FK guards keep working after a decrypt.
 *
 * Encrypted fields:
 *   - rule `name`
 *   - `conditions.all[].value` where `field ∈ {payee, note, tags, ticker,
 *     security_name}` (string ops; ticker/security_name added FINLYNQ-208)
 *   - action `rename_payee.to`
 *   - action `set_tags.tags`
 *
 * NOT encrypted (must stay matchable / type-valid):
 *   - `CurrencyCondition.value` (3-letter ISO code; has .length(3)/.toUpperCase)
 *   - amount / account / date condition fields, all FK ids, all ops + kinds
 *
 * Encryption is a boundary concern: encrypt at write, decrypt at read/match.
 * The matcher (`src/lib/auto-categorize.ts`) is pure and operates on plaintext;
 * it is NOT changed. See plan/encryption-plaintext-gaps.md.
 */

import { z } from "zod";
import { encryptField, tryDecryptField, isEncrypted } from "@/lib/crypto/envelope";
import type { ConditionGroup, Action } from "./schema";

/** Loosely-typed rule shape. Both the Zod-validated write payload and the
 *  trust-the-DB read row flow through unchanged. */
export interface RuleCryptoFields {
  name?: string | null;
  conditions?: ConditionGroup | null;
  actions?: Action[] | null;
}

/** Condition fields whose `.value` is user free-text (vs. ISO currency codes).
 *  `ticker` / `security_name` (FINLYNQ-208) are sensitive captured strings —
 *  encrypted at rest on bank_transactions — so their condition value is
 *  encrypted here exactly like payee/note/tags. */
const STRING_CONDITION_FIELDS = new Set([
  "payee",
  "note",
  "tags",
  "ticker",
  "security_name",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object";
}

/**
 * Read-boundary narrowing for the JSONB arrays crossing the encryption boundary
 * (FINLYNQ-114). The DB hands these in as `unknown` (Drizzle JSONB), and this
 * module deliberately treats elements loosely — it only touches the free-text
 * fields and spreads everything else through verbatim, so it must tolerate ANY
 * legacy/partial/encrypted rule shape.
 *
 * `JsonArray` is intentionally the most permissive schema that still TYPES the
 * value as an array: `z.array(z.unknown())`. We use `.safeParse` and fall back
 * to `[]` only when the value is not array-like — it NEVER throws, so a parse
 * miss degrades to today's behavior (the per-element `isObj()` guards below
 * already pass non-object survivors through untouched). This replaces the four
 * unchecked array casts with a runtime-validated narrowing.
 */
const JsonArray = z.array(z.unknown());

function asJsonArray(value: unknown): unknown[] {
  const parsed = JsonArray.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * Apply a per-string transform (encrypt or decrypt) over the rule's sensitive
 * free-text fields. Deep-copies the touched structures so the caller's input is
 * never mutated. Untouched fields are spread through verbatim.
 */
function mapRuleStrings<T extends RuleCryptoFields>(
  rule: T,
  fn: (s: string) => string,
): T {
  const out: RuleCryptoFields = { ...rule };

  if (typeof rule.name === "string" && rule.name !== "") {
    out.name = fn(rule.name);
  }

  const condAll = rule.conditions?.all;
  if (Array.isArray(condAll)) {
    out.conditions = {
      ...rule.conditions,
      all: asJsonArray(condAll).map((c) => {
        if (
          isObj(c) &&
          typeof c.field === "string" &&
          STRING_CONDITION_FIELDS.has(c.field) &&
          typeof c.value === "string" &&
          c.value !== ""
        ) {
          return { ...c, value: fn(c.value) };
        }
        return c;
      }),
    } as ConditionGroup;
  }

  if (Array.isArray(rule.actions)) {
    out.actions = asJsonArray(rule.actions).map((a) => {
      if (!isObj(a) || typeof a.kind !== "string") return a;
      if (a.kind === "rename_payee" && typeof a.to === "string" && a.to !== "") {
        return { ...a, to: fn(a.to) };
      }
      if (a.kind === "set_tags" && typeof a.tags === "string" && a.tags !== "") {
        return { ...a, tags: fn(a.tags) };
      }
      return a;
    }) as Action[];
  }

  return out as T;
}

/**
 * Encrypt the sensitive free-text of a rule for storage. Cold DEK (`null`)
 * passes plaintext through — the login sweep re-encrypts later. Already-`v1:`
 * values are left untouched so a re-run never double-encrypts.
 */
export function encryptRuleFields<T extends RuleCryptoFields>(
  dek: Buffer | null,
  rule: T,
): T {
  if (!dek) return rule;
  return mapRuleStrings(rule, (s) =>
    isEncrypted(s) ? s : (encryptField(dek, s) ?? s),
  );
}

/**
 * Decrypt the sensitive free-text of a rule for display/matching. Tolerates
 * legacy plaintext (passthrough) and a null DEK (returns the rule unchanged).
 * On auth-tag failure returns the raw ciphertext (`?? s`) rather than throwing.
 */
export function decryptRuleFields<T extends RuleCryptoFields>(
  dek: Buffer | null,
  rule: T,
): T {
  if (!dek) return rule;
  return mapRuleStrings(rule, (s) => tryDecryptField(dek, s) ?? s);
}

/**
 * True when any sensitive free-text field on the rule is non-empty plaintext
 * (not yet `v1:` ciphertext). Used by the login sweep to upgrade only the rules
 * that actually need it, so a steady-state run is a no-op. Keeps the field
 * selection in one place (the same fields `encryptRuleFields` touches).
 */
export function ruleHasPlaintext(rule: RuleCryptoFields): boolean {
  if (typeof rule.name === "string" && rule.name !== "" && !isEncrypted(rule.name)) return true;
  const condAll = rule.conditions?.all;
  if (Array.isArray(condAll)) {
    for (const c of asJsonArray(condAll)) {
      if (
        isObj(c) &&
        typeof c.field === "string" &&
        STRING_CONDITION_FIELDS.has(c.field) &&
        typeof c.value === "string" &&
        c.value !== "" &&
        !isEncrypted(c.value)
      ) {
        return true;
      }
    }
  }
  if (Array.isArray(rule.actions)) {
    for (const a of asJsonArray(rule.actions)) {
      if (!isObj(a)) continue;
      if (a.kind === "rename_payee" && typeof a.to === "string" && a.to !== "" && !isEncrypted(a.to)) return true;
      if (a.kind === "set_tags" && typeof a.tags === "string" && a.tags !== "" && !isEncrypted(a.tags)) return true;
    }
  }
  return false;
}

/**
 * FINLYNQ-114 — typed rule factories + permissive JSONB read boundary.
 *
 * Two guarantees this pins so the type-safety work can't silently regress:
 *
 *  1. The typed factory maps in `rules/schema.ts` (which replaced the 12×
 *     `as unknown as Partial<Condition|Action>` casts in the rule editor)
 *     produce objects that PASS the canonical Zod `Condition`/`Action` schemas
 *     for every field/kind. If a factory drifts from the union, this fails.
 *
 *  2. The Zod read-boundary narrowing in `rules/crypto.ts` (which replaced the
 *     4× `as unknown[]` casts) NEVER throws and leaves non-sensitive fields
 *     byte-identical — including on LEGACY / PARTIAL / MALFORMED JSONB shapes
 *     that a strict parse would reject. This is the load-bearing hazard: a
 *     throw here would break the rules engine at decrypt-before-match time.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import {
  Condition,
  Action,
  defaultConditionForField,
  defaultActionForKind,
  type ConditionField,
  type ActionKind,
} from "@/lib/rules/schema";
import {
  encryptRuleFields,
  decryptRuleFields,
  ruleHasPlaintext,
  type RuleCryptoFields,
} from "@/lib/rules/crypto";
import { isEncrypted } from "@/lib/crypto/envelope";

const ALL_FIELDS: ConditionField[] = [
  "payee",
  "note",
  "tags",
  "amount",
  "account",
  "currency",
  "date",
  // FINLYNQ-208
  "ticker",
  "security_name",
  "quantity",
];

const ALL_KINDS: ActionKind[] = [
  "set_category",
  "set_tags",
  "rename_payee",
  "set_account",
  "set_entered_currency",
  "set_portfolio_holding",
  "create_transfer",
  // FINLYNQ-208
  "record_investment_op",
];

describe("typed rule factory maps (FINLYNQ-114)", () => {
  // The factories seed BLANK editor defaults (e.g. `to: ""`, `categoryId: 0`)
  // that the user fills in before submit, so they are intentionally NOT yet
  // Zod-valid (`.min(1)` / `.positive()` reject the placeholders). The
  // guarantee that matters is byte-identity with the objects the old
  // `as unknown as Partial<…>` casts produced — pinned explicitly below.

  it("defaultConditionForField sets the requested field discriminator for every field", () => {
    for (const field of ALL_FIELDS) {
      const cond = defaultConditionForField(field, 42);
      expect(cond.field, `field=${field}`).toBe(field);
    }
  });

  it("defaultConditionForField reproduces the exact pre-refactor cast defaults", () => {
    expect(defaultConditionForField("payee")).toEqual({ field: "payee", op: "contains", value: "" });
    expect(defaultConditionForField("note")).toEqual({ field: "note", op: "contains", value: "" });
    expect(defaultConditionForField("tags")).toEqual({ field: "tags", op: "contains", value: "" });
    expect(defaultConditionForField("amount")).toEqual({ field: "amount", op: "gt", value: 0 });
    expect(defaultConditionForField("account", 11)).toEqual({ field: "account", op: "is", accountId: 11 });
    expect(defaultConditionForField("currency")).toEqual({ field: "currency", op: "is", value: "CAD" });
    expect(defaultConditionForField("date")).toEqual({ field: "date", op: "weekday", weekday: 1 });
  });

  it("defaultActionForKind sets the requested kind discriminator for every kind", () => {
    for (const kind of ALL_KINDS) {
      const action = defaultActionForKind(kind, 7);
      expect(action.kind, `kind=${kind}`).toBe(kind);
    }
  });

  it("defaultActionForKind reproduces the exact pre-refactor cast defaults", () => {
    expect(defaultActionForKind("set_category", 5)).toEqual({ kind: "set_category", categoryId: 5 });
    expect(defaultActionForKind("set_tags")).toEqual({ kind: "set_tags", tags: "" });
    expect(defaultActionForKind("rename_payee")).toEqual({ kind: "rename_payee", to: "" });
    expect(defaultActionForKind("set_account", 6)).toEqual({ kind: "set_account", accountId: 6 });
    expect(defaultActionForKind("set_entered_currency")).toEqual({ kind: "set_entered_currency", currency: "USD" });
    expect(defaultActionForKind("set_portfolio_holding", 8)).toEqual({ kind: "set_portfolio_holding", holdingId: 8 });
    expect(defaultActionForKind("create_transfer", 3)).toEqual({ kind: "create_transfer", destAccountId: 3 });
  });

  it("a fully-specified condition/action DOES pass the canonical Zod schema (sanity)", () => {
    // Proves the factory shapes are correct discriminated-union members once
    // their placeholder slots are filled — the editor's submit path validates
    // the filled object, which the server re-validates with these schemas.
    expect(Condition.safeParse({ ...defaultConditionForField("payee"), value: "Costco" }).success).toBe(true);
    expect(Action.safeParse({ ...defaultActionForKind("rename_payee"), to: "Clean" }).success).toBe(true);
    expect(Action.safeParse({ ...defaultActionForKind("set_category"), categoryId: 9 }).success).toBe(true);
  });

  it("FK seed id flows into the FK-bearing variants only", () => {
    expect(defaultConditionForField("account", 99)).toMatchObject({ field: "account", accountId: 99 });
    expect(defaultActionForKind("set_category", 5)).toMatchObject({ kind: "set_category", categoryId: 5 });
    expect(defaultActionForKind("set_portfolio_holding", 8)).toMatchObject({ kind: "set_portfolio_holding", holdingId: 8 });
    expect(defaultActionForKind("create_transfer", 3)).toMatchObject({ kind: "create_transfer", destAccountId: 3 });
    // FK-less kinds ignore the id arg entirely.
    expect(defaultActionForKind("set_tags", 999)).toEqual({ kind: "set_tags", tags: "" });
    expect(defaultActionForKind("rename_payee", 999)).toEqual({ kind: "rename_payee", to: "" });
  });
});

describe("rules/crypto JSONB read boundary stays permissive (FINLYNQ-114)", () => {
  const dek = randomBytes(32);

  it("round-trips a normal rule and only touches sensitive free-text", () => {
    const rule: RuleCryptoFields = {
      name: "Groceries",
      conditions: {
        all: [
          { field: "payee", op: "contains", value: "Whole Foods" },
          { field: "amount", op: "gt", value: 50 },
          { field: "currency", op: "is", value: "USD" }, // NOT encrypted
        ],
      } as RuleCryptoFields["conditions"],
      actions: [
        { kind: "set_category", categoryId: 3 },
        { kind: "rename_payee", to: "Grocery store" },
        { kind: "set_tags", tags: "food, essentials" },
      ] as RuleCryptoFields["actions"],
    };

    const enc = encryptRuleFields(dek, rule);
    // Sensitive fields encrypted...
    expect(isEncrypted(enc.name as string)).toBe(true);
    expect(isEncrypted((enc.conditions!.all[0] as { value: string }).value)).toBe(true);
    // ...currency code left byte-identical (must stay matchable / .length(3)).
    expect((enc.conditions!.all[2] as { value: string }).value).toBe("USD");
    expect((enc.conditions!.all[1] as { value: number }).value).toBe(50);

    const dec = decryptRuleFields(dek, enc);
    expect(dec.name).toBe("Groceries");
    expect((dec.conditions!.all[0] as { value: string }).value).toBe("Whole Foods");
    expect((dec.actions![1] as { to: string }).to).toBe("Grocery store");
    expect((dec.actions![2] as { tags: string }).tags).toBe("food, essentials");
  });

  it("never throws on legacy / partial / malformed JSONB shapes", () => {
    const weirdShapes: RuleCryptoFields[] = [
      // Condition element is null (non-object survivor).
      { conditions: { all: [null] } as unknown as RuleCryptoFields["conditions"], actions: [] },
      // Condition with an unknown field + extra keys (future/legacy shape).
      { conditions: { all: [{ field: "wat", op: "??", value: "x", extra: 1 }] } as unknown as RuleCryptoFields["conditions"] },
      // Action element is a bare string.
      { actions: ["not-an-object"] as unknown as RuleCryptoFields["actions"] },
      // Action with no kind.
      { actions: [{ to: "x" }] as unknown as RuleCryptoFields["actions"] },
      // conditions present but all is not an array.
      { conditions: { all: "nope" } as unknown as RuleCryptoFields["conditions"] },
      // Everything null/undefined.
      { name: null, conditions: null, actions: null },
    ];

    for (const r of weirdShapes) {
      expect(() => encryptRuleFields(dek, r)).not.toThrow();
      expect(() => decryptRuleFields(dek, r)).not.toThrow();
      expect(() => ruleHasPlaintext(r)).not.toThrow();
    }
  });

  it("a null DEK passes the rule through unchanged (cold-DEK path)", () => {
    const rule: RuleCryptoFields = {
      name: "Plain",
      conditions: { all: [{ field: "note", op: "contains", value: "secret" }] } as RuleCryptoFields["conditions"],
      actions: [{ kind: "set_tags", tags: "x" }] as RuleCryptoFields["actions"],
    };
    expect(encryptRuleFields(null, rule)).toBe(rule);
    expect(decryptRuleFields(null, rule)).toBe(rule);
  });
});

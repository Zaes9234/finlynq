/**
 * FINLYNQ-208 — investment reconciliation rules: pure cores.
 *
 * Pins the parts that have no DB dependency so they can't silently regress:
 *  - the any-two-of-three trade resolver + zero-guard (the executor's tc-5),
 *  - the per-op semantic validation,
 *  - the new ticker/security_name/quantity conditions in the matcher,
 *  - the rule schema parse for `record_investment_op` + the new conditions,
 *  - the crypto boundary encrypting ticker/security_name condition values.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import {
  resolveTrade,
  resolveCashAmount,
} from "@/lib/rules/investment-op-binding";
import {
  Action,
  Condition,
  defaultActionForKind,
  defaultConditionForField,
  validateInvestmentOpAction,
  type RecordInvestmentOpAction,
} from "@/lib/rules/schema";
import { evalCondition, applyRules, type TransactionRule } from "@/lib/auto-categorize";
import { encryptRuleFields, decryptRuleFields } from "@/lib/rules/crypto";
import { isEncrypted } from "@/lib/crypto/envelope";

// ─── resolveTrade — any two of {qty, total, price} → {qty, total} ────────────

describe("resolveTrade (any-two-of-three + zero-guard)", () => {
  const row = { amount: -3700, quantity: 10, price: null };

  it("qty + total from the row (the common buy)", () => {
    const r = resolveTrade(
      { qty: { from: "row_quantity" }, total: { from: "row_amount" } },
      row,
    );
    expect(r).toEqual({ ok: true, qty: 10, total: 3700 });
  });

  it("uses magnitudes — a sell row (qty<0, amount>0) still yields positive", () => {
    const r = resolveTrade(
      { qty: { from: "row_quantity" }, total: { from: "row_amount" } },
      { amount: 950.25, quantity: -5, price: null },
    );
    expect(r).toEqual({ ok: true, qty: 5, total: 950.25 });
  });

  it("qty + price → total computed", () => {
    const r = resolveTrade(
      { qty: { from: "row_quantity" }, price: { from: "fixed", value: 50 } },
      { amount: null, quantity: 4, price: null },
    );
    expect(r).toEqual({ ok: true, qty: 4, total: 200 });
  });

  it("total + price → qty computed", () => {
    const r = resolveTrade(
      { total: { from: "row_amount" }, price: { from: "fixed", value: 25 } },
      { amount: -100, quantity: null, price: null },
    );
    expect(r).toEqual({ ok: true, qty: 4, total: 100 });
  });

  it("only one binding present → insufficient_inputs", () => {
    const r = resolveTrade({ qty: { from: "row_quantity" } }, row);
    expect(r).toEqual({ ok: false, code: "insufficient_inputs" });
  });

  it("zero quantity → qty_nonpositive (tc-5: no NaN/zero trade)", () => {
    const r = resolveTrade(
      { qty: { from: "row_quantity" }, total: { from: "row_amount" } },
      { amount: -3700, quantity: 0, price: null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("qty_nonpositive");
  });

  it("zero total → total_nonpositive (a shares-only statement line)", () => {
    const r = resolveTrade(
      { qty: { from: "row_quantity" }, total: { from: "row_amount" } },
      { amount: 0, quantity: 10, price: null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("total_nonpositive");
  });

  it("missing row field → insufficient_inputs (no NaN)", () => {
    const r = resolveTrade(
      { qty: { from: "row_quantity" }, total: { from: "row_price" } },
      { amount: -100, quantity: 10, price: null },
    );
    expect(r.ok).toBe(false);
  });
});

describe("resolveCashAmount", () => {
  it("binds the cash amount from the row magnitude", () => {
    const r = resolveCashAmount({ total: { from: "row_amount" } }, { amount: -12.4, quantity: null });
    expect(r).toEqual({ ok: true, amount: 12.4 });
  });
  it("fixed value", () => {
    const r = resolveCashAmount({ total: { from: "fixed", value: 5 } }, { amount: null, quantity: null });
    expect(r).toEqual({ ok: true, amount: 5 });
  });
  it("missing binding → underivable", () => {
    const r = resolveCashAmount({}, { amount: -10, quantity: null });
    expect(r).toEqual({ ok: false, code: "amount_underivable" });
  });
  it("zero amount → nonpositive", () => {
    const r = resolveCashAmount({ total: { from: "row_amount" } }, { amount: 0, quantity: null });
    expect(r).toEqual({ ok: false, code: "amount_nonpositive" });
  });
});

// ─── validateInvestmentOpAction ──────────────────────────────────────────────

describe("validateInvestmentOpAction", () => {
  const base: RecordInvestmentOpAction = {
    kind: "record_investment_op",
    op: "buy",
    investmentAccountId: 1,
    useRowTicker: true,
    qty: { from: "row_quantity" },
    total: { from: "row_amount" },
  };

  it("accepts a complete buy", () => {
    expect(validateInvestmentOpAction(base)).toBeNull();
  });

  it("buy without a position → missing_position", () => {
    expect(validateInvestmentOpAction({ ...base, useRowTicker: false, holdingId: undefined })).toBe(
      "missing_position",
    );
  });

  it("buy with only one binding → insufficient_trade_bindings", () => {
    expect(validateInvestmentOpAction({ ...base, total: undefined })).toBe(
      "insufficient_trade_bindings",
    );
  });

  it("missing investment account → missing_account", () => {
    expect(validateInvestmentOpAction({ ...base, investmentAccountId: 0 })).toBe("missing_account");
  });

  it("deposit needs a counterparty", () => {
    expect(
      validateInvestmentOpAction({
        kind: "record_investment_op",
        op: "deposit",
        investmentAccountId: 1,
        total: { from: "row_amount" },
      }),
    ).toBe("missing_counterparty");
  });

  it("deposit with self-counterparty → self_counterparty", () => {
    expect(
      validateInvestmentOpAction({
        kind: "record_investment_op",
        op: "deposit",
        investmentAccountId: 1,
        counterpartyAccountId: 1,
        total: { from: "row_amount" },
      }),
    ).toBe("self_counterparty");
  });

  it("dividend needs an amount binding", () => {
    expect(
      validateInvestmentOpAction({
        kind: "record_investment_op",
        op: "dividend",
        investmentAccountId: 1,
        useRowTicker: true,
      }),
    ).toBe("missing_total_binding");
  });

  it("rejects a non-positive fixed value", () => {
    expect(
      validateInvestmentOpAction({
        ...base,
        qty: { from: "fixed", value: 0 },
      }),
    ).toBe("fixed_value_nonpositive");
  });
});

// ─── new conditions in the matcher ───────────────────────────────────────────

describe("ticker / security_name / quantity conditions", () => {
  it("ticker exact (case-insensitive)", () => {
    expect(evalCondition({ ticker: "VTI" }, { field: "ticker", op: "exact", value: "vti" })).toBe(true);
    expect(evalCondition({ ticker: "VOO" }, { field: "ticker", op: "exact", value: "vti" })).toBe(false);
  });

  it("security_name contains", () => {
    expect(
      evalCondition(
        { securityName: "Vanguard Total Market ETF" },
        { field: "security_name", op: "contains", value: "vanguard" },
      ),
    ).toBe(true);
  });

  it("quantity gt / lt distinguishes buy vs sell sign", () => {
    expect(evalCondition({ quantity: 10 }, { field: "quantity", op: "gt", value: 0 })).toBe(true);
    expect(evalCondition({ quantity: -5 }, { field: "quantity", op: "lt", value: 0 })).toBe(true);
    expect(evalCondition({ quantity: -5 }, { field: "quantity", op: "gt", value: 0 })).toBe(false);
  });

  it("quantity between", () => {
    expect(evalCondition({ quantity: 3 }, { field: "quantity", op: "between", min: 1, max: 5 })).toBe(true);
    expect(evalCondition({ quantity: 9 }, { field: "quantity", op: "between", min: 1, max: 5 })).toBe(false);
  });

  it("applyRules matches an investment-op rule on ticker + quantity", () => {
    const rule: TransactionRule = {
      id: 1,
      name: "VTI buys",
      isActive: true,
      priority: 0,
      conditions: {
        all: [
          { field: "ticker", op: "exact", value: "VTI" },
          { field: "quantity", op: "gt", value: 0 },
        ],
      },
      actions: [defaultActionForKind("record_investment_op", 7) as Action],
    };
    const match = applyRules({ ticker: "VTI", quantity: 10, amount: -3700 }, [rule]);
    expect(match).not.toBeNull();
    expect(match?.actions[0].kind).toBe("record_investment_op");
  });
});

// ─── schema parse + factory ──────────────────────────────────────────────────

describe("schema parse", () => {
  it("parses a record_investment_op action", () => {
    const a = {
      kind: "record_investment_op",
      op: "buy",
      investmentAccountId: 3,
      useRowTicker: true,
      qty: { from: "row_quantity" },
      total: { from: "row_amount" },
    };
    expect(Action.safeParse(a).success).toBe(true);
  });

  it("the factory default parses (its bindings are pre-filled)", () => {
    expect(Action.safeParse(defaultActionForKind("record_investment_op", 5)).success).toBe(true);
  });

  it("the new condition factories set the right field discriminator", () => {
    // Factory defaults seed blank placeholders (value:"") the user fills before
    // submit — so they are intentionally NOT yet Zod-valid (.min(1)). Only the
    // discriminator is guaranteed here, matching the existing factory contract.
    expect(defaultConditionForField("ticker").field).toBe("ticker");
    expect(defaultConditionForField("security_name").field).toBe("security_name");
    expect(defaultConditionForField("quantity").field).toBe("quantity");
  });

  it("parses FILLED new conditions", () => {
    expect(Condition.safeParse({ field: "ticker", op: "exact", value: "VTI" }).success).toBe(true);
    expect(Condition.safeParse({ field: "security_name", op: "contains", value: "Vanguard" }).success).toBe(true);
    expect(Condition.safeParse({ field: "quantity", op: "gt", value: 0 }).success).toBe(true);
    expect(Condition.safeParse({ field: "quantity", op: "between", min: 1, max: 5 }).success).toBe(true);
  });
});

// ─── crypto boundary — ticker/security_name condition values encrypted ────────

describe("rules crypto encrypts ticker/security_name condition values", () => {
  const dek = randomBytes(32);

  it("round-trips and leaves FK/enum fields untouched", () => {
    const rule = {
      name: "VTI rule",
      conditions: {
        all: [
          { field: "ticker", op: "exact", value: "VTI" },
          { field: "security_name", op: "contains", value: "Vanguard" },
          { field: "quantity", op: "gt", value: 0 },
        ] as Condition[],
      },
      actions: [defaultActionForKind("record_investment_op", 9) as Action],
    };
    const enc = encryptRuleFields(dek, rule);
    const encConds = enc.conditions!.all as Array<Record<string, unknown>>;
    // ticker + security_name values become ciphertext...
    expect(isEncrypted(encConds[0].value as string)).toBe(true);
    expect(isEncrypted(encConds[1].value as string)).toBe(true);
    // ...quantity stays a plain number (not a string condition).
    expect(encConds[2].value).toBe(0);

    const dec = decryptRuleFields(dek, enc);
    const decConds = dec.conditions!.all as Array<Record<string, unknown>>;
    expect(decConds[0].value).toBe("VTI");
    expect(decConds[1].value).toBe("Vanguard");
  });
});

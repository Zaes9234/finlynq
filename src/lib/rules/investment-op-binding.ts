/**
 * FINLYNQ-208 — pure variable-binding resolver for investment-op rule actions.
 *
 * A `record_investment_op` action declares WHERE each numeric parameter comes
 * from via `VarSource` (a captured row field or a fixed value). This module
 * turns those bindings + a concrete bank row into the magnitudes the
 * operations.ts helpers expect — deriving a trade from ANY TWO of
 * {amount, price, quantity} and computing the third (amount = price × qty).
 *
 * Pure (no DB I/O), so the zero-guard (tc-5) and the any-two-of-three math are
 * unit-testable without a DB. The op SIGN / direction is decided by the op
 * kind in the executor, NOT here — every value returned is a positive
 * magnitude (operations.ts `recordBuy`/`recordSell` take magnitudes).
 */

import type { VarSource } from "./schema";

export interface OpRowVars {
  /** Bank row signed total amount (native currency). */
  amount: number | null;
  /** Captured share/unit quantity (signed). */
  quantity: number | null;
  /** Captured price per unit. FINLYNQ-195 does not capture an explicit price
   *  column yet, so this is usually null today; the binding model carries it so
   *  a future capture slots in without an executor change. */
  price?: number | null;
}

export type TradeResolveError =
  | "insufficient_inputs"
  | "qty_nonpositive"
  | "total_nonpositive"
  | "price_nonpositive"
  | "not_finite";

export type CashResolveError = "amount_underivable" | "amount_nonpositive";

/** Resolve a single VarSource to its raw (signed) numeric value, or null when
 *  the source is absent / the referenced row field is missing / non-finite. */
export function resolveVarRaw(
  src: VarSource | undefined,
  row: OpRowVars,
): number | null {
  if (!src) return null;
  if (src.from === "fixed") {
    return Number.isFinite(src.value) ? src.value : null;
  }
  const raw =
    src.from === "row_amount"
      ? row.amount
      : src.from === "row_quantity"
        ? row.quantity
        : src.from === "row_price"
          ? row.price ?? null
          : null;
  return raw != null && Number.isFinite(raw) ? raw : null;
}

/** Magnitude (abs) of a resolved var, or null. */
function mag(src: VarSource | undefined, row: OpRowVars): number | null {
  const v = resolveVarRaw(src, row);
  return v == null ? null : Math.abs(v);
}

/**
 * Resolve a buy/sell into `{ qty, total }` positive magnitudes from any two of
 * {qty, total, price}. Zero-guarded — never returns a 0 / NaN / negative trade
 * (tc-5). `price` is only used to fill in a missing qty or total.
 */
export function resolveTrade(
  action: { qty?: VarSource; total?: VarSource; price?: VarSource },
  row: OpRowVars,
):
  | { ok: true; qty: number; total: number }
  | { ok: false; code: TradeResolveError } {
  const q = mag(action.qty, row);
  const t = mag(action.total, row);
  const p = mag(action.price, row);

  let qty = q;
  let total = t;

  if (qty != null && total != null) {
    // both directly bound — price (if any) is ignored.
  } else if (qty != null && p != null) {
    total = qty * p;
  } else if (total != null && p != null) {
    if (p <= 0) return { ok: false, code: "price_nonpositive" };
    qty = total / p;
  } else {
    return { ok: false, code: "insufficient_inputs" };
  }

  if (qty == null || total == null || !Number.isFinite(qty) || !Number.isFinite(total)) {
    return { ok: false, code: "not_finite" };
  }
  if (qty <= 0) return { ok: false, code: "qty_nonpositive" };
  if (total <= 0) return { ok: false, code: "total_nonpositive" };
  return { ok: true, qty, total };
}

/**
 * Resolve a cash op (dividend / interest / fee / deposit / withdrawal) to a
 * positive magnitude. The cash amount binds to `action.total`. Sign /
 * direction is the op's job, not this resolver's.
 */
export function resolveCashAmount(
  action: { total?: VarSource },
  row: OpRowVars,
): { ok: true; amount: number } | { ok: false; code: CashResolveError } {
  const t = mag(action.total, row);
  if (t == null) return { ok: false, code: "amount_underivable" };
  if (!Number.isFinite(t) || t <= 0) return { ok: false, code: "amount_nonpositive" };
  return { ok: true, amount: t };
}

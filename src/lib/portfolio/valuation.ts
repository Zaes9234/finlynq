/**
 * Shared portfolio valuation layer (FINLYNQ-268, child F of the MCP-surface-v4
 * epic).
 *
 * ONE place that answers "what is this portfolio worth, and on WHICH basis?" so
 * every money-bearing MCP response can carry a uniform, explicit `basis` field
 * instead of forcing an agent to reverse-engineer the basis from magnitudes.
 * This generalizes the FINLYNQ-151 / 251 / 253 / 254 point fixes — all of which
 * are the same root cause (≥4 unlabelled valuation bases).
 *
 * **Composition, NOT re-derivation (CLAUDE.md "Reuse over copy").** This module
 * NEVER re-implements the pricing / FX loop. It composes the canonical paths:
 *   - `market` / `active_cost` ← `getHoldingsValueByHolding` (.value / .costBasis)
 *   - `lifetime_cost`          ← `aggregateHoldings().buy_amount`
 *   - `ledger`                 ← per-account `SUM(transactions.amount)`
 *
 * **DEK gate (load-bearing, from FINLYNQ-151).** `market` requires a DEK: a
 * `pf_` API-key connection has `dek == null`, so holdings symbols decrypt to
 * null and the pricing path values them at qty×1 (garbage). `valuePortfolio`
 * therefore NEVER calls the pricing path for a null DEK — it falls back to
 * `active_cost` + a `warnings` entry, mirroring `applyInvestmentMarketOverlay`.
 *
 * The four `ValuationBasis` values are position/point-in-time bases. Flow
 * responses (realized gains, dividends, cash-flow reports) carry their OWN
 * axis-aware `basis` values (`realized` / `cash_flow`) that are labelled at the
 * tool boundary — this layer is position valuation only.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getHoldingsValueByHolding, type HoldingValue } from "@/lib/holdings-value";
import { aggregateHoldings } from "@/lib/portfolio/aggregate-holdings";
import { todayISO } from "@/lib/utils/date";

/**
 * Point-in-time position valuation basis. Snake_case matches the ticket's four
 * names verbatim and `get_net_worth`'s existing lowercase `basis` strings.
 */
export type ValuationBasis =
  | "lifetime_cost" // Σ every buy ever (aggregateHoldings().buy_amount). NEVER for weights.
  | "active_cost"   // remaining cost basis of active positions (getHoldingsValueByHolding .costBasis)
  | "ledger"        // COALESCE(SUM(transactions.amount)) net-contribution
  | "market";       // current/at-date market value (getHoldingsValueByHolding .value)

/** One valued holding row (native account currency), carrying the cash-sleeve
 * flag so weight-computing callers can exclude cash from diversification
 * weighting via ONE shared source (FINLYNQ-253). */
export interface ValuedHolding {
  holdingId: number;
  accountId: number;
  name: string | null;
  symbol: string | null;
  isCash: boolean;
  /** Value on the requested basis, in the ACCOUNT currency. */
  value: number;
  currency: string;
}

export interface PortfolioValuation {
  /** The basis ACTUALLY used (may differ from `requestedBasis` on fallback). */
  basis: ValuationBasis;
  /** What the caller asked for. */
  requestedBasis: ValuationBasis;
  /** ISO date; REQUIRED (set) when `basis === 'market'`, else undefined. */
  asOf?: string;
  /** Set when the requested basis was unavailable and we fell back. */
  warnings?: string[];
  /** Per-holding rows (native account currency) for weight / rollup math. */
  byHolding: ValuedHolding[];
}

const MARKET_UNAVAILABLE_WARNING =
  "market unavailable (no decryption key / no live prices); showing active cost basis";

/**
 * Value a user's whole portfolio on the requested basis, composing the existing
 * pricing paths. Returns per-holding native rows + the basis actually used +
 * `asOf` (for market) + `warnings` (on fallback).
 *
 * - `market`        → `getHoldingsValueByHolding().value`. **Falls back to
 *                     `active_cost` + a warning when `dek == null`** (can't
 *                     price) OR nothing priced (all-unpriced).
 * - `active_cost`   → `getHoldingsValueByHolding().costBasis` (price-independent;
 *                     always available).
 * - `lifetime_cost` → `aggregateHoldings().buy_amount` per holding.
 * - `ledger`        → per-holding `SUM(transactions.amount)` (net contribution).
 */
export async function valuePortfolio(
  userId: string,
  dek: Buffer | null,
  opts: { basis: ValuationBasis; asOfDate?: string; accountId?: number | null },
): Promise<PortfolioValuation> {
  const requestedBasis = opts.basis;
  const accountId = opts.accountId ?? null;

  // --- market / active_cost: composed from getHoldingsValueByHolding ---
  if (requestedBasis === "market" || requestedBasis === "active_cost") {
    const warnings: string[] = [];
    let effectiveBasis: ValuationBasis = requestedBasis;

    // DEK gate: market needs a DEK to decrypt symbols for pricing. A null DEK
    // ⇒ never call the pricing path (qty×1 garbage). Fall back to active_cost.
    if (requestedBasis === "market" && dek == null) {
      effectiveBasis = "active_cost";
      warnings.push(MARKET_UNAVAILABLE_WARNING);
    }

    const rows: HoldingValue[] = await getHoldingsValueByHolding(userId, dek, {
      asOfDate: opts.asOfDate,
      accountId,
    });

    // Market requested WITH a DEK but nothing priced (all-unpriced) → fall
    // back to active cost too. "Nothing priced" = no holding carries a
    // non-zero market value.
    if (effectiveBasis === "market" && !rows.some((h) => Number(h.value) !== 0)) {
      effectiveBasis = "active_cost";
      warnings.push(MARKET_UNAVAILABLE_WARNING);
    }

    const useMarket = effectiveBasis === "market";
    const byHolding: ValuedHolding[] = rows.map((h) => ({
      holdingId: h.holdingId,
      accountId: h.accountId,
      name: h.name,
      symbol: h.symbol,
      isCash: h.isCash,
      value: useMarket ? Number(h.value) : Number(h.costBasis),
      currency: h.currency,
    }));

    return {
      basis: effectiveBasis,
      requestedBasis,
      asOf: useMarket ? opts.asOfDate ?? todayISO() : undefined,
      warnings: warnings.length ? warnings : undefined,
      byHolding,
    };
  }

  // --- lifetime_cost: aggregateHoldings().buy_amount per holding ---
  if (requestedBasis === "lifetime_cost") {
    const aggs = await aggregateHoldings(db, userId, dek);
    const byHolding: ValuedHolding[] = aggs
      .filter((a) => a.holding_id != null)
      .map((a) => ({
        holdingId: a.holding_id as number,
        accountId: 0, // aggregateHoldings is holding-grained, not account-grained
        name: a.name ?? null,
        symbol: null,
        // aggregateHoldings does not expose is_cash; lifetime_cost is never used
        // for weight math (the weightBasis guard enforces this), so the cash
        // flag is not load-bearing here.
        isCash: false,
        value: Number(a.buy_amount ?? 0),
        currency: a.currency ?? "USD",
      }));
    return { basis: "lifetime_cost", requestedBasis, byHolding };
  }

  // --- ledger: per-holding net contribution SUM(transactions.amount) ---
  const asOfDate = opts.asOfDate ?? todayISO();
  const accountFilter = accountId != null ? sql`AND t.account_id = ${accountId}` : sql``;
  const ledgerRows = (await db.execute(sql`
    SELECT t.portfolio_holding_id AS holding_id,
           MIN(t.account_id) AS account_id,
           COALESCE(a.currency, 'USD') AS currency,
           COALESCE(SUM(t.amount), 0)::float8 AS net
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.user_id = ${userId}
      AND t.portfolio_holding_id IS NOT NULL
      AND t.date <= ${asOfDate}
      ${accountFilter}
    GROUP BY t.portfolio_holding_id, a.currency
  `)) as unknown as { rows?: Array<Record<string, unknown>> };
  const rows = Array.isArray(ledgerRows) ? ledgerRows : ledgerRows.rows ?? [];
  const byHolding: ValuedHolding[] = rows
    .filter((r) => r.holding_id != null)
    .map((r) => ({
      holdingId: Number(r.holding_id),
      accountId: Number(r.account_id ?? 0),
      name: null,
      symbol: null,
      isCash: false,
      value: Number(r.net ?? 0),
      currency: String(r.currency ?? "USD"),
    }));
  return { basis: "ledger", requestedBasis, byHolding };
}

/**
 * Weight-safety guard (tc-2). Returns the basis to compute portfolio WEIGHTS on
 * (rebalancing / diversification / concentration): `market` when priced, else
 * `active_cost`. **NEVER `lifetime_cost`** — the FINLYNQ-251/253 bug was
 * weighting on lifetime book cost, which inflated cash sleeves to their
 * flow-through total.
 *
 * `valuePortfolio` already downgrades a market request to `active_cost` on
 * fallback, so a well-formed weight caller passes `valuePortfolio({ basis:
 * 'market' })` and this returns `market` or `active_cost`. If a caller hands it
 * a `lifetime_cost` or `ledger` valuation (a bug), it coerces to `active_cost`
 * in prod and throws in dev so the mistake is caught in tests.
 */
export function weightBasis(v: PortfolioValuation): "market" | "active_cost" {
  if (v.basis === "market") return "market";
  if (v.basis === "active_cost") return "active_cost";
  // A lifetime_cost / ledger valuation must NEVER reach a weight computation.
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      `weightBasis: refusing to weight on basis '${v.basis}' — weights must be market-else-active_cost, never lifetime_cost/ledger.`,
    );
  }
  return "active_cost";
}

/**
 * Shared portfolio-aggregation predicates (FINLYNQ-106).
 *
 * Single source of truth for the issue-#128 "paired cash-leg skip" used by the
 * three holdings/cost-basis aggregators. Before this module the predicate was
 * spelled out independently in:
 *   - `src/app/api/portfolio/overview/route.ts` (drizzle `sql` CASE fragment),
 *   - `mcp-server/register-tools-pg.ts` `accumulate()` (a JS boolean),
 * and was simply MISSING from `src/lib/holdings-value.ts`. Defining the rule
 * once here keeps all three paths in lockstep — the divergence FINLYNQ-106 was
 * filed to close.
 *
 * --- The rule (issue #128, Phase 2 update 2026-05-26) ---
 *
 * A paired cash-leg row (the cash sibling of a multi-currency / Phase-2 trade
 * pair) must be excluded from BOTH the buy- and sell-side cost-basis tallies of
 * a holding's aggregation. Two row shapes qualify:
 *
 *   1. Phase 2+ (2026-05-25 sign convention): the cash leg carries an explicit
 *      `kind` discriminator — `'buy_cash_leg'` or `'sell_cash_leg'` — and a
 *      NON-zero amount + quantity. The legacy `amount = 0` test no longer
 *      matches these, so the `kind` check is load-bearing.
 *   2. Legacy / pre-Phase-2 rows (un-tagged): `kind` is NULL but the cash leg
 *      is identifiable as `trade_link_id IS NOT NULL AND amount = 0`.
 *
 * The predicate is the UNION (OR) of the two shapes. It must stay disjunctive
 * across the two shapes but the legacy fallback itself stays CONJUNCTIVE
 * (`trade_link_id IS NOT NULL AND amount = 0`) — flipping the fallback to `OR`
 * would wrongly skip legitimate zero-amount or link-less rows (see the
 * conjunctivity caveat in `tests/portfolio-aggregator-dividends-and-sellskip.ts`
 * tc-4 and CLAUDE.md "Issue #128 paired cash-leg skip").
 */

import { sql, type SQL } from "drizzle-orm";

/** Canonical Phase-2 cash-leg `kind` discriminators. */
export const CASH_LEG_KINDS = ["buy_cash_leg", "sell_cash_leg"] as const;
export type CashLegKind = (typeof CASH_LEG_KINDS)[number];

/**
 * Pure-JS form of the #128 paired cash-leg skip. Returns `true` when the row is
 * a paired cash leg that must be excluded from buy/sell cost-basis tallies.
 *
 * Used by the MCP `accumulate()` aggregator, which reduces rows in JS rather
 * than via `SUM(CASE …)`. The two SQL aggregators consume `cashLegSkipSql()`
 * below; both forms are derived from the same rule so they cannot drift.
 */
export function isCashLegRow(row: {
  kind?: string | null;
  trade_link_id?: string | null;
  tradeLinkId?: string | null;
  amount?: number | string | null;
}): boolean {
  const kind = row.kind ?? null;
  if (kind === "buy_cash_leg" || kind === "sell_cash_leg") return true;
  const tradeLinkId = row.trade_link_id ?? row.tradeLinkId ?? null;
  const amount = row.amount == null ? null : Number(row.amount);
  return tradeLinkId != null && amount === 0;
}

/**
 * Columns the drizzle `cashLegSkipSql()` fragment reads off the `transactions`
 * table (or an alias). Passing the column refs in (rather than importing
 * `schema`) keeps this module dependency-light and lets callers point it at an
 * aliased self-join if ever needed.
 */
export type CashLegSkipColumns = {
  kind: SQL.Aliased | SQL | unknown;
  tradeLinkId: SQL.Aliased | SQL | unknown;
  amount: SQL.Aliased | SQL | unknown;
};

/**
 * Drizzle `sql` form of the #128 paired cash-leg skip — the SINGLE definition
 * of the predicate string `kind IN ('buy_cash_leg','sell_cash_leg') OR
 * (trade_link_id IS NOT NULL AND amount = 0)`. Returns a boolean SQL fragment
 * that is `true` for a paired cash-leg row; wrap it in `NOT (...)` inside a
 * `SUM(CASE WHEN … THEN … ELSE 0 END)` to exclude those rows from a tally.
 *
 * Consumed by `holdings-value.ts` and `api/portfolio/overview/route.ts`.
 */
export function cashLegSkipSql(cols: CashLegSkipColumns): SQL<boolean> {
  return sql<boolean>`(${cols.kind} IN ('buy_cash_leg', 'sell_cash_leg') OR (${cols.tradeLinkId} IS NOT NULL AND ${cols.amount} = 0))`;
}

/**
 * Dividend-attribution holding id (FINLYNQ-173).
 *
 * A portfolio_income / portfolio_expense dividend row lands ON the brokerage
 * cash sleeve (`portfolio_holding_id = USD_Cash`) but carries
 * `related_holding_id = <paying security>` so reports can group the dividend
 * BY the security that earned it (see schema-pg.ts `related_holding_id` doc).
 *
 * The per-holding aggregators (overview route, MCP `aggregateHoldings`,
 * lots `loadMetricsForUser`, `listDividendIncome` groupBy:"holding") naively
 * keyed dividends on `portfolio_holding_id`, so EVERY ticker's dividend cash
 * inflow piled onto the Cash sleeve's Dividends column (and its Total Return).
 * This helper is the SINGLE source of truth for re-attribution: credit
 * `related_holding_id` when present, else fall back to `portfolio_holding_id`
 * (legacy rows recorded before related-holding stamping, and genuine
 * cash-sleeve interest with no security tie). The grand total is preserved —
 * the amount is MOVED from cash to the ticker, never duplicated or dropped.
 *
 * Keep all four aggregators pointed at this helper so they cannot drift.
 */
export function dividendAttributionHoldingId(row: {
  relatedHoldingId?: number | null;
  related_holding_id?: number | null;
  portfolioHoldingId?: number | null;
  portfolio_holding_id?: number | null;
}): number | null {
  const related = row.relatedHoldingId ?? row.related_holding_id ?? null;
  if (related != null) return Number(related);
  const own = row.portfolioHoldingId ?? row.portfolio_holding_id ?? null;
  return own != null ? Number(own) : null;
}

/**
 * Drizzle `sql` form of `dividendAttributionHoldingId` —
 * `COALESCE(related_holding_id, portfolio_holding_id)`. Pass the two column
 * refs; consumed by `api/portfolio/overview/route.ts` + `lots/read.ts` where
 * the dividend tally is keyed in SQL.
 */
export function dividendAttributionHoldingIdSql(cols: {
  relatedHoldingId: SQL.Aliased | SQL | unknown;
  portfolioHoldingId: SQL.Aliased | SQL | unknown;
}): SQL<number | null> {
  return sql<number | null>`COALESCE(${cols.relatedHoldingId}, ${cols.portfolioHoldingId})`;
}

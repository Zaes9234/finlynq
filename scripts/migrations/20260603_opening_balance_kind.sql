-- Re-tag legacy opening-balance rows from kind='buy' to kind='opening_balance'.
--
-- Context (HANDOVER_2026-06-02_BACKFILL_REVIEW_BUGS.md):
-- The first-pass backfill pipeline (commits e3487de → 92ed3a6) stamped
-- `kind='buy'` on rows surfaced as opening_balance proposals. That created
-- predicate divergence between the planner's `isAlreadyCanonical` (any
-- non-null kind = canonical) and the coverage endpoint's stricter rule
-- (kind + pair-less kind OR trade_link_id OR link_id). Symptom: coverage
-- reported N pending while planner returned 0 proposals.
--
-- Resolution: introduce 'opening_balance' as a distinct kind literal.
-- This migration re-tags rows that were stamped 'buy' by the first-pass
-- flow so coverage and the strict predicate agree on them.
--
-- Safety: we ONLY re-tag rows where the kind='buy' row is the EARLIEST
-- transaction for its (portfolio_holding_id, account_id) pair. This is
-- the same heuristic the planner uses in `isFirstTxForHolding`. A
-- kind='buy' row that is NOT the earliest for its holding is genuinely
-- a broken pair (no trade_link_id, no cash leg) — leaving it as 'buy'
-- means the next planner run will surface it as orphan_stock_leg, which
-- is correct.
--
-- Additional guard: limited to investment accounts only.
-- Pure additive: no schema changes, no destructive ops.

WITH earliest_per_holding AS (
  SELECT
    t.id,
    ROW_NUMBER() OVER (
      PARTITION BY t.portfolio_holding_id, t.account_id
      ORDER BY t.date ASC, t.id ASC
    ) AS rn
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  WHERE t.kind = 'buy'
    AND t.trade_link_id IS NULL
    AND t.link_id IS NULL
    AND t.portfolio_holding_id IS NOT NULL
    AND t.account_id IS NOT NULL
    AND a.is_investment = true
)
UPDATE transactions
SET kind = 'opening_balance',
    updated_at = NOW()
WHERE id IN (
  SELECT id FROM earliest_per_holding WHERE rn = 1
);

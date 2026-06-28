-- Cash-snapshot per-account auto-rebuild work queue.
--
-- The cash side of the "Net Worth / Balance Over Time" chart re-materializes
-- per-account daily balances in portfolio_snapshots (source='cash'). Until now
-- cash staleness was detected only by a per-user fingerprint (tx count +
-- max-updated), and a stale fingerprint forced a FULL-history rebuild across
-- EVERY cash account on the next chart load — even when a single today-dated
-- transaction was booked. This table is the cash twin of
-- portfolio_snapshot_dirty: every cash-affecting tx write stamps the impacted
-- (account, earliest-date) here (markCashSnapshotsDirty), co-located with the
-- existing invalidateUser()/markSnapshotsDirty() call, and the chart-load cash
-- self-heal rebuilds ONLY that account from from_date forward.
--
-- Per-account (PK user_id, account_id) so a tx in one account never rebuilds
-- siblings. from_date is the earliest affected date, coalesced via LEAST on
-- conflict so repeated edits / back-dated rows collapse to one widest range.
-- The fingerprint stays the robustness trigger: if something is stale but no
-- dirty row exists (an unstamped mutation path), the self-heal falls back to a
-- full rebuild.
--
-- Purely additive — no destructive DDL, so deploy.sh applies it on the next
-- deploy with no code-first/SQL-second dance.
--
-- The runner in deploy.sh wraps the file in a transaction with the
-- schema_migrations bookkeeping insert — do NOT add a BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS portfolio_cash_snapshot_dirty (
  user_id    TEXT        NOT NULL,
  account_id INTEGER     NOT NULL,
  -- Earliest affected date (YYYY-MM-DD). Coalesced via LEAST on conflict.
  from_date  TEXT        NOT NULL,
  marked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id)
);

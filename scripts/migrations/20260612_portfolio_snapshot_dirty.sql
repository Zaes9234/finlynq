-- Portfolio snapshot auto-rebuild work queue (plan/net-worth-over-time.md Part B).
--
-- The nightly portfolio-snapshots cron is forward-only (writes only today's
-- snapshot), so a back-dated investment edit leaves historical snapshots
-- stale. Every investment-affecting transaction write stamps a row here
-- (markSnapshotsDirty), co-located with the existing invalidateUser() call.
--
-- The snapshot-drain cron (src/lib/cron/snapshot-drain.ts, registered in
-- src/instrumentation.ts) reads all dirty rows, re-materializes
-- `[from_date, today]` per user via rebuildPortfolioSnapshots, then DELETEs
-- each row WHERE marked_at is unchanged from the value it captured before the
-- rebuild. Writes arriving mid-rebuild bump marked_at and therefore survive
-- the delete → they get re-drained on the next tick (no lost edits).
--
-- Purely additive — no destructive DDL, so deploy.sh applies it on the next
-- deploy with no code-first/SQL-second dance.
--
-- The runner in deploy.sh wraps the file in a transaction with the
-- schema_migrations bookkeeping insert — do NOT add a BEGIN/COMMIT here.

CREATE TABLE IF NOT EXISTS portfolio_snapshot_dirty (
  user_id    TEXT        PRIMARY KEY,
  -- Earliest affected date (YYYY-MM-DD). Coalesced via LEAST on conflict so
  -- bulk imports / repeated edits collapse into one widest dirty range.
  from_date  TEXT        NOT NULL,
  marked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

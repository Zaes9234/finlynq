-- Portfolio snapshots — Phase 3 (2026-06-01).
--
-- Daily per-(user, account, date) snapshot of market value + cost basis
-- + net contributions. Powers the TWRR / MWRR / value-over-time chart on
-- /portfolio and the new MCP tool `get_portfolio_performance_v2`.
--
-- Built nightly by scripts/cron-build-portfolio-snapshots.ts (registered
-- in src/instrumentation.ts; the plan's reference to
-- src/lib/cron/index.ts predates the current cron-bootstrap shape).
-- Historical fill by scripts/backfill-portfolio-snapshots.ts.
--
-- Reporting currency choice: snapshots are stored in the user's
-- reporting currency AT SNAP TIME — switching reporting ccy later
-- doesn't retroactively re-FX. TWRR is dimensionless so unaffected; the
-- value chart shows the historical ccy with a tooltip explaining the
-- discontinuity. Storing in USD-canonical was the alternative but
-- forces an FX hop on every read which is hot-path-expensive.
--
-- `gaps_filled` marks days where the builder fell back to last-known
-- price / FX rate (price_cache or fx_rates didn't cover the bar). The
-- UI surfaces an "incomplete history" badge on chart ranges containing
-- gap-filled days so users know to interpret with care.
--
-- account_id NULL is the whole-portfolio aggregate row — one per user
-- per day. Per-account rows are NOT NULL on account_id. The unique
-- index uses COALESCE(account_id, -1) so PG treats the NULL aggregate
-- as deduplicated against the per-account rows.
--
-- The runner in deploy.sh wraps the file in a transaction with the
-- schema_migrations bookkeeping insert — do NOT add a BEGIN/COMMIT
-- block here.

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id               SERIAL            PRIMARY KEY,
  user_id          TEXT              NOT NULL,
  -- YYYY-MM-DD; matches transactions.date format. One snapshot per day.
  snap_date        TEXT              NOT NULL,
  -- NULL = whole-portfolio aggregate (one per user per day); else the
  -- per-account snapshot. CASCADE on account so a wiped account
  -- doesn't leave stale per-account rows; whole-portfolio rows persist
  -- because they aggregate all the user's accounts.
  account_id       INTEGER           REFERENCES accounts(id) ON DELETE CASCADE,
  market_value     DOUBLE PRECISION  NOT NULL,
  cost_basis       DOUBLE PRECISION  NOT NULL,
  -- Net contribution INTO this snapshot's account on snap_date.
  -- (transfer-in dollar value − transfer-out dollar value). Used by
  -- TWRR's Modified Dietz fallback when a same-day cash flow can't be
  -- timed inside the bar.
  net_contribution DOUBLE PRECISION  NOT NULL DEFAULT 0,
  -- User's reporting currency AT SNAP TIME. Stored so the chart can
  -- detect retroactive reporting-ccy changes and warn the user.
  currency         TEXT              NOT NULL,
  -- TRUE when any price_cache or fx_rates lookup fell back to a
  -- last-known value (the bar's day wasn't in cache). Surfaces as the
  -- "incomplete history" badge on charts.
  gaps_filled      BOOLEAN           NOT NULL DEFAULT FALSE,
  source           TEXT              NOT NULL DEFAULT 'cron',
  created_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Unique per (user, day, account). COALESCE handles the NULL-aggregate
-- case so the per-day "whole portfolio" row is deduped against the
-- per-account rows on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_snapshots_user_date_acct_idx
  ON portfolio_snapshots (user_id, snap_date, COALESCE(account_id, -1));

-- Hot path: chart range scan.
CREATE INDEX IF NOT EXISTS portfolio_snapshots_user_date_idx
  ON portfolio_snapshots (user_id, snap_date);

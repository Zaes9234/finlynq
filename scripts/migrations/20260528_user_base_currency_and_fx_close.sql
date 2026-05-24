-- Portfolio ops Phase 5 — base currency + close-time FX snapshot.
--
-- Adds:
--   users.base_currency               CHAR(3) NOT NULL DEFAULT 'USD'
--   holding_lot_closures.fx_to_usd_at_close  DOUBLE PRECISION NULL
--
-- `base_currency` is the lot-accounting basis (drives realized-gain
-- math in base currency), DISTINCT from `settings.display_currency`
-- (UI presentation, user can flip freely).
--
-- `fx_to_usd_at_close` is the historical USD rate at the moment a lot
-- was closed. Combined with the existing `holding_lots.fx_to_usd_at_open`
-- snapshot, the aggregator can compute realized gain in any base
-- currency without round-tripping to the FX rate cache.
--
-- The runner in deploy.sh wraps each file in a transaction; do NOT
-- add BEGIN/COMMIT here.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS base_currency CHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE holding_lot_closures
  ADD COLUMN IF NOT EXISTS fx_to_usd_at_close DOUBLE PRECISION;

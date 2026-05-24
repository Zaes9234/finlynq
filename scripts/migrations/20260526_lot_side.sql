-- Portfolio ops Phase 3 — short-position lots.
--
-- Adds a `side` flag on `holding_lots` so the lot engine can model
-- short positions opened when a Sell exceeds the available open long
-- lots. The overflow opens a `side='short'` lot at the sell price;
-- a subsequent Buy on the same (holding, account) FIFO-closes the
-- shorts before opening fresh long lots.
--
-- Realized-gain formula on a short close inverts the sign:
--   short_open  lot:  cost_per_share = sell_price at short-open time
--   short_close on Buy: realized_gain = (cost - buy_price) × qty
--                       (gain when buy_price < short cost, loss otherwise)
--
-- Existing rows default to `'long'`. The CHECK enum on
-- holding_lot_closures.close_kind expands to allow `short_open`
-- (closure row marking the moment the short was opened — kept for audit
-- trail symmetry) + `short_close` (closure row when the short is
-- closed by a buy).
--
-- The runner in deploy.sh wraps each file in a transaction; do NOT add
-- BEGIN/COMMIT here.

ALTER TABLE holding_lots
  ADD COLUMN IF NOT EXISTS side TEXT NOT NULL DEFAULT 'long';

ALTER TABLE holding_lots
  DROP CONSTRAINT IF EXISTS holding_lots_side_check;

ALTER TABLE holding_lots
  ADD CONSTRAINT holding_lots_side_check
    CHECK (side IN ('long', 'short'));

-- Hot path: "open shorts on this holding/account?" — the buy-closes-short
-- branch in write-hooks.ts queries this on every buy.
CREATE INDEX IF NOT EXISTS holding_lots_user_holding_acct_side_open_idx
  ON holding_lots (user_id, holding_id, account_id, side, status)
  WHERE status = 'open';

-- Expand the closure-kind enum if a CHECK constraint is present.
ALTER TABLE holding_lot_closures
  DROP CONSTRAINT IF EXISTS holding_lot_closures_close_kind_check;

ALTER TABLE holding_lot_closures
  ADD CONSTRAINT holding_lot_closures_close_kind_check
    CHECK (
      close_kind IN (
        'sell',
        'transfer_out',
        'swap_out',
        'fx_conversion',
        'income_expense',
        'buy_sell',
        'short_open',
        'short_close'
      )
    );

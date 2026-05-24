-- Portfolio operations refactor — Phase 2 (post-39ab0b7): brokerage
-- Deposit + Withdrawal kinds.
--
-- Adds 4 new transaction `kind` discriminator values for cash moves
-- between a non-investment account and a brokerage's cash sleeve:
--
--   'brokerage_deposit_out'    — non-investment account leg (qty=0, amount<0)
--   'brokerage_deposit_in'     — brokerage cash sleeve leg (qty>0, amount>0)
--   'brokerage_withdrawal_out' — brokerage cash sleeve leg (qty<0, amount<0)
--   'brokerage_withdrawal_in'  — non-investment account leg (qty=0, amount>0)
--
-- Like in-kind transfers + FX conversions, both legs share a `link_id`
-- (NOT `trade_link_id` — that's reserved for the buy/sell stock+cash pair).
-- Cross-currency deposits/withdrawals are refused application-layer so
-- the brokerage cash sleeve currency always equals the non-investment
-- account currency.
--
-- The runner in deploy.sh wraps each migration file in a transaction; do
-- NOT add BEGIN/COMMIT here.

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_kind_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_kind_check
    CHECK (
      kind IS NULL OR kind IN (
        'buy', 'buy_cash_leg',
        'sell', 'sell_cash_leg',
        'in_kind_transfer_in', 'in_kind_transfer_out',
        'fx_from', 'fx_to', 'fx_fee',
        'portfolio_income', 'portfolio_expense',
        'brokerage_deposit_out', 'brokerage_deposit_in',
        'brokerage_withdrawal_out', 'brokerage_withdrawal_in'
      )
    );

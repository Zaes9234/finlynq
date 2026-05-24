-- Phase 3 (missing-lot detection): add `lot_action` column to
-- backfill_proposals so apply route knows which lot operation to run
-- for `missing_lot` proposals.
--
-- Context (plan `ok-bug-one-fixed-floofy-hopper.md`, Phase 3): rows that
-- are already canonical (kind set + canonical pair shape) sometimes have
-- no corresponding entry in `holding_lots` or `holding_lot_closures`.
-- Typical cause: row predates the lot system or was written via a path
-- that bypassed `applyLotEffectsForTx`. The planner's Pass 0 detector
-- emits `missing_lot` proposals; the apply path runs the lot hook
-- directly (no UPDATE on the transaction row — the row is correct, just
-- the lot is missing).
--
-- `lot_action` is derived from the row's `kind` at plan time so the UI
-- can label the proposal clearly (open / close / transfer).
--
-- The runner in deploy.sh wraps each migration in a transaction
-- (psql --single-transaction with ON_ERROR_STOP=1); no BEGIN/COMMIT.

ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS lot_action TEXT
    CHECK (lot_action IS NULL OR lot_action IN ('open', 'close', 'transfer'));

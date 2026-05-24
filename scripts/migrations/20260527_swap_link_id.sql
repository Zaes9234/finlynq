-- Portfolio ops Phase 4 follow-up — Swap edit support via `swap_link_id`.
--
-- Today a Swap is internally a Sell pair (sharing tradeLinkId₁) + a Buy
-- pair (sharing tradeLinkId₂). The two pairs share NO link, so when the
-- user clicks Edit on a swap row the load endpoint can't find the other
-- half. Pre-this-migration swaps were "delete-and-recreate-only".
--
-- This column ties all 4 rows of a swap together so Edit loads the
-- whole bundle. Pre-migration swaps stay un-linked (NULL) and continue
-- to use the delete-and-recreate path.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS swap_link_id TEXT;

CREATE INDEX IF NOT EXISTS transactions_swap_link_id_idx
  ON transactions (swap_link_id)
  WHERE swap_link_id IS NOT NULL;

-- FINLYNQ-136 — Loans & Debt v2 (Phases 1-3)
-- 1) Lease residual/buyout value: the amortization schedule runs the balance
--    down to this instead of 0 (balance at term end == residual).
-- 2) term_months becomes nullable: payment-driven loans solve for the term
--    from payment_amount + frequency. Application layer enforces that at
--    least one of (term_months, payment_amount) is set.
-- Variable rates stay out of scope (a future rate-schedule table/JSONB can
-- slot in additively without touching these columns).

ALTER TABLE loans ADD COLUMN IF NOT EXISTS residual_value DOUBLE PRECISION;
ALTER TABLE loans ALTER COLUMN term_months DROP NOT NULL;

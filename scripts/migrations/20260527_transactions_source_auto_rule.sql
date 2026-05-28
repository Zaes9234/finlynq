-- Reconcile v4 Phase 4 — transactions.source CHECK extension for 'auto_rule'
-- (plan/reconcile-v4-account-anchored-inbox.md, 2026-05-27).
--
-- The Auto-pilot pipeline (accounts.mode='auto') fires user rules at the
-- upload→bank step. Rows that match a rule are immediately materialized
-- to `transactions` with `source = 'auto_rule'` — distinct from 'manual'
-- (Approve-each, user clicked Approve), 'reconcile_link' (Manual lens
-- materialize), and 'import' (legacy direct-to-tx path).
--
-- The audit trail surface: the Reconciled tab on /inbox renders a 'rule'
-- pill on rows whose source matches, and the "X rows auto-applied" banner
-- queries `WHERE source = 'auto_rule' AND created_at > now() - interval '7d'`.
--
-- Idempotent: drop the old constraint if present, then add fresh. Mirrors
-- the pattern in scripts/migrations/20260602_backfill_pipeline.sql:138.
-- The 10 allowed values mirror the SOURCES tuple in src/lib/tx-source.ts.
--
-- Pure additive: extends an existing CHECK to allow one more value. No
-- data migration; pre-existing rows keep their original source. The
-- runner in deploy.sh wraps the file in a transaction with the
-- schema_migrations bookkeeping insert — do NOT add a BEGIN/COMMIT here.

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_source_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_source_check
    CHECK (source IN ('manual','import','mcp_http','mcp_stdio',
                      'connector','sample_data','backup_restore',
                      'reconcile_link','backfill_synth','auto_rule'));

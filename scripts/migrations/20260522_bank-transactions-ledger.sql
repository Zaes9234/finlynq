-- Two-ledger import refactor (FINLYNQ-XX, 2026-05-22).
--
-- Adds a persistent bank-side ledger that records every row from every
-- statement the user has ever approved. Re-importing an already-approved
-- row silently bumps seen_count / last_seen_at / source_filenames instead
-- of overwriting anything — `bank_transactions` is content-immutable once
-- written.
--
-- The system-side `transactions` table is unchanged in shape except for a
-- new nullable `bank_transaction_id` lineage FK. Import-sourced INSERTs
-- (executeImport, createTransferPair, approve route's three buckets) stamp
-- the FK so user edits to the transaction can be reconciled back to the
-- bank's literal record without overwriting either side.
--
-- The dedup source-of-truth for future imports moves from
-- `transactions.import_hash` to `bank_transactions.import_hash` — a deleted
-- transaction no longer creates a re-import gap; the bank ledger remembers.
-- This migration also backfills bank_transactions from every existing
-- transaction with `import_hash IS NOT NULL AND account_id IS NOT NULL AND
-- source IN ('upload','email','connector')`. Same-day duplicates within
-- the same (user, account, import_hash) bucket get distinct
-- `occurrence_index` values via ROW_NUMBER().
--
-- The F-53E overlap-merge prompt (lines 547-580 in
-- src/app/api/import/staging/upload/route.ts and the MergeCandidate dialog
-- in src/app/(app)/import/reconcile/page.tsx) becomes redundant once the
-- new dedup source goes live — that deletion ships in a later phase.
--
-- Pure additive: no DROP, no NOT NULL on existing rows without a default.
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

-- ─── bank_transactions: the persistent bank-side ledger ──────────────────

CREATE TABLE IF NOT EXISTS bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Existing import_hash semantics: SHA256(date|accountId|amount|payee.lower).
  -- Computed once at ingest from PLAINTEXT payee; never recomputed.
  import_hash TEXT NOT NULL,
  -- Disambiguates intentional same-day duplicates (two $5 coffees on the
  -- same card, same day, same payee). Within a single (user, account,
  -- import_hash) bucket, ROW_NUMBER() at parse time assigns 0, 1, 2, …
  -- across the batch.
  occurrence_index INTEGER NOT NULL DEFAULT 0,
  -- OFX FITID when present. Bank-supplied unique id — primary dedup key
  -- BEFORE the (date, amount, payee) hash falls back. NULL for CSV/PDF
  -- formats that lack it.
  fit_id TEXT,
  -- Matches transactions.date — stored as YYYY-MM-DD TEXT rather than the
  -- native DATE type for cross-app consistency.
  date TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL,
  -- Cross-currency rows (issue #129) — amount in the entered currency when
  -- it differs from the account currency. Locked at ingest.
  entered_amount DOUBLE PRECISION,
  entered_currency TEXT,
  entered_fx_rate DOUBLE PRECISION,
  -- For investment-trade rows.
  quantity DOUBLE PRECISION,
  -- Encrypted-in-place text. Two-tier:
  --   - 'service' (default at ingest): wrapped with PF_STAGING_KEY (sv1:),
  --     readable by anyone with the env var + DB. Used by email webhook
  --     ingest where no user DEK is in scope.
  --   - 'user': wrapped with the user's DEK (v1:), readable only by that
  --     user. Approve-time ingest uses this directly; the login-time
  --     upgrade job (upgradeStagingEncryption) flips service-tier rows
  --     to user-tier when the DEK becomes available.
  -- Read paths branch on `encryption_tier` to pick decryptStaged() vs
  -- tryDecryptField(dek, ...) — same pattern as staged_transactions.
  payee TEXT NOT NULL,
  note TEXT,
  tags TEXT,
  -- Free-text account label from the source file's header (e.g. "Chase
  -- 4242"). Display-only — the `account_id` FK is the truth. Lets the UI
  -- surface "originally from <bank's name>" when the user later moves a
  -- transaction to a different account.
  account_name TEXT,
  encryption_tier TEXT NOT NULL DEFAULT 'service',
  source TEXT NOT NULL,
  -- Append-only history of when this row was first observed, when it was
  -- last re-observed (re-uploaded), how many times we've seen it, and the
  -- filename(s) it appeared in. The Plan agent caught that the upsert
  -- predicate must ALWAYS push exactly one element per re-import via
  -- array_append(EXCLUDED.source_filenames[1]), so the caller MUST pass
  -- the new filename as a single-element TEXT[].
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count INTEGER NOT NULL DEFAULT 1,
  source_filenames TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Lineage hint — which staged_imports row first introduced this bank
  -- transaction. NULL for backfilled rows and for direct-import paths
  -- (legacy self-hosted email webhook + backup-restore) that bypass
  -- staging. ON DELETE SET NULL because staged_imports rows are TTL'd at
  -- 60 days; the bank ledger outlives them.
  original_staged_import_id TEXT REFERENCES staged_imports(id) ON DELETE SET NULL
);

-- CHECK constraints — guard via pg_constraint since Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS (mirrors 20260506_staging_unified_columns.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_transactions_encryption_tier_check'
  ) THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT bank_transactions_encryption_tier_check
      CHECK (encryption_tier IN ('service','user'));
  END IF;
END $$;

-- Source enumeration — strict subset of the SOURCES tuple in
-- src/lib/tx-source.ts. Excludes 'manual', 'mcp_http', 'mcp_stdio',
-- 'sample_data' because manual entries never carry bank-statement lineage;
-- they go straight to `transactions` with NULL bank_transaction_id. The
-- bank ledger receives writes only from 'import' (CSV/PDF/OFX/email
-- approve), 'connector' (automated pulls), and 'backup_restore' (which
-- preserves the original lineage from the backup JSON). Keep this in
-- lockstep with the BANK_LEDGER_SOURCES tuple in src/lib/bank-ledger.ts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_transactions_source_check'
  ) THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT bank_transactions_source_check
      CHECK (source IN ('import','connector','backup_restore'));
  END IF;
END $$;

-- Primary dedup key. Includes occurrence_index so two identical rows
-- legitimately uploaded together don't collapse via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_hash
  ON bank_transactions (user_id, account_id, import_hash, occurrence_index);

-- Fallback dedup key when the bank provides a FITID. Partial — fit_id NULL
-- rows fall back to the import_hash key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_fit
  ON bank_transactions (user_id, account_id, fit_id)
  WHERE fit_id IS NOT NULL;

-- Range-scan path for the future "show me my bank ledger for account X"
-- UI (Phase 7, deferred). Ordered DESC because the UI is reverse-chrono.
CREATE INDEX IF NOT EXISTS idx_bank_tx_account_date
  ON bank_transactions (user_id, account_id, date DESC);

-- ─── transactions.bank_transaction_id — lineage FK ───────────────────────

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS bank_transaction_id UUID;

-- FK guard via pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_bank_transaction_id_fkey'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_bank_transaction_id_fkey
      FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_bank_tx
  ON transactions (bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

-- ─── Backfill: existing import-sourced transactions → bank_transactions ──
--
-- Idempotent: the WHERE clause skips rows that already have
-- `bank_transaction_id` set (re-running the migration is a no-op). The
-- ON CONFLICT DO NOTHING handles the same idempotency at the bank-side
-- unique index.
--
-- Edge cases:
--   - `import_hash IS NULL` rows (pre-audit-trio manual entries, or rows
--     created before issue #28's audit trio): SKIPPED. These are orphan
--     `transactions` rows that stay with NULL bank_transaction_id.
--   - `account_id IS NULL` rows: SKIPPED. The bank ledger requires
--     account_id (NULL would break the unique index since Postgres treats
--     NULLs as distinct).
--   - source IN ('manual','mcp_http','mcp_stdio','sample_data','backup_restore'):
--     SKIPPED. Manual entries don't have bank-statement lineage. Backup-
--     restore rows carry their original lineage in the backup JSON (the
--     new backup-restore code will remap that explicitly — see Phase 5).
--   - Same-day, same-account, same-payee, same-amount rows: ROW_NUMBER()
--     OVER (PARTITION BY user_id, account_id, import_hash ORDER BY id)
--     assigns occurrence_index 0, 1, 2, … so each row gets its own bank
--     ledger record.

-- Single-pass CTE. `backfill` computes the candidate row set + per-row
-- occurrence_index. `upserted` INSERTs into bank_transactions; ON CONFLICT
-- triggers a no-op DO UPDATE so RETURNING fires for both new inserts AND
-- pre-existing bank rows from a prior partial run — that's the idempotency
-- hinge. The outer UPDATE re-joins `upserted` with `backfill` to get the
-- (tx_id → bank_id) pairs and writes the FK.
WITH backfill AS (
  SELECT
    t.id AS tx_id,
    t.user_id,
    t.account_id,
    t.import_hash,
    t.fit_id,
    t.date,
    t.amount,
    t.currency,
    t.entered_amount,
    t.entered_currency,
    t.entered_fx_rate,
    t.quantity,
    t.payee,
    t.note,
    t.tags,
    t.source,
    t.created_at,
    COALESCE(t.updated_at, t.created_at) AS last_at,
    (ROW_NUMBER() OVER (
      PARTITION BY t.user_id, t.account_id, t.import_hash
      ORDER BY t.id
    ) - 1)::INTEGER AS occurrence_index
  FROM transactions t
  WHERE t.import_hash IS NOT NULL
    AND t.account_id IS NOT NULL
    AND t.bank_transaction_id IS NULL
    AND t.source IN ('upload','email','connector')
),
upserted AS (
  INSERT INTO bank_transactions (
    user_id, account_id, import_hash, occurrence_index, fit_id, date,
    amount, currency, entered_amount, entered_currency, entered_fx_rate,
    quantity, payee, note, tags, encryption_tier, source,
    first_seen_at, last_seen_at, seen_count, source_filenames
  )
  SELECT
    b.user_id,
    b.account_id,
    b.import_hash,
    b.occurrence_index,
    b.fit_id,
    b.date,
    b.amount,
    b.currency,
    b.entered_amount,
    b.entered_currency,
    b.entered_fx_rate,
    b.quantity,
    COALESCE(b.payee, ''),
    b.note,
    b.tags,
    -- Pre-existing transactions are written under the user's DEK already
    -- (transactions.payee uses the v1: envelope; the encrypted-in-place
    -- text column lookup-falls-back to plaintext for legacy rows). We
    -- mark every backfilled row as 'user' tier so the read path goes
    -- through tryDecryptField(dek, ...). Service-tier is only relevant
    -- for the email-webhook-ingest path going forward; no historical row
    -- is service-tier.
    'user' AS encryption_tier,
    b.source,
    b.created_at,
    b.last_at,
    1,
    ARRAY[]::TEXT[]
  FROM backfill b
  ON CONFLICT (user_id, account_id, import_hash, occurrence_index)
  -- No-op assignment so RETURNING fires for the existing row's id. This
  -- is the canonical Postgres "upsert + return id" trick — the bumped
  -- last_seen_at is overwritten with its own current value, no change to
  -- seen_count or source_filenames (backfill represents historical state,
  -- not a re-ingest event).
  DO UPDATE SET last_seen_at = bank_transactions.last_seen_at
  RETURNING
    id AS bank_id, user_id, account_id, import_hash, occurrence_index
)
UPDATE transactions t
SET bank_transaction_id = u.bank_id
FROM upserted u
JOIN backfill b
  ON b.user_id = u.user_id
 AND b.account_id = u.account_id
 AND b.import_hash = u.import_hash
 AND b.occurrence_index = u.occurrence_index
WHERE t.id = b.tx_id;

-- FINLYNQ-271 phase 2 — file-level content hash for idempotent MCP statement uploads.
--
-- Additive only (auto-applied by deploy.sh; NO destructive statements). Adds a
-- nullable plaintext sha256 (hex) of the raw uploaded file bytes to
-- staged_imports, plus a partial index to make the pending-scoped dedup probe
-- (`upload_statement`: WHERE user_id = $1 AND content_hash = $2 AND status =
-- 'pending'`) an index lookup. NULL for the web upload route (hash-less) and
-- every pre-existing row. DISTINCT from `import_hash` (row-level, over the
-- plaintext payee) — this is a whole-file hash, never conflated with it.

ALTER TABLE staged_imports
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS staged_imports_user_hash_idx
  ON staged_imports (user_id, content_hash)
  WHERE content_hash IS NOT NULL;

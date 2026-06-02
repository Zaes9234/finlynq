/**
 * User-DEK-encrypted column registry (2026-06-01).
 *
 * Single source of truth for "which free-text columns are user-DEK encrypted
 * envelopes". Drives:
 *   - the login sweep (`upgradeUserFieldEncryption`, Phase 5) which re-encrypts
 *     any remaining plaintext (legacy / stdio / email-import rows), and
 *   - the audit invariant (Phase 6) that guards against new plaintext writers.
 *
 * Scope is the `note`/`notes`/`payee` free-text columns plus the transaction +
 * split columns that were already encrypted before this plan. Transaction
 * RULES are NOT in this list — their sensitive fields live inside JSONB and are
 * handled by `src/lib/rules/crypto.ts` + a dedicated sweep branch.
 *
 * Stream D display-`name` columns are intentionally NOT here: post-Phase-4
 * there is no plaintext name column left to sweep (they were physically
 * dropped), and they carry a `name_lookup` HMAC sibling that the generic
 * envelope sweep would not maintain.
 *
 * See plan/encryption-plaintext-gaps.md.
 */

export type UserEncryptedKind = "envelope";

export interface UserEncryptedColumn {
  /** PostgreSQL table name (snake_case, matches the physical schema). */
  table: string;
  /** PostgreSQL column name (snake_case). */
  column: string;
  kind: UserEncryptedKind;
}

/**
 * Every user-owned free-text column that is a v1: envelope at rest.
 *
 * Table/column names are the PHYSICAL (snake_case) names so the sweep can build
 * raw SQL and the audit invariant can grep source for the matching Drizzle
 * camelCase writers. The registry is keyed by physical names because the sweep
 * issues `SELECT id, <col> FROM <table> WHERE <col> NOT LIKE 'v1:%'` directly.
 */
export const USER_ENCRYPTED_COLUMNS: ReadonlyArray<UserEncryptedColumn> = [
  // Pre-existing scope (encrypted before this plan; included so the sweep
  // also mops up the 72/144 legacy + stdio-written plaintext payees/notes).
  { table: "transactions", column: "payee", kind: "envelope" },
  { table: "transactions", column: "note", kind: "envelope" },
  { table: "transactions", column: "tags", kind: "envelope" },
  { table: "transaction_splits", column: "note", kind: "envelope" },
  { table: "transaction_splits", column: "description", kind: "envelope" },
  { table: "transaction_splits", column: "tags", kind: "envelope" },
  // New scope (this plan) — free-text note columns.
  { table: "loans", column: "note", kind: "envelope" },
  { table: "goals", column: "note", kind: "envelope" },
  { table: "snapshots", column: "note", kind: "envelope" },
  { table: "subscriptions", column: "notes", kind: "envelope" },
  { table: "fx_overrides", column: "note", kind: "envelope" },
  { table: "contribution_room", column: "note", kind: "envelope" },
  { table: "recurring_transactions", column: "payee", kind: "envelope" },
  { table: "recurring_transactions", column: "note", kind: "envelope" },
  // MCP-write-only free-text notes (no REST writer, never displayed today, but
  // the MCP add_*/update_* tools encrypt them at the source — keep them swept so
  // legacy plaintext MCP-written notes don't survive a DB leak. Plan Phase 2
  // explicitly lists add_account / update_account / create_category as note
  // writers; the legacy `net_worth_snapshots.note` (add_snapshot) is encrypted
  // at write but deliberately NOT swept — it is a pre-Drizzle raw table that is
  // never read back and may not exist on every deployment.)
  { table: "accounts", column: "note", kind: "envelope" },
  { table: "categories", column: "note", kind: "envelope" },
];

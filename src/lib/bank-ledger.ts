/**
 * Bank-ledger upsert helper — single chokepoint for writes to the
 * `bank_transactions` persistent ledger (2026-05-22, two-ledger refactor).
 *
 * Every import-sourced INSERT into `transactions` must call this BEFORE
 * inserting the transaction, then stamp the returned id onto
 * `transactions.bank_transaction_id`. Manual entries (REST POST
 * /transactions, MCP HTTP record_transaction / bulk_record_transactions /
 * record_transfer / record_trade) bypass this helper and leave the FK NULL.
 *
 * Tier selection: if `dek` is non-null, the row writes at user-tier (v1:
 * envelope under the user's DEK). If `dek` is null, the row writes at
 * service-tier (sv1: envelope under PF_STAGING_KEY) — only used by the
 * email-webhook ingest path. The login-time `upgradeStagingEncryption`
 * job re-encrypts service-tier rows under the user's DEK once it becomes
 * available.
 *
 * Idempotency: ON CONFLICT (user_id, account_id, import_hash,
 * occurrence_index) DO UPDATE bumps `last_seen_at`, increments
 * `seen_count`, and appends to `source_filenames`. Content columns
 * (`import_hash`, `fit_id`, `date`, `amount`, `payee`, etc.) are NEVER
 * updated on conflict — `bank_transactions` is content-immutable once
 * written.
 *
 * Returns `{ id, wasInserted }` so callers can distinguish a fresh ledger
 * entry from a re-import hit (used by the staging-upload preview to flag
 * `reconcile_state='skipped_duplicate'` on the staged row).
 *
 * See CLAUDE.md "Two-ledger import model" + docs/architecture/bank-ledger.md.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { encryptField } from "@/lib/crypto/envelope";
import { encryptStaged } from "@/lib/crypto/staging-envelope";
import { SOURCES, type TransactionSource } from "@/lib/tx-source";

/**
 * Source attribution for a bank-ledger row. Strict subset of the SOURCES
 * tuple in src/lib/tx-source.ts — manual entries ('manual', 'mcp_http',
 * 'mcp_stdio', 'sample_data') never carry bank-statement lineage and go
 * straight to `transactions` with NULL `bank_transaction_id`. The bank
 * ledger receives writes only from 'import' (CSV/PDF/OFX/email approve),
 * 'connector' (automated pulls), and 'backup_restore' (which preserves
 * the original lineage). Keep this in lockstep with the SQL CHECK
 * constraint in scripts/migrations/20260522_bank-transactions-ledger.sql.
 */
export const BANK_LEDGER_SOURCES = [
  "import",
  "connector",
  "backup_restore",
] as const satisfies readonly TransactionSource[];

export type BankLedgerSource = (typeof BANK_LEDGER_SOURCES)[number];

const BANK_LEDGER_SOURCE_SET = new Set<string>(BANK_LEDGER_SOURCES);

export function isBankLedgerSource(v: unknown): v is BankLedgerSource {
  return typeof v === "string" && BANK_LEDGER_SOURCE_SET.has(v);
}

// Silence the unused-import lint when SOURCES is only referenced for its type.
void SOURCES;

/**
 * Input shape for {@link upsertBankTransaction}. Payee/note/tags/accountName
 * are PLAINTEXT — the helper handles encryption based on tier. `filename`
 * is a single string (the helper wraps it into a single-element array for
 * the upsert).
 */
export interface BankLedgerRowInput {
  userId: string;
  accountId: number;
  /** SHA256 hash from {@link generateImportHash}. */
  importHash: string;
  /**
   * 0-based offset within a (user, account, import_hash) group. Caller
   * computes via ROW_NUMBER() on the parsed batch — distinct rows whose
   * (date, amount, payee) collide get distinct indexes so they each land
   * as separate bank-ledger entries.
   */
  occurrenceIndex: number;
  fitId?: string | null;
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
  currency: string;
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
  quantity?: number | null;
  payee: string;
  note?: string | null;
  tags?: string | null;
  /** Free-text account label from the source file's header. */
  accountName?: string | null;
  source: BankLedgerSource;
  /** Source filename. Wrapped into a single-element array. */
  filename?: string | null;
  /** Optional lineage hint — the staged_imports row that introduced this. */
  originalStagedImportId?: string | null;
}

export interface BankLedgerUpsertResult {
  id: string;
  wasInserted: boolean;
}

/**
 * Insert-or-bump a bank_transactions row.
 *
 * @param dek - User's DEK for user-tier writes; null for service-tier
 *              (email-webhook ingest path).
 */
export async function upsertBankTransaction(
  dek: Buffer | null,
  row: BankLedgerRowInput,
): Promise<BankLedgerUpsertResult> {
  const tier = dek ? "user" : "service";

  // Encrypt the four ciphertext columns. Empty strings stay empty (matches
  // encryptField behavior). NULL stays NULL.
  const payee = dek ? encryptField(dek, row.payee) ?? "" : encryptStaged(row.payee) ?? "";
  const note =
    row.note == null ? null : dek ? encryptField(dek, row.note) : encryptStaged(row.note);
  const tags =
    row.tags == null ? null : dek ? encryptField(dek, row.tags) : encryptStaged(row.tags);
  const accountName =
    row.accountName == null
      ? null
      : dek
        ? encryptField(dek, row.accountName)
        : encryptStaged(row.accountName);

  // Single-element array — array_append(EXCLUDED.source_filenames[1], …)
  // on conflict.
  const filenames = row.filename ? [row.filename] : [];

  // The `xmax = 0` trick distinguishes a fresh INSERT from an ON CONFLICT
  // UPDATE — xmax is 0 for newly-inserted tuples and non-0 for the
  // previously-committed tuple being touched.
  const result = await db.execute(sql`
    INSERT INTO bank_transactions (
      user_id, account_id, import_hash, occurrence_index, fit_id, date,
      amount, currency, entered_amount, entered_currency, entered_fx_rate,
      quantity, payee, note, tags, account_name, encryption_tier, source,
      source_filenames, original_staged_import_id
    )
    VALUES (
      ${row.userId},
      ${row.accountId},
      ${row.importHash},
      ${row.occurrenceIndex},
      ${row.fitId ?? null},
      ${row.date},
      ${row.amount},
      ${row.currency},
      ${row.enteredAmount ?? null},
      ${row.enteredCurrency ?? null},
      ${row.enteredFxRate ?? null},
      ${row.quantity ?? null},
      ${payee},
      ${note},
      ${tags},
      ${accountName},
      ${tier},
      ${row.source},
      ${filenames}::TEXT[],
      ${row.originalStagedImportId ?? null}
    )
    ON CONFLICT (user_id, account_id, import_hash, occurrence_index)
    DO UPDATE SET
      last_seen_at = NOW(),
      seen_count = bank_transactions.seen_count + 1,
      source_filenames = CASE
        WHEN EXCLUDED.source_filenames = ARRAY[]::TEXT[] THEN bank_transactions.source_filenames
        ELSE array_append(bank_transactions.source_filenames, EXCLUDED.source_filenames[1])
      END
    RETURNING id, (xmax = 0) AS was_inserted
  `);

  // Normalize result shape — pg drivers return { rows: [...] }, some
  // adapters return the array directly (mirrors the pattern in
  // src/lib/dividends-category.ts). Coerce via unknown to bypass the
  // generic-row typing on the QueryResult shape.
  const asUnknown = result as unknown;
  let rows: Array<{ id: string; was_inserted: boolean }> = [];
  if (asUnknown && typeof asUnknown === "object") {
    const maybeRows = (asUnknown as { rows?: unknown }).rows;
    if (Array.isArray(maybeRows)) {
      rows = maybeRows as Array<{ id: string; was_inserted: boolean }>;
    } else if (Array.isArray(asUnknown)) {
      rows = asUnknown as Array<{ id: string; was_inserted: boolean }>;
    }
  }
  if (rows.length === 0) {
    throw new Error("upsertBankTransaction: no row returned from RETURNING clause");
  }
  return { id: rows[0].id, wasInserted: rows[0].was_inserted };
}

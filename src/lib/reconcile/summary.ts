/**
 * Reconciliation summary (FINLYNQ-147, 2026-06-12).
 *
 * Per-account "what's up to date / what's stale" snapshot for the /import
 * reconcile surface. Everything here is DERIVED from existing tables — no
 * new column (per the item's lean):
 *
 *   - lastImportAt     = MAX(bank_upload_batches.uploaded_at) for the account.
 *                        The most recent statement/email/connector import.
 *   - lastReconciledAt = MAX(transactions.created_at) over rows whose
 *                        bank_transaction_id lineage FK is set (i.e. a bank
 *                        row was materialized into the ledger). This is the
 *                        last reconcile/materialize event.
 *   - pendingCount     = bank_transactions for the account with NO referencing
 *                        ledger transaction yet (unreconciled rows). Cheap
 *                        NOT EXISTS anti-join.
 *
 * Names are resolved by the API boundary (decrypt + safeAccountName), NOT
 * here — this core stays DEK-free.
 */

import { db, schema } from "@/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export interface ReconcileSummaryRow {
  accountId: number;
  /** ISO timestamp of the most recent import batch, or null. */
  lastImportAt: string | null;
  /** ISO timestamp of the most recent materialize/reconcile event, or null. */
  lastReconciledAt: string | null;
  /** Count of bank-ledger rows not yet materialized into a ledger transaction. */
  pendingCount: number;
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  // pg may hand back a string already.
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Returns one summary row per account that has EITHER an import batch OR a
 * bank-ledger row. Accounts with no money-in activity are omitted (the UI
 * shows them implicitly as "no imports yet" only if it chooses to merge with
 * the full accounts list — callers decide). DEK-free.
 */
export async function getReconcileSummary(
  userId: string,
): Promise<ReconcileSummaryRow[]> {
  // Last import per account.
  const importRows = await db
    .select({
      accountId: schema.bankUploadBatches.accountId,
      lastImportAt: sql<
        string | null
      >`MAX(${schema.bankUploadBatches.uploadedAt})`.as("last_import_at"),
    })
    .from(schema.bankUploadBatches)
    .where(eq(schema.bankUploadBatches.userId, userId))
    .groupBy(schema.bankUploadBatches.accountId);

  // Last reconcile (materialize) event per account — transactions carrying a
  // bank_transaction_id lineage FK.
  const reconciledRows = await db
    .select({
      accountId: schema.transactions.accountId,
      lastReconciledAt: sql<
        string | null
      >`MAX(${schema.transactions.createdAt})`.as("last_reconciled_at"),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        isNotNull(schema.transactions.bankTransactionId),
      ),
    )
    .groupBy(schema.transactions.accountId);

  // Pending (unreconciled) bank rows per account — no ledger transaction
  // references the bank row yet.
  const pendingRows = await db
    .select({
      accountId: schema.bankTransactions.accountId,
      pendingCount: sql<number>`COUNT(*)`.as("pending_count"),
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.userId, userId),
        sql`NOT EXISTS (SELECT 1 FROM transactions t WHERE t.bank_transaction_id = ${schema.bankTransactions.id})`,
      ),
    )
    .groupBy(schema.bankTransactions.accountId);

  const byAccount = new Map<number, ReconcileSummaryRow>();
  const ensure = (accountId: number | null): ReconcileSummaryRow | null => {
    if (accountId == null) return null;
    let row = byAccount.get(accountId);
    if (!row) {
      row = {
        accountId,
        lastImportAt: null,
        lastReconciledAt: null,
        pendingCount: 0,
      };
      byAccount.set(accountId, row);
    }
    return row;
  };

  for (const r of importRows) {
    const row = ensure(r.accountId);
    if (row) row.lastImportAt = toIso(r.lastImportAt);
  }
  for (const r of reconciledRows) {
    const row = ensure(r.accountId);
    if (row) row.lastReconciledAt = toIso(r.lastReconciledAt);
  }
  for (const r of pendingRows) {
    const row = ensure(r.accountId);
    if (row) row.pendingCount = Number(r.pendingCount) || 0;
  }

  return [...byAccount.values()];
}

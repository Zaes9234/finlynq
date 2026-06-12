/**
 * GET /api/reconcile/summary — per-account reconciliation summary
 * (FINLYNQ-147, 2026-06-12).
 *
 * Powers the "what's up to date / what's stale" panel on /import. Each row:
 *   { accountId, accountName, currency, archived, isInvestment,
 *     hidden, lastImportAt, lastReconciledAt, pendingCount }
 *
 * All money-in figures are DERIVED from existing tables (bank_upload_batches +
 * transactions.bank_transaction_id lineage + bank_transactions anti-join) — no
 * new column. Account names are decrypted at this boundary; the summary core
 * stays DEK-free. Reads use requireAuth (nullable DEK) per the read/write split.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getAccounts } from "@/lib/queries";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { safeAccountName } from "@/lib/safe-name";
import { getReconcileSummary } from "@/lib/reconcile/summary";
import { getReconcileHiddenAccountIds } from "@/lib/reconcile/hidden-accounts";
import { safeErrorMessage, logApiError } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;

  try {
    // Include archived so the summary can surface stale archived accounts;
    // the UI labels them. (The dropdown still hides archived separately.)
    const rawAccounts = await getAccounts(userId, { includeArchived: true });
    // decryptNamedRows writes the decrypted `name`/`alias` onto the rows at
    // runtime (the plaintext columns were physically dropped in Stream D
    // Phase 4, so they're not in the static row type — cast through unknown,
    // mirroring how /api/accounts ships the same shape to JSON).
    const accounts = decryptNamedRows(rawAccounts, dek, {
      nameCt: "name",
      aliasCt: "alias",
    }) as unknown as Array<{
      id: number;
      name: string | null;
      alias?: string | null;
      currency: string;
      archived?: boolean;
      isInvestment?: boolean;
    }>;

    const [summary, hidden] = await Promise.all([
      getReconcileSummary(userId),
      getReconcileHiddenAccountIds(userId),
    ]);
    const summaryByAccount = new Map(summary.map((s) => [s.accountId, s]));
    const hiddenSet = new Set(hidden);

    const rows = accounts.map((a) => {
      const s = summaryByAccount.get(a.id);
      return {
        accountId: a.id,
        accountName: safeAccountName(a),
        currency: a.currency,
        archived: a.archived === true,
        isInvestment: a.isInvestment === true,
        hidden: hiddenSet.has(a.id),
        lastImportAt: s?.lastImportAt ?? null,
        lastReconciledAt: s?.lastReconciledAt ?? null,
        pendingCount: s?.pendingCount ?? 0,
      };
    });

    return NextResponse.json({ rows });
  } catch (error: unknown) {
    await logApiError("GET", "/api/reconcile/summary", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load reconcile summary") },
      { status: 500 },
    );
  }
}

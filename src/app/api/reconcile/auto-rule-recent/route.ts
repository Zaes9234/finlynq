/**
 * GET /api/reconcile/auto-rule-recent?accountId=<id>&days=7
 *
 * Inbox v4 Phase 4 (2026-05-27) — feeds the "X rows auto-applied by rules
 * in the last 7 days" banner on /inbox's Reconciled tab when the lens is
 * 'auto'. Returns the recent rule-fired tx rows for the selected account
 * so the UI can render the banner and let the user click into the
 * transaction edit dialog to override a misattribution.
 *
 * Response shape (success envelope per CLAUDE.md #237):
 *   { success: true, data: {
 *       count: number,
 *       windowDays: number,
 *       items: Array<{
 *         id: number,
 *         date: string,
 *         amount: number,
 *         currency: string,
 *         payee: string | null,
 *         categoryName: string | null,
 *         bankTransactionId: string | null,
 *         createdAt: string,
 *       }>
 *     }
 *   }
 *
 * Limited to 25 rows so a power user's batch upload doesn't render an
 * unbounded list. The banner shows the count and the first ~5; "View
 * all" jumps to /transactions with a source=auto_rule filter (existing
 * column on the transactions table).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { tryDecryptField } from "@/lib/crypto/envelope";

export const dynamic = "force-dynamic";

const MAX_ITEMS = 25;
const DEFAULT_DAYS = 7;

export async function GET(request: NextRequest) {
  // Reads use requireAuth (nullable DEK) per CLAUDE.md "Reads use
  // requireAuth() + nullable DEK; writes use requireEncryption(); 423 if
  // no DEK". A null DEK means decrypted payee/category come back as null.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;

  const url = new URL(request.url);
  const accountIdParam = url.searchParams.get("accountId");
  const daysParam = url.searchParams.get("days");

  const accountId = accountIdParam ? Number.parseInt(accountIdParam, 10) : NaN;
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return NextResponse.json(
      { error: "Missing or invalid accountId" },
      { status: 400 },
    );
  }
  const windowDays = (() => {
    if (!daysParam) return DEFAULT_DAYS;
    const n = Number.parseInt(daysParam, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 90) return DEFAULT_DAYS;
    return n;
  })();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      payee: schema.transactions.payee,
      bankTransactionId: schema.transactions.bankTransactionId,
      createdAt: schema.transactions.createdAt,
      categoryNameCt: schema.categories.nameCt,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.accountId, accountId),
        eq(schema.transactions.source, "auto_rule"),
        gte(schema.transactions.createdAt, since),
      ),
    )
    .orderBy(desc(schema.transactions.createdAt))
    .limit(MAX_ITEMS)
    .all();

  const items = rows.map((r) => ({
    id: r.id,
    date: r.date,
    amount: r.amount,
    currency: r.currency,
    payee:
      r.payee && r.payee.startsWith("v1:") && dek
        ? tryDecryptField(dek, r.payee, "transactions.payee")
        : (r.payee ?? null),
    categoryName:
      r.categoryNameCt && dek
        ? tryDecryptField(dek, r.categoryNameCt, "categories.name_ct")
        : null,
    bankTransactionId: r.bankTransactionId,
    createdAt: r.createdAt.toISOString(),
  }));

  return NextResponse.json({
    success: true,
    data: {
      count: items.length,
      windowDays,
      items,
    },
  });
}

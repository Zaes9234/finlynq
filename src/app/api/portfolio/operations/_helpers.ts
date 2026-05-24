/**
 * Shared error → HTTP response mapping for /api/portfolio/operations/* routes.
 *
 * Each route delegates to the corresponding helper in
 * src/lib/portfolio/operations.ts; this file maps the domain errors those
 * helpers throw into structured 400 responses.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  CashSleeveNotFoundError,
  CurrencyMismatchError,
  HoldingNotFoundError,
  InvalidLinkPairError,
  canEditPortfolioRow,
} from "@/lib/portfolio/operations";
import { reverseLotsForDeleteHook } from "@/lib/portfolio/lots/write-hooks";
import { deleteTransaction } from "@/lib/queries";

export function mapOperationError(err: unknown): NextResponse | null {
  if (err instanceof CashSleeveNotFoundError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        accountId: err.accountId,
        currency: err.currency,
      },
      { status: 400 },
    );
  }
  if (err instanceof CurrencyMismatchError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        expected: err.expected,
        got: err.got,
      },
      { status: 400 },
    );
  }
  if (err instanceof HoldingNotFoundError) {
    return NextResponse.json(
      { error: err.message, code: err.code, holdingId: err.holdingId },
      { status: 404 },
    );
  }
  if (err instanceof InvalidLinkPairError) {
    return NextResponse.json(
      { error: err.message, code: "invalid_link_pair" },
      { status: 400 },
    );
  }
  return null;
}

/**
 * Edit-as-replace helper for the operation POST routes (2026-05-25 follow-up).
 *
 * When the client passes `editId` in the body of a POST to
 * `/api/portfolio/operations/<op>`, we treat it as "replace the existing pair
 * with new values". The cleanest semantics:
 *
 *   1. Verify the editId tx belongs to this user.
 *   2. Run the edit guard — refuse with 409 if the row opens a lot that has
 *      downstream closures (sell or transfer-out) we'd orphan.
 *   3. Cascade-delete the existing pair (every row sharing trade_link_id /
 *      link_id), reversing lot effects first.
 *   4. Caller then runs the normal `recordX` helper which creates a fresh
 *      pair with the new values.
 *
 * Returns NextResponse on refusal/error; null when the caller may proceed.
 */
export async function cascadeDeleteForReplace(
  userId: string,
  editId: number,
): Promise<NextResponse | null> {
  const target = await db
    .select({
      id: schema.transactions.id,
      tradeLinkId: schema.transactions.tradeLinkId,
      linkId: schema.transactions.linkId,
      swapLinkId: schema.transactions.swapLinkId,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.id, editId),
        eq(schema.transactions.userId, userId),
      ),
    )
    .get();
  if (!target) {
    return NextResponse.json(
      { error: `Transaction ${editId} not found` },
      { status: 404 },
    );
  }
  const idSet = new Set<number>([editId]);
  if (target.tradeLinkId) {
    const siblings = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.tradeLinkId, target.tradeLinkId),
        ),
      );
    for (const r of siblings) idSet.add(r.id);
  }
  if (target.linkId) {
    const siblings = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.linkId, target.linkId),
        ),
      );
    for (const r of siblings) idSet.add(r.id);
  }
  // Phase 4 — swap_link_id ties the 4 rows of a swap; cascade across
  // their inner tradeLinkIds too so all stock+cash legs land in the set.
  if (target.swapLinkId) {
    const siblings = await db
      .select({
        id: schema.transactions.id,
        tradeLinkId: schema.transactions.tradeLinkId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.swapLinkId, target.swapLinkId),
        ),
      );
    for (const r of siblings) idSet.add(r.id);
    const tradeLinks = new Set(
      siblings.map((r) => r.tradeLinkId).filter((v): v is string => !!v),
    );
    for (const tl of tradeLinks) {
      const more = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.tradeLinkId, tl),
          ),
        );
      for (const r of more) idSet.add(r.id);
    }
  }
  const allIds = Array.from(idSet);

  const blockingClosureTxIds: number[] = [];
  for (const txId of allIds) {
    const guard = await canEditPortfolioRow(userId, txId);
    if (!guard.allowed && guard.blockingClosureTxIds) {
      for (const b of guard.blockingClosureTxIds) {
        if (!idSet.has(b)) blockingClosureTxIds.push(b);
      }
    }
  }
  if (blockingClosureTxIds.length > 0) {
    return NextResponse.json(
      {
        error:
          `Cannot edit — this transaction opens a lot that has been sold or transferred out. ` +
          `Delete the ${blockingClosureTxIds.length} dependent transaction(s) first.`,
        code: "portfolio_edit_blocked",
        blockingClosureTxIds,
      },
      { status: 409 },
    );
  }

  for (const txId of allIds) {
    await reverseLotsForDeleteHook(userId, txId);
  }
  for (const txId of allIds) {
    await deleteTransaction(txId, userId);
  }
  return null;
}

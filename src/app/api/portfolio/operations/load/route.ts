/**
 * GET /api/portfolio/operations/load?id=N
 *
 * Loads a portfolio-operation pair from a single tx id (either leg) and
 * returns the shaped data the corresponding form needs to prefill itself
 * for edit-as-replace. The form passes the same data back in its POST body
 * along with `editId` to trigger the cascade-delete + recreate path.
 *
 * Response shape:
 *   { success: true, data: { op, primaryTxId, ...formFields } }
 *
 * Where `op` is one of `buy | sell | swap | transfer | income-expense |
 * fx-conversion` and `primaryTxId` is the stock-leg id (so the form can
 * pass it as editId; cascade delete still picks up the cash leg via
 * trade_link_id).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptField } from "@/lib/crypto/envelope";
import { logApiError, safeErrorMessage } from "@/lib/validate";

interface TxRow {
  id: number;
  date: string;
  accountId: number | null;
  portfolioHoldingId: number | null;
  quantity: number | null;
  amount: number;
  currency: string;
  payee: string | null;
  note: string | null;
  tags: string | null;
  kind: string | null;
  tradeLinkId: string | null;
  linkId: string | null;
  swapLinkId: string | null;
  categoryId: number | null;
  relatedHoldingId: number | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const idRaw = request.nextUrl.searchParams.get("id");
    if (!idRaw) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const id = parseInt(idRaw, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { error: "id must be a positive integer" },
        { status: 400 },
      );
    }

    const target = await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        accountId: schema.transactions.accountId,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
        quantity: schema.transactions.quantity,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        payee: schema.transactions.payee,
        note: schema.transactions.note,
        tags: schema.transactions.tags,
        kind: schema.transactions.kind,
        tradeLinkId: schema.transactions.tradeLinkId,
        linkId: schema.transactions.linkId,
        swapLinkId: schema.transactions.swapLinkId,
        categoryId: schema.transactions.categoryId,
        relatedHoldingId: schema.transactions.relatedHoldingId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.userId, userId),
        ),
      )
      .get();
    if (!target) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }
    const t = target as TxRow;
    if (!t.kind) {
      return NextResponse.json(
        {
          error: "This transaction has no portfolio-op kind discriminator — edit via the generic transactions page.",
          code: "not_a_portfolio_op",
        },
        { status: 400 },
      );
    }

    // Decrypt user-facing string fields (payee/note/tags). `decryptField`
    // returns null on tag-mismatch / no DEK, which is fine for prefill.
    const decryptStr = (v: string | null): string => {
      if (!v) return "";
      try {
        return decryptField(dek, v) ?? "";
      } catch {
        return "";
      }
    };

    async function loadSiblings(linkColumn: "tradeLinkId" | "linkId", value: string): Promise<TxRow[]> {
      const col = linkColumn === "tradeLinkId"
        ? schema.transactions.tradeLinkId
        : schema.transactions.linkId;
      const rows = await db
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
          accountId: schema.transactions.accountId,
          portfolioHoldingId: schema.transactions.portfolioHoldingId,
          quantity: schema.transactions.quantity,
          amount: schema.transactions.amount,
          currency: schema.transactions.currency,
          payee: schema.transactions.payee,
          note: schema.transactions.note,
          tags: schema.transactions.tags,
          kind: schema.transactions.kind,
          tradeLinkId: schema.transactions.tradeLinkId,
          linkId: schema.transactions.linkId,
          categoryId: schema.transactions.categoryId,
          relatedHoldingId: schema.transactions.relatedHoldingId,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(col, value),
          ),
        );
      return rows as TxRow[];
    }

    // Phase 4 — swap_link_id ties all 4 rows of a swap. When present, the
    // load endpoint returns the full swap state regardless of which leg the
    // user clicked. The SwapForm picks this up and enters edit mode.
    if (t.swapLinkId) {
      const all = await db
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
          accountId: schema.transactions.accountId,
          portfolioHoldingId: schema.transactions.portfolioHoldingId,
          quantity: schema.transactions.quantity,
          amount: schema.transactions.amount,
          currency: schema.transactions.currency,
          payee: schema.transactions.payee,
          note: schema.transactions.note,
          tags: schema.transactions.tags,
          kind: schema.transactions.kind,
          tradeLinkId: schema.transactions.tradeLinkId,
          linkId: schema.transactions.linkId,
          swapLinkId: schema.transactions.swapLinkId,
          categoryId: schema.transactions.categoryId,
          relatedHoldingId: schema.transactions.relatedHoldingId,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.swapLinkId, t.swapLinkId),
          ),
        );
      const rows = all as TxRow[];
      const sell = rows.find((r) => r.kind === "sell");
      const buy = rows.find((r) => r.kind === "buy");
      if (sell && buy) {
        return NextResponse.json({
          success: true,
          data: {
            op: "swap",
            primaryTxId: sell.id,
            accountId: sell.accountId,
            sourceHoldingId: sell.portfolioHoldingId,
            sourceQty: Math.abs(Number(sell.quantity ?? 0)),
            sourceProceeds: Math.abs(Number(sell.amount)),
            destHoldingId: buy.portfolioHoldingId,
            destQty: Number(buy.quantity ?? 0),
            destCost: Math.abs(Number(buy.amount)),
            date: sell.date,
            payee: decryptStr(sell.payee),
            note: decryptStr(sell.note),
          },
        });
      }
    }

    // Dispatch by kind. Cash-leg / FX-leg rows resolve to their primary leg
    // via the trade/link id so the form opens in the "edit this trade" view
    // rather than "edit one leg of a trade".
    switch (t.kind) {
      case "buy":
      case "buy_cash_leg": {
        const siblings = t.tradeLinkId
          ? await loadSiblings("tradeLinkId", t.tradeLinkId)
          : [t];
        const stock = siblings.find((s) => s.kind === "buy") ?? t;
        return NextResponse.json({
          success: true,
          data: {
            op: "buy",
            primaryTxId: stock.id,
            accountId: stock.accountId,
            holdingId: stock.portfolioHoldingId,
            qty: Number(stock.quantity ?? 0),
            // Stock leg amount is positive in the new sign convention.
            // Math.abs() is defensive against the old convention where amount
            // was negative on the stock leg.
            totalCost: Math.abs(Number(stock.amount)),
            date: stock.date,
            payee: decryptStr(stock.payee),
            note: decryptStr(stock.note),
            tags: decryptStr(stock.tags),
          },
        });
      }
      case "sell":
      case "sell_cash_leg": {
        const siblings = t.tradeLinkId
          ? await loadSiblings("tradeLinkId", t.tradeLinkId)
          : [t];
        const stock = siblings.find((s) => s.kind === "sell") ?? t;
        return NextResponse.json({
          success: true,
          data: {
            op: "sell",
            primaryTxId: stock.id,
            accountId: stock.accountId,
            holdingId: stock.portfolioHoldingId,
            qty: Math.abs(Number(stock.quantity ?? 0)),
            totalProceeds: Math.abs(Number(stock.amount)),
            date: stock.date,
            payee: decryptStr(stock.payee),
            note: decryptStr(stock.note),
            tags: decryptStr(stock.tags),
          },
        });
      }
      case "portfolio_income":
      case "portfolio_expense": {
        return NextResponse.json({
          success: true,
          data: {
            op: "income-expense",
            primaryTxId: t.id,
            accountId: t.accountId,
            currency: t.currency,
            amount: Number(t.amount),
            relatedHoldingId: t.relatedHoldingId,
            categoryId: t.categoryId,
            date: t.date,
            payee: decryptStr(t.payee),
            note: decryptStr(t.note),
            tags: decryptStr(t.tags),
          },
        });
      }
      case "in_kind_transfer_in":
      case "in_kind_transfer_out": {
        const siblings = t.linkId ? await loadSiblings("linkId", t.linkId) : [t];
        const source = siblings.find((s) => s.kind === "in_kind_transfer_out") ?? t;
        const dest = siblings.find((s) => s.kind === "in_kind_transfer_in") ?? t;
        return NextResponse.json({
          success: true,
          data: {
            op: "transfer",
            primaryTxId: source.id,
            sourceAccountId: source.accountId,
            destAccountId: dest.accountId,
            holdingId: source.portfolioHoldingId,
            qty: Math.abs(Number(source.quantity ?? 0)),
            date: source.date,
            payee: decryptStr(source.payee),
            note: decryptStr(source.note),
          },
        });
      }
      case "brokerage_deposit_in":
      case "brokerage_deposit_out": {
        const siblings = t.linkId ? await loadSiblings("linkId", t.linkId) : [t];
        const source = siblings.find((s) => s.kind === "brokerage_deposit_out") ?? t;
        const dest = siblings.find((s) => s.kind === "brokerage_deposit_in") ?? t;
        return NextResponse.json({
          success: true,
          data: {
            op: "deposit",
            primaryTxId: dest.id,
            sourceAccountId: source.accountId,
            destAccountId: dest.accountId,
            destCashSleeveHoldingId: dest.portfolioHoldingId,
            amount: Math.abs(Number(dest.amount)),
            date: dest.date,
            payee: decryptStr(dest.payee),
            note: decryptStr(dest.note),
            tags: decryptStr(dest.tags),
          },
        });
      }
      case "brokerage_withdrawal_in":
      case "brokerage_withdrawal_out": {
        const siblings = t.linkId ? await loadSiblings("linkId", t.linkId) : [t];
        const source = siblings.find((s) => s.kind === "brokerage_withdrawal_out") ?? t;
        const dest = siblings.find((s) => s.kind === "brokerage_withdrawal_in") ?? t;
        return NextResponse.json({
          success: true,
          data: {
            op: "withdrawal",
            primaryTxId: source.id,
            sourceAccountId: source.accountId,
            sourceCashSleeveHoldingId: source.portfolioHoldingId,
            destAccountId: dest.accountId,
            amount: Math.abs(Number(source.amount)),
            date: source.date,
            payee: decryptStr(source.payee),
            note: decryptStr(source.note),
            tags: decryptStr(source.tags),
          },
        });
      }
      case "fx_from":
      case "fx_to":
      case "fx_fee": {
        const siblings = t.linkId ? await loadSiblings("linkId", t.linkId) : [t];
        const from = siblings.find((s) => s.kind === "fx_from") ?? t;
        const to = siblings.find((s) => s.kind === "fx_to") ?? t;
        const fee = siblings.find((s) => s.kind === "fx_fee") ?? null;
        return NextResponse.json({
          success: true,
          data: {
            op: "fx-conversion",
            primaryTxId: from.id,
            accountId: from.accountId,
            fromCurrency: from.currency,
            fromAmount: Math.abs(Number(from.amount)),
            toCurrency: to.currency,
            toAmount: Math.abs(Number(to.amount)),
            feeAmount: fee ? Math.abs(Number(fee.amount)) : null,
            feeCurrency: fee?.currency ?? null,
            feeOnSleeveCurrency: fee?.currency ?? null,
            date: from.date,
            payee: decryptStr(from.payee),
            note: decryptStr(from.note),
          },
        });
      }
      default:
        return NextResponse.json(
          {
            error: `Unsupported kind "${t.kind}" — only the 6 portfolio ops can be loaded for edit.`,
            code: "unsupported_kind",
          },
          { status: 400 },
        );
    }
  } catch (err: unknown) {
    await logApiError("GET", "/api/portfolio/operations/load", err, userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to load operation") },
      { status: 500 },
    );
  }
}

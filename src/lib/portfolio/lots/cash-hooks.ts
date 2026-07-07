/**
 * Cash-sleeve lot tracking (Phase 5c, 2026-05-26).
 *
 * Cash sleeves (`portfolio_holdings.is_cash=true`) carry per-inflow lots so
 * the realized-gain aggregator can compute currency-on-currency FX gains.
 *
 * Model:
 *   - Every cash INFLOW (deposit / income / sell-proceeds / fx-to / brokerage-
 *     deposit-in) opens a `holding_lots` row on the cash sleeve with:
 *       qty           = |tx.quantity|        (units of the sleeve currency)
 *       costPerShare  = 1                    (1 unit of C = 1 unit of C)
 *       currency      = sleeve currency
 *       fxToUsdAtOpen = null                 (aggregator fetches on demand)
 *       origin        = 'buy'                (no enum value for "cash-in" yet;
 *                                             reuse 'buy' until a future enum
 *                                             extension)
 *       side          = 'long'
 *   - Every cash OUTFLOW (withdrawal / expense / buy-cash-leg / fx-from /
 *     brokerage-withdrawal-out) FIFO-closes open cash lots on the sleeve with:
 *       proceedsPerShare = 1                 (same — unit of C = unit of C)
 *       realizedGain     = 0                 (in the sleeve currency)
 *       closeKind        = derived from tx.kind
 *
 *   Realized gain in C is always zero because cost (1) = proceeds (1). The
 *   USD / base-currency gain comes from the FX-rate DIFFERENCE between the
 *   lot's openDate and the closure's closeDate — handled by
 *   `augmentWithBaseCurrency()` in `realized-gains.ts`, which performs the
 *   per-row historical FX lookup using `costPerShare × fxToUsd(rowCcy,
 *   openDate)` vs `proceedsPerShare × fxToUsd(rowCcy, closeDate)`.
 *
 * Why no FX snapshot stored at open: the aggregator already handles missing
 * snapshots via on-demand historical FX lookups (`fx-service.getRateToUsd`),
 * and stock-lot opens follow the same convention (`fxToUsdAtOpen: null` in
 * every existing writer). When a future change populates the column at write
 * time, both stock + cash paths can adopt it together.
 *
 * Backfill: pre-Phase-5c cash sleeve activity has no lots. A later
 * `scripts/backfill-cash-sleeve-lots.ts` will walk historical transactions
 * by (holding, account, date asc), opening/closing per-flow. Until then,
 * FX conversions on legacy sleeves will short-fall (no lots to close) and
 * write the close as a "no source lot found" warning — same as the stock
 * backfill model from Phase 1.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { daysBetween } from "./engine";
import type { HoldingLot, HoldingLotClosure, TxRowForLots } from "./types";
import type { TransactionSource } from "@/lib/tx-source";

const HOOK_LABEL = "[portfolio.lots.cash]";

let strictMode = false;
export function __setCashLotHookStrictMode(value: boolean): void {
  strictMode = value;
}

function softFail(err: unknown, label: string): void {

  console.error(`${HOOK_LABEL} ${label} failed:`, err);
  if (strictMode) throw err;
}

/**
 * Subset of valid `closeKind` values for cash-lot closures. The full enum on
 * `holding_lot_closures.close_kind` is shared with stock lots; only a few
 * values are reachable from cash-sleeve closes.
 *
 *   - 'fx_conversion'   FX leg moved cash out of this sleeve
 *   - 'income_expense'  expense row reduced the sleeve
 *   - 'buy_sell'        buy_cash_leg / sell_cash_leg / brokerage_withdrawal_out
 *                        (generic "sleeve used for a trade/cash movement")
 */
export type CashCloseKind = "fx_conversion" | "income_expense" | "buy_sell";

/**
 * Infer the closeKind for a cash-sleeve outflow from the tx's `kind` discriminator.
 */
export function inferCashCloseKind(txKind: string | null | undefined): CashCloseKind {
  if (txKind === "fx_from" || txKind === "fx_to") return "fx_conversion";
  if (txKind === "portfolio_expense") return "income_expense";
  // buy_cash_leg / sell_cash_leg / brokerage_withdrawal_out / brokerage_deposit_out etc.
  return "buy_sell";
}

// ─── openCashLotHook ──────────────────────────────────────────────────────

export interface OpenCashLotHookOpts {
  /** Currency of the sleeve (= holding's currency). */
  sleeveCurrency: string;
}

/**
 * Persists a `holding_lots` row on a cash sleeve for an inflow.
 *
 * Caller must filter on `tx.quantity != null && tx.quantity > 0` and the
 * holding being a cash sleeve before calling.
 */
export async function openCashLotHook(
  tx: TxRowForLots,
  opts: OpenCashLotHookOpts,
): Promise<number | null> {
  try {
    if (tx.portfolioHoldingId == null || tx.accountId == null) return null;
    if (tx.quantity == null || tx.quantity <= 0) return null;

    let remaining = Math.abs(tx.quantity);

    // FINLYNQ-278: close-shorts-first. A cash INFLOW first covers any open
    // SHORT cash lots (an overdraft opened by an earlier outflow that ran ahead
    // of inflows — see closeCashLotsHook), FIFO, before opening a new long lot.
    // In-currency realized gain is 0 (cost 1 = proceeds 1); the FX gain in
    // USD/base is computed downstream by augmentWithBaseCurrency from the short
    // lot's openDate vs this closeDate — mirroring the stock buy → short-close
    // path in write-hooks.ts (closeKind 'short_close').
    const shortRows = await db
      .select()
      .from(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, tx.userId),
          eq(schema.holdingLots.holdingId, tx.portfolioHoldingId),
          eq(schema.holdingLots.accountId, tx.accountId),
          eq(schema.holdingLots.status, "open"),
          eq(schema.holdingLots.side, "short"),
        ),
      );
    const shorts: HoldingLot[] = shortRows
      .map(rowToCashLot)
      .sort((a, b) => a.openDate.localeCompare(b.openDate) || a.id - b.id);
    for (const lot of shorts) {
      if (remaining <= 1e-9) break;
      const closeQty = Math.min(lot.qtyRemaining, remaining);
      if (closeQty <= 0) continue;
      await db.insert(schema.holdingLotClosures).values({
        userId: tx.userId,
        lotId: lot.id,
        closeTxId: tx.id,
        closeDate: tx.date,
        qtyClosed: closeQty,
        proceedsPerShare: 1,
        costPerShare: 1,
        realizedGain: 0,
        currency: opts.sleeveCurrency,
        daysHeld: daysBetween(lot.openDate, tx.date),
        closeKind: "short_close",
        source: tx.source,
      });
      const newRemaining = lot.qtyRemaining - closeQty;
      await db
        .update(schema.holdingLots)
        .set({
          qtyRemaining: newRemaining,
          status: newRemaining <= 1e-9 ? "closed" : "open",
          updatedAt: sql`NOW()`,
        })
        .where(eq(schema.holdingLots.id, lot.id));
      remaining -= closeQty;
    }

    // Inflow fully covered open shorts → nothing left to open as a long.
    if (remaining <= 1e-9) return null;

    const inserted = await db
      .insert(schema.holdingLots)
      .values({
        userId: tx.userId,
        holdingId: tx.portfolioHoldingId,
        accountId: tx.accountId,
        openTxId: tx.id,
        openDate: tx.date,
        qtyOriginal: remaining,
        qtyRemaining: remaining,
        costPerShare: 1,
        currency: opts.sleeveCurrency,
        fxToUsdAtOpen: null,
        origin: "buy",
        parentLotId: null,
        status: "open",
        side: "long",
        source: tx.source,
      })
      .returning({ id: schema.holdingLots.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    softFail(err, `openCashLotHook tx=${tx.id}`);
    return null;
  }
}

// ─── closeCashLotsHook ────────────────────────────────────────────────────

export interface CloseCashLotsHookOpts {
  sleeveCurrency: string;
  closeKind: CashCloseKind;
}

/**
 * FIFO-closes open cash lots on a cash sleeve for an outflow.
 *
 * Caller must filter on `tx.quantity != null && tx.quantity < 0` and the
 * holding being a cash sleeve before calling.
 *
 * On shortfall (more cash leaving than has ever entered via lot writes —
 * common during the backfill transition), writes closures up to the
 * available qty and logs a warning. Does NOT throw — the underlying tx
 * row still exists; the lot side is partially-tracked.
 *
 * Returns the number of closure rows written.
 */
export async function closeCashLotsHook(
  tx: TxRowForLots,
  opts: CloseCashLotsHookOpts,
): Promise<number | null> {
  try {
    if (tx.portfolioHoldingId == null || tx.accountId == null) return null;
    if (tx.quantity == null || tx.quantity >= 0) return null;

    const targetQty = Math.abs(tx.quantity);

    const lotRows = await db
      .select()
      .from(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, tx.userId),
          eq(schema.holdingLots.holdingId, tx.portfolioHoldingId),
          eq(schema.holdingLots.accountId, tx.accountId),
          eq(schema.holdingLots.status, "open"),
          eq(schema.holdingLots.side, "long"),
        ),
      );

    // FIFO: oldest open lot first.
    const lots: HoldingLot[] = lotRows
      .map(rowToCashLot)
      .sort((a, b) => a.openDate.localeCompare(b.openDate) || a.id - b.id);

    let remaining = targetQty;
    let closuresWritten = 0;
    const closures: Omit<HoldingLotClosure, "id">[] = [];
    const qtyDeltas: Array<{ lotId: number; delta: number }> = [];

    for (const lot of lots) {
      if (remaining <= 1e-9) break;
      const closeQty = Math.min(lot.qtyRemaining, remaining);
      if (closeQty <= 0) continue;
      const daysHeld = daysBetween(lot.openDate, tx.date);
      closures.push({
        userId: tx.userId,
        lotId: lot.id,
        closeTxId: tx.id,
        closeDate: tx.date,
        qtyClosed: closeQty,
        proceedsPerShare: 1,
        costPerShare: 1,
        // In-currency realized gain is always 0 for cash lots.
        // The FX gain in USD / base currency is computed downstream by
        // augmentWithBaseCurrency() using historical FX snapshots at the
        // lot's openDate vs the closure's closeDate.
        realizedGain: 0,
        currency: opts.sleeveCurrency,
        daysHeld,
        closeKind: opts.closeKind,
        source: tx.source,
      });
      qtyDeltas.push({ lotId: lot.id, delta: closeQty });
      remaining -= closeQty;
      closuresWritten += 1;
    }

    if (closures.length > 0) {
      await db.insert(schema.holdingLotClosures).values(closures);
      for (const { lotId, delta } of qtyDeltas) {
        const lot = lots.find((l) => l.id === lotId)!;
        const newRemaining = lot.qtyRemaining - delta;
        const closed = newRemaining <= 1e-9;
        await db
          .update(schema.holdingLots)
          .set({
            qtyRemaining: newRemaining,
            status: closed ? "closed" : "open",
            updatedAt: sql`NOW()`,
          })
          .where(eq(schema.holdingLots.id, lotId));
      }
    }

    if (remaining > 1e-9) {
      // FINLYNQ-278: shortfall = the outflow exceeds the open long cash lots
      // (the sleeve went net-negative — an outflow ran ahead of inflows, or an
      // out-of-order import). Open a SHORT cash lot for the uncovered amount
      // instead of DROPPING it (the old behavior, which left later inflows as
      // phantom open longs so the sleeve never reconciled — the drift behind
      // FINLYNQ-277). A later inflow FIFO-closes this short via
      // openCashLotHook's close-shorts-first path. cost 1; the FX gain in
      // USD/base is deferred to augmentWithBaseCurrency (openDate vs closeDate).
      await db.insert(schema.holdingLots).values({
        userId: tx.userId,
        holdingId: tx.portfolioHoldingId,
        accountId: tx.accountId,
        openTxId: tx.id,
        openDate: tx.date,
        qtyOriginal: remaining,
        qtyRemaining: remaining,
        costPerShare: 1,
        currency: opts.sleeveCurrency,
        fxToUsdAtOpen: null,
        origin: "buy",
        parentLotId: null,
        status: "open",
        side: "short",
        source: tx.source,
      });
    }

    return closuresWritten;
  } catch (err) {
    softFail(err, `closeCashLotsHook tx=${tx.id}`);
    return null;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function rowToCashLot(row: typeof schema.holdingLots.$inferSelect): HoldingLot {
  return {
    id: row.id,
    userId: row.userId,
    holdingId: row.holdingId,
    accountId: row.accountId,
    openTxId: row.openTxId,
    openDate: row.openDate,
    qtyOriginal: Number(row.qtyOriginal),
    qtyRemaining: Number(row.qtyRemaining),
    costPerShare: Number(row.costPerShare),
    currency: row.currency,
    fxToUsdAtOpen: row.fxToUsdAtOpen,
    origin: row.origin as HoldingLot["origin"],
    parentLotId: row.parentLotId,
    status: row.status as HoldingLot["status"],
    side: ((row as { side?: string | null }).side ?? "long") as HoldingLot["side"],
    source: row.source as TransactionSource,
  };
}

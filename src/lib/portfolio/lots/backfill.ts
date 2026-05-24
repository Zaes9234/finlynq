/**
 * Backfill — reconstruct lots + closures from pre-Phase-1 transaction history.
 *
 * Walks every user transaction in chronological order, grouped by
 * (holding, account). Opens lots from buys + reinvested dividends, runs
 * FIFO depletion on sells, writes transfer-out closures + transfer-in
 * lots on in-kind move pairs.
 *
 * Reuses the same engine functions as the live write-hooks so the
 * cost-basis substitution (#96), sell-branch skip (#128), per-currency
 * bucketing (#129), and qty>0 keying (#236) match. Diffing the result
 * against the legacy avg-cost aggregator (the verification step before
 * flag-flip) tells us how many users will see a different realized-gain
 * number — avg-cost ≠ FIFO on partial sells, so a non-zero delta is
 * expected and not a bug.
 *
 * Idempotent — the script wipes existing lot/closure rows for the target
 * user before writing fresh ones. Snapshots the legacy avg-cost realized
 * gain into `portfolio_legacy_realized_gain_snapshot` on first run.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";
import {
  closeLotsForSell,
  openLotForBuy,
  transferLot,
} from "./engine";
import { selectLotsToClose } from "./selection";
import type {
  CashLegHint,
  HoldingLot,
  HoldingLotClosure,
  TxRowForLots,
} from "./types";
import type { TransactionSource } from "@/lib/tx-source";

export interface BackfillResult {
  userId: string;
  lotsWritten: number;
  closuresWritten: number;
  txProcessed: number;
  errors: string[];
}

/**
 * Walks the user's transaction history and rebuilds holding_lots +
 * holding_lot_closures from scratch. Marks `portfolio_lots_status.backfill_done = TRUE`
 * on success but does NOT flip `enabled` — that's a manual decision after
 * a canary diff against the legacy aggregator.
 */
export async function buildLotsForUser(
  userId: string,
  dek: Buffer | null,
): Promise<BackfillResult> {
  const errors: string[] = [];
  let lotsWritten = 0;
  let closuresWritten = 0;
  let txProcessed = 0;

  // 1. Wipe any prior backfill output for this user. Idempotent re-run.
  //    The CASCADE on holdingLots → holdingLotClosures cleans up closures
  //    automatically.
  await db
    .delete(schema.holdingLotClosures)
    .where(eq(schema.holdingLotClosures.userId, userId));
  await db
    .delete(schema.holdingLots)
    .where(eq(schema.holdingLots.userId, userId));

  // 2. Load every relevant transaction in chronological order. We pull
  //    only investment rows — those with portfolio_holding_id set AND
  //    non-zero quantity (or paired cash-leg companions).
  const txRows = await db
    .select({
      id: schema.transactions.id,
      userId: schema.transactions.userId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      quantity: schema.transactions.quantity,
      accountId: schema.transactions.accountId,
      categoryId: schema.transactions.categoryId,
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      tradeLinkId: schema.transactions.tradeLinkId,
      linkId: schema.transactions.linkId,
      source: schema.transactions.source,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        isNotNull(schema.transactions.portfolioHoldingId),
      ),
    )
    .orderBy(schema.transactions.date, schema.transactions.id);

  // 3. Build cash-leg map (trade_link_id → cash leg) for issue #96 substitution.
  const cashLegByTradeLinkId = new Map<string, CashLegHint>();
  for (const r of txRows) {
    if (
      r.tradeLinkId &&
      (r.quantity == null || r.quantity === 0) &&
      r.amount !== 0
    ) {
      cashLegByTradeLinkId.set(r.tradeLinkId, {
        enteredAmount: Number(r.enteredAmount ?? r.amount),
        enteredCurrency: r.enteredCurrency,
        amount: Number(r.amount),
        currency: r.currency ?? "USD",
        tradeLinkId: r.tradeLinkId,
      });
    }
  }

  // 4. Holding currency map.
  const holdingRows = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId));
  const holdingCurrencies = new Map<number, string>();
  for (const h of holdingRows) holdingCurrencies.set(h.id, h.currency);

  // 5. Dividends category id (issue #84).
  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );

  // 6. Per-(holding, account) running lot map kept in-memory through the walk.
  //    Each lot has a synthetic in-memory id; we re-assign after the bulk
  //    INSERT once the DB hands us serial ids.
  type InMemLot = Omit<HoldingLot, "id" | "status"> & {
    tmpId: number;
    status: HoldingLot["status"];
  };
  let nextTmpId = 1;
  const lotsByKey = new Map<string, InMemLot[]>();

  type ClosureToWrite = Omit<HoldingLotClosure, "id"> & { tmpLotId: number };
  const pendingClosures: ClosureToWrite[] = [];
  const pendingLots: InMemLot[] = [];

  const keyOf = (h: number, a: number) => `${h}:${a}`;

  // Group rows by link_id for transfer-pair processing.
  const byLinkId = new Map<string, typeof txRows>();
  for (const r of txRows) {
    if (r.linkId) {
      const arr = byLinkId.get(r.linkId) ?? ([] as typeof txRows);
      arr.push(r);
      byLinkId.set(r.linkId, arr);
    }
  }
  const processedTransferIds = new Set<number>();

  for (const r of txRows) {
    if (r.portfolioHoldingId == null || r.accountId == null) continue;
    if (processedTransferIds.has(r.id)) {
      txProcessed++;
      continue;
    }

    // Paired cash leg — skipped from depletion (issue #128) and contributes
    // only as a cost-basis hint via `cashLegByTradeLinkId` to its sibling.
    if (
      r.tradeLinkId &&
      (r.quantity == null || r.quantity === 0)
    ) {
      txProcessed++;
      continue;
    }

    const txRow: TxRowForLots = {
      id: r.id,
      userId: r.userId,
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency ?? "USD",
      enteredAmount: r.enteredAmount,
      enteredCurrency: r.enteredCurrency,
      quantity: r.quantity,
      accountId: r.accountId,
      categoryId: r.categoryId,
      portfolioHoldingId: r.portfolioHoldingId,
      tradeLinkId: r.tradeLinkId,
      source: (r.source as TransactionSource) ?? "import",
    };

    const holdingCurrency =
      holdingCurrencies.get(r.portfolioHoldingId) ?? txRow.currency;
    const key = keyOf(r.portfolioHoldingId, r.accountId);

    // Transfer-pair detection — same link_id with TWO legs, opposite-sign qty.
    let isInKindTransfer = false;
    if (r.linkId && (r.quantity ?? 0) !== 0) {
      const peers = byLinkId.get(r.linkId) ?? [];
      const sibling = peers.find(
        (p) =>
          p.id !== r.id &&
          (p.quantity ?? 0) !== 0 &&
          Math.sign(p.quantity ?? 0) !== Math.sign(r.quantity ?? 0),
      );
      if (sibling && r.quantity != null && r.quantity < 0) {
        // r is the source (qty<0); sibling is the dest (qty>0).
        const destTxRow: TxRowForLots = {
          id: sibling.id,
          userId: sibling.userId,
          date: sibling.date,
          amount: Number(sibling.amount),
          currency: sibling.currency ?? "USD",
          enteredAmount: sibling.enteredAmount,
          enteredCurrency: sibling.enteredCurrency,
          quantity: sibling.quantity,
          accountId: sibling.accountId,
          categoryId: sibling.categoryId,
          portfolioHoldingId: sibling.portfolioHoldingId,
          tradeLinkId: sibling.tradeLinkId,
          source: (sibling.source as TransactionSource) ?? "import",
        };
        const sourceLots = (lotsByKey.get(key) ?? []).map((l) => ({
          ...l,
          id: l.tmpId,
        })) as HoldingLot[];
        const result = transferLot({
          sourceTx: txRow,
          destTx: destTxRow,
          sourceLots,
          holdingCurrency,
        });
        for (const cl of result.closures) {
          pendingClosures.push({ ...cl, tmpLotId: cl.lotId });
        }
        // Map qty deltas back to in-mem lots.
        const arr = lotsByKey.get(key) ?? [];
        for (const [lotIdTmp, delta] of result.qtyDeltas) {
          const lot = arr.find((l) => l.tmpId === lotIdTmp);
          if (lot) {
            lot.qtyRemaining -= delta;
            if (lot.qtyRemaining <= 1e-9) {
              lot.status = "transferred_out";
              lot.qtyRemaining = 0;
            }
          }
        }
        // Open dest lots in the dest (holding, account) bucket.
        if (destTxRow.portfolioHoldingId != null && destTxRow.accountId != null) {
          const destKey = keyOf(destTxRow.portfolioHoldingId, destTxRow.accountId);
          const destArr = lotsByKey.get(destKey) ?? [];
          for (const dl of result.destLots) {
            const tmpId = nextTmpId++;
            destArr.push({ ...dl, tmpId, status: "open" });
            pendingLots.push({ ...dl, tmpId, status: "open" });
          }
          lotsByKey.set(destKey, destArr);
        }
        processedTransferIds.add(sibling.id);
        isInKindTransfer = true;
      } else if (sibling && r.quantity != null && r.quantity > 0) {
        // The dest side is being visited first — defer; the source-side
        // iteration will handle the pair.
        processedTransferIds.add(r.id);
        txProcessed++;
        continue;
      }
    }

    if (isInKindTransfer) {
      txProcessed++;
      continue;
    }

    // Regular buy / dividend-reinvest / sell.
    if (r.quantity != null && r.quantity > 0) {
      const cashLeg = r.tradeLinkId
        ? cashLegByTradeLinkId.get(r.tradeLinkId) ?? undefined
        : undefined;
      const categoryIsDividend =
        dividendsCategoryId != null && r.categoryId === dividendsCategoryId;
      const plan = openLotForBuy({
        tx: txRow,
        cashLeg,
        categoryIsDividend,
        holdingCurrency,
        originOverride: "backfill",
      });
      const tmpId = nextTmpId++;
      const lot: InMemLot = { ...plan.lot, tmpId, status: "open", side: "long" };
      pendingLots.push(lot);
      const arr = lotsByKey.get(key) ?? [];
      arr.push(lot);
      lotsByKey.set(key, arr);
    } else if (r.quantity != null && r.quantity < 0) {
      // Paired cash-leg already filtered above.
      const cashLeg = r.tradeLinkId
        ? cashLegByTradeLinkId.get(r.tradeLinkId) ?? undefined
        : undefined;
      const arr = (lotsByKey.get(key) ?? []).map((l) => ({
        ...l,
        id: l.tmpId,
      })) as HoldingLot[];
      const plan = selectLotsToClose({
        strategy: "FIFO",
        lots: arr,
        targetQty: Math.abs(r.quantity),
      });
      if (!plan.success) {
        errors.push(
          `tx ${r.id} (${r.date}): sell shortfall ${plan.shortfall} — no matching open lot`,
        );
        txProcessed++;
        continue;
      }
      const lotsById = new Map(arr.map((l) => [l.id, l]));
      const result = closeLotsForSell({
        tx: txRow,
        plan,
        cashLeg,
        holdingCurrency,
        lotsById,
      });
      for (const cl of result.closures) {
        pendingClosures.push({ ...cl, tmpLotId: cl.lotId });
      }
      const sourceArr = lotsByKey.get(key) ?? [];
      for (const [lotIdTmp, delta] of result.qtyDeltas) {
        const lot = sourceArr.find((l) => l.tmpId === lotIdTmp);
        if (lot) {
          lot.qtyRemaining -= delta;
          if (lot.qtyRemaining <= 1e-9) {
            lot.status = "closed";
            lot.qtyRemaining = 0;
          }
        }
      }
    }
    txProcessed++;
  }

  // 7. Bulk insert lots, then map tmpId → real id, then insert closures.
  if (pendingLots.length > 0) {
    const lotValues = pendingLots.map((l) => ({
      userId: l.userId,
      holdingId: l.holdingId,
      accountId: l.accountId,
      openTxId: l.openTxId,
      openDate: l.openDate,
      qtyOriginal: l.qtyOriginal,
      qtyRemaining: l.qtyRemaining,
      costPerShare: l.costPerShare,
      currency: l.currency,
      fxToUsdAtOpen: l.fxToUsdAtOpen,
      origin: l.origin,
      parentLotId: null, // parent_lot_id is also tmp — TODO post-Phase-1 fixup
      status: l.status,
      source: l.source,
    }));
    const inserted = await db
      .insert(schema.holdingLots)
      .values(lotValues)
      .returning({ id: schema.holdingLots.id });
    lotsWritten = inserted.length;
    // Map tmpId → real id in input order (PG INSERT RETURNING preserves order).
    const tmpToReal = new Map<number, number>();
    for (let i = 0; i < pendingLots.length; i++) {
      tmpToReal.set(pendingLots[i].tmpId, inserted[i].id);
    }

    if (pendingClosures.length > 0) {
      const closureValues = pendingClosures.map((c) => ({
        userId: c.userId,
        lotId: tmpToReal.get(c.tmpLotId) ?? 0,
        closeTxId: c.closeTxId,
        closeDate: c.closeDate,
        qtyClosed: c.qtyClosed,
        proceedsPerShare: c.proceedsPerShare,
        costPerShare: c.costPerShare,
        realizedGain: c.realizedGain,
        currency: c.currency,
        daysHeld: c.daysHeld,
        closeKind: c.closeKind,
        source: c.source,
      }));
      // Drop closures whose lot didn't make it into the DB (shouldn't happen).
      const valid = closureValues.filter((c) => c.lotId > 0);
      if (valid.length > 0) {
        await db.insert(schema.holdingLotClosures).values(valid);
        closuresWritten = valid.length;
      }
    }
  }

  // 8. Mark backfill done. NOT enabled — that's a separate manual flip.
  await db
    .insert(schema.portfolioLotsStatus)
    .values({
      userId,
      backfillDone: true,
      backfilledAt: sql`NOW()`,
      enabled: false,
      notes: `Backfilled ${lotsWritten} lots, ${closuresWritten} closures from ${txProcessed} transactions${errors.length ? ` (${errors.length} non-fatal errors)` : ""}`,
    })
    .onConflictDoUpdate({
      target: schema.portfolioLotsStatus.userId,
      set: {
        backfillDone: true,
        backfilledAt: sql`NOW()`,
        notes: `Re-backfilled ${lotsWritten} lots, ${closuresWritten} closures from ${txProcessed} transactions${errors.length ? ` (${errors.length} non-fatal errors)` : ""}`,
      },
    });

  return { userId, lotsWritten, closuresWritten, txProcessed, errors };
}

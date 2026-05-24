/**
 * Pure-engine unit tests for the lot-tracked cost-basis engine
 * (plan/portfolio-lots-and-performance.md Phase 1).
 *
 * No DB I/O — drives engine.ts + selection.ts with hand-built fixtures.
 * Sanity coverage for the four load-bearing semantic rules the engine
 * encodes:
 *
 *   FIFO depletion          oldest open_date first; id ASC tiebreaker.
 *   HIFO depletion          highest cost_per_share first.
 *   SPECIFIC selection      caller picks lots by id.
 *   Issue #128 cash-leg     paired cash leg (trade_link_id + amount=0)
 *     skip on sell branch   is a no-op on lot depletion.
 *   Issue #96 cash-leg      paired cash leg drives lot cost_per_share
 *     substitution on buy   for the stock leg.
 */

import { describe, it, expect } from "vitest";
import {
  closeLotsForSell,
  daysBetween,
  openLotForBuy,
  transferLot,
} from "@/lib/portfolio/lots/engine";
import { selectLotsToClose } from "@/lib/portfolio/lots/selection";
import type {
  CashLegHint,
  HoldingLot,
  LotClosurePlan,
  TxRowForLots,
} from "@/lib/portfolio/lots/types";

// ─── helpers ──────────────────────────────────────────────────────────────

const tx = (overrides: Partial<TxRowForLots> = {}): TxRowForLots => ({
  id: 1,
  userId: "u",
  date: "2025-06-01",
  amount: -1000,
  currency: "USD",
  enteredAmount: -1000,
  enteredCurrency: "USD",
  quantity: 10,
  accountId: 100,
  categoryId: null,
  portfolioHoldingId: 200,
  tradeLinkId: null,
  source: "manual",
  ...overrides,
});

const lot = (overrides: Partial<HoldingLot> = {}): HoldingLot => ({
  id: 1,
  userId: "u",
  holdingId: 200,
  accountId: 100,
  openTxId: 1,
  openDate: "2024-01-15",
  qtyOriginal: 10,
  qtyRemaining: 10,
  costPerShare: 100,
  currency: "USD",
  fxToUsdAtOpen: null,
  origin: "buy",
  parentLotId: null,
  status: "open",
  side: "long",
  source: "manual",
  ...overrides,
});

// ─── openLotForBuy ────────────────────────────────────────────────────────

describe("openLotForBuy", () => {
  it("opens a lot from a plain buy (no cash leg)", () => {
    const result = openLotForBuy({
      tx: tx({ quantity: 10, enteredAmount: 1500, enteredCurrency: "USD" }),
      holdingCurrency: "USD",
    });
    expect(result.lot.qtyOriginal).toBe(10);
    expect(result.lot.qtyRemaining).toBe(10);
    expect(result.lot.costPerShare).toBe(150); // 1500 / 10
    expect(result.lot.currency).toBe("USD");
    expect(result.lot.origin).toBe("buy");
  });

  it("issue #96 — substitutes cash leg's entered_amount on a paired buy", () => {
    const cashLeg: CashLegHint = {
      enteredAmount: -1400, // USD broker settlement
      enteredCurrency: "USD",
      amount: -1400,
      currency: "USD",
      tradeLinkId: "trade-xyz",
    };
    const result = openLotForBuy({
      tx: tx({
        quantity: 10,
        enteredAmount: -1500, // Finlynq's live-FX re-price
        enteredCurrency: "USD",
        tradeLinkId: "trade-xyz",
      }),
      cashLeg,
      holdingCurrency: "USD",
    });
    // Should use cash leg's 1400 (not stock leg's 1500).
    expect(result.lot.costPerShare).toBe(140);
  });

  it("classifies dividend reinvestments as origin='reinvest_div'", () => {
    const result = openLotForBuy({
      tx: tx({ quantity: 5, enteredAmount: 500, categoryId: 42 }),
      holdingCurrency: "USD",
      categoryIsDividend: true,
    });
    expect(result.lot.origin).toBe("reinvest_div");
  });

  it("throws when called with non-positive quantity", () => {
    expect(() =>
      openLotForBuy({ tx: tx({ quantity: -5 }), holdingCurrency: "USD" }),
    ).toThrow(/non-positive quantity/);
  });
});

// ─── selectLotsToClose ────────────────────────────────────────────────────

describe("selectLotsToClose — FIFO / HIFO / SPECIFIC", () => {
  // Three lots: oldest=$100, middle=$120, newest=$150 — 10 shares each.
  const lots: HoldingLot[] = [
    lot({ id: 1, openDate: "2023-01-01", costPerShare: 100, qtyRemaining: 10, qtyOriginal: 10 }),
    lot({ id: 2, openDate: "2024-06-15", costPerShare: 150, qtyRemaining: 10, qtyOriginal: 10 }),
    lot({ id: 3, openDate: "2024-03-01", costPerShare: 120, qtyRemaining: 10, qtyOriginal: 10 }),
  ];

  it("FIFO sells oldest lot first", () => {
    const plan = selectLotsToClose({ strategy: "FIFO", lots, targetQty: 8 });
    expect(plan.success).toBe(true);
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].lotId).toBe(1);
    expect(plan.legs[0].qty).toBe(8);
    expect(plan.legs[0].costPerShare).toBe(100);
  });

  it("FIFO spans multiple lots on a sell larger than the oldest", () => {
    const plan = selectLotsToClose({ strategy: "FIFO", lots, targetQty: 15 });
    expect(plan.success).toBe(true);
    expect(plan.legs).toHaveLength(2);
    // Lot 1 (2023) exhausted, then lot 3 (2024-03) partially.
    expect(plan.legs[0].lotId).toBe(1);
    expect(plan.legs[0].qty).toBe(10);
    expect(plan.legs[1].lotId).toBe(3);
    expect(plan.legs[1].qty).toBe(5);
  });

  it("HIFO sells highest-cost lot first", () => {
    const plan = selectLotsToClose({ strategy: "HIFO", lots, targetQty: 8 });
    expect(plan.success).toBe(true);
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].lotId).toBe(2); // $150 / share
    expect(plan.legs[0].qty).toBe(8);
  });

  it("SPECIFIC respects caller's lot order", () => {
    const plan = selectLotsToClose({
      strategy: "SPECIFIC",
      lots,
      targetQty: 15,
      lotIds: [2, 3], // pick the middle, then the new-mid
    });
    expect(plan.success).toBe(true);
    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[0].lotId).toBe(2);
    expect(plan.legs[0].qty).toBe(10);
    expect(plan.legs[1].lotId).toBe(3);
    expect(plan.legs[1].qty).toBe(5);
  });

  it("returns shortfall when not enough qty available", () => {
    const plan = selectLotsToClose({ strategy: "FIFO", lots, targetQty: 100 });
    expect(plan.success).toBe(false);
    expect(plan.shortfall).toBeCloseTo(70, 6); // 100 - 30
  });

  it("targetQty<=0 is a no-op", () => {
    const plan = selectLotsToClose({ strategy: "FIFO", lots, targetQty: 0 });
    expect(plan.success).toBe(true);
    expect(plan.legs).toHaveLength(0);
  });
});

// ─── closeLotsForSell ─────────────────────────────────────────────────────

describe("closeLotsForSell", () => {
  it("computes realized gain correctly across multi-lot FIFO depletion", () => {
    const lots: HoldingLot[] = [
      lot({ id: 1, openDate: "2023-01-01", costPerShare: 100, qtyRemaining: 10 }),
      lot({ id: 3, openDate: "2024-03-01", costPerShare: 120, qtyRemaining: 10 }),
    ];
    const plan = selectLotsToClose({
      strategy: "FIFO",
      lots,
      targetQty: 15,
    });
    expect(plan.success).toBe(true);
    const sell = tx({
      id: 99,
      date: "2025-06-01",
      quantity: -15,
      enteredAmount: -2400, // 15 × $160
      enteredCurrency: "USD",
    });
    const result = closeLotsForSell({
      tx: sell,
      plan,
      holdingCurrency: "USD",
      lotsById: new Map(lots.map((l) => [l.id, l])),
    });
    expect(result.closures).toHaveLength(2);
    // Lot 1: (160 - 100) × 10 = 600
    expect(result.closures[0].realizedGain).toBeCloseTo(600);
    // Lot 3: (160 - 120) × 5 = 200
    expect(result.closures[1].realizedGain).toBeCloseTo(200);
    expect(result.closedLotIds).toContain(1);
    expect(result.closedLotIds).not.toContain(3); // 5 remain
  });

  it("issue #128 — paired cash-leg sell is a no-op", () => {
    const cashLegSell = tx({
      id: 7,
      quantity: -1, // sentinel; aggregator predicate is amount===0
      amount: 0,
      enteredAmount: 0,
      tradeLinkId: "trade-x",
    });
    const result = closeLotsForSell({
      tx: cashLegSell,
      plan: { success: true, legs: [], strategy: "FIFO" } as LotClosurePlan,
      holdingCurrency: "USD",
      lotsById: new Map(),
    });
    expect(result.closures).toHaveLength(0);
    expect(result.qtyDeltas.size).toBe(0);
  });

  it("issue #96 — uses cash leg's entered_amount as proceeds on a paired sell", () => {
    const stockLot = lot({ id: 1, costPerShare: 100, qtyRemaining: 10 });
    const plan = selectLotsToClose({
      strategy: "FIFO",
      lots: [stockLot],
      targetQty: 10,
    });
    expect(plan.success).toBe(true);
    const stockSell = tx({
      id: 50,
      quantity: -10,
      enteredAmount: -1500, // Finlynq's live-FX re-price (over-states the spread)
      tradeLinkId: "trade-z",
    });
    const cashLeg: CashLegHint = {
      enteredAmount: 1400, // broker's actual settlement
      enteredCurrency: "USD",
      amount: 1400,
      currency: "USD",
      tradeLinkId: "trade-z",
    };
    const result = closeLotsForSell({
      tx: stockSell,
      plan,
      cashLeg,
      holdingCurrency: "USD",
      lotsById: new Map([[1, stockLot]]),
    });
    expect(result.closures).toHaveLength(1);
    // (140 - 100) × 10 = 400 — using cash leg's 1400 / 10, not stock leg's 1500 / 10.
    expect(result.closures[0].realizedGain).toBeCloseTo(400);
    expect(result.closures[0].proceedsPerShare).toBeCloseTo(140);
  });
});

// ─── transferLot ──────────────────────────────────────────────────────────

describe("transferLot", () => {
  it("inherits source open_date + cost_per_share on the dest lot", () => {
    const sourceLots: HoldingLot[] = [
      lot({
        id: 1,
        openDate: "2022-04-10",
        costPerShare: 80,
        qtyRemaining: 5,
        qtyOriginal: 5,
      }),
    ];
    const sourceTx = tx({
      id: 10,
      date: "2025-09-01",
      quantity: -5,
      accountId: 100,
    });
    const destTx = tx({
      id: 11,
      date: "2025-09-01",
      quantity: 5,
      accountId: 200, // different account
    });
    const result = transferLot({
      sourceTx,
      destTx,
      sourceLots,
      holdingCurrency: "USD",
    });
    expect(result.closures).toHaveLength(1);
    expect(result.closures[0].closeKind).toBe("transfer_out");
    expect(result.closures[0].realizedGain).toBe(0);
    expect(result.destLots).toHaveLength(1);
    // Dest lot inherits — tax-lot age preserved across the move.
    expect(result.destLots[0].openDate).toBe("2022-04-10");
    expect(result.destLots[0].costPerShare).toBe(80);
    expect(result.destLots[0].origin).toBe("transfer_in");
    expect(result.destLots[0].parentLotId).toBe(1);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────

describe("daysBetween", () => {
  it("computes calendar-day diff between two YYYY-MM-DD strings", () => {
    expect(daysBetween("2024-01-01", "2024-01-02")).toBe(1);
    expect(daysBetween("2023-01-01", "2024-01-01")).toBe(365);
    // Defensive: from > to → 0
    expect(daysBetween("2024-06-01", "2024-01-01")).toBe(0);
  });
});

/**
 * FINLYNQ-176 — orchestrator tests for replanLotsAfterMutation
 * (src/lib/portfolio/lots/write-hooks.ts). Phase 2.
 *
 * tc-3: dry-run preview writes NOTHING (zero insert/update/delete against
 *       holding_lots / holding_lot_closures).
 * tc-4: a mutation with NO dependent closures is a no-op empty preview and
 *       never touches the DB at all (mirrors canEditPortfolioRow allowed).
 *
 * Uses a hoisted Drizzle mock that records which terminal write methods
 * (insert/update/delete) were invoked and serves a queue of select results.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const writeSpy = vi.hoisted(() => ({
  inserts: 0,
  updates: 0,
  deletes: 0,
  results: [] as unknown[][],
}));

vi.mock("@/db", () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const passthrough = [
      "select",
      "from",
      "where",
      "leftJoin",
      "orderBy",
      "groupBy",
      "values",
      "set",
      "limit",
    ];
    for (const m of passthrough) chain[m] = vi.fn(() => chain);
    const resolve = () =>
      writeSpy.results.length ? writeSpy.results.shift()! : [];
    chain.insert = vi.fn(() => {
      writeSpy.inserts += 1;
      return chain;
    });
    chain.update = vi.fn(() => {
      writeSpy.updates += 1;
      return chain;
    });
    chain.delete = vi.fn(() => {
      writeSpy.deletes += 1;
      return chain;
    });
    chain.returning = vi.fn(() => resolve());
    chain.all = vi.fn(() => resolve());
    chain.get = vi.fn(() => resolve()[0]);
    chain.then = (r: (v: unknown) => unknown) => r(resolve());
    return chain;
  }
  const db = makeChain();
  return {
    db,
    schema: {
      transactions: {
        id: {},
        userId: {},
        date: {},
        amount: {},
        currency: {},
        enteredAmount: {},
        enteredCurrency: {},
        quantity: {},
        accountId: {},
        categoryId: {},
        portfolioHoldingId: {},
        tradeLinkId: {},
        source: {},
        kind: {},
      },
      holdingLots: {
        id: {},
        userId: {},
        holdingId: {},
        accountId: {},
        openTxId: {},
        openDate: {},
        qtyOriginal: {},
        qtyRemaining: {},
        costPerShare: {},
        currency: {},
        fxToUsdAtOpen: {},
        origin: {},
        parentLotId: {},
        status: {},
        side: {},
        source: {},
      },
      holdingLotClosures: {
        id: {},
        userId: {},
        lotId: {},
        closeTxId: {},
        closeDate: {},
        qtyClosed: {},
        proceedsPerShare: {},
        costPerShare: {},
        realizedGain: {},
        currency: {},
        daysHeld: {},
        closeKind: {},
        source: {},
      },
      portfolioHoldings: { id: {}, userId: {}, currency: {}, isCash: {} },
    },
  };
});

import { replanLotsAfterMutation } from "@/lib/portfolio/lots/write-hooks";

beforeEach(() => {
  writeSpy.inserts = 0;
  writeSpy.updates = 0;
  writeSpy.deletes = 0;
  writeSpy.results = [];
});

describe("replanLotsAfterMutation — tc-4 no-dependents no-op", () => {
  it("returns an empty preview and touches the DB zero times", async () => {
    const preview = await replanLotsAfterMutation(
      "u",
      { op: "delete", targetTxId: 1, dependentCloseTxIds: [] },
      { dryRun: true },
    );
    expect(preview.proposedClosures).toHaveLength(0);
    expect(preview.openedShortLots).toHaveLength(0);
    expect(preview.dependentCloseTxIds).toHaveLength(0);
    expect(preview.realizedGainDeltaByYear).toEqual({});
    expect(writeSpy.inserts + writeSpy.updates + writeSpy.deletes).toBe(0);
  });
});

describe("replanLotsAfterMutation — tc-3 dry-run writes nothing", () => {
  it("issues zero insert/update/delete on a dry-run with dependents", async () => {
    // Queue the SELECT results the dry-run path reads, in call order:
    //   1. loadDependentCloses → tx rows
    const depTxRows = [
      {
        id: 99,
        userId: "u",
        date: "2025-06-01",
        amount: -1500,
        currency: "USD",
        enteredAmount: -1500,
        enteredCurrency: "USD",
        quantity: -10,
        accountId: 100,
        categoryId: null,
        portfolioHoldingId: 200,
        tradeLinkId: null,
        source: "manual",
        kind: "sell",
      },
    ];
    //   2. loadDependentCloses → closure rows
    const depClosures = [
      {
        id: 1,
        userId: "u",
        lotId: 1,
        closeTxId: 99,
        closeDate: "2025-06-01",
        qtyClosed: 10,
        proceedsPerShare: 150,
        costPerShare: 100,
        realizedGain: 500,
        currency: "USD",
        daysHeld: 100,
        closeKind: "sell",
        source: "manual",
      },
    ];
    //   3. loadLotsForHoldings → current lots (lot B, id=2, survives)
    const liveLots = [
      {
        id: 2,
        userId: "u",
        holdingId: 200,
        accountId: 100,
        openTxId: 2,
        openDate: "2024-03-01",
        qtyOriginal: 10,
        qtyRemaining: 10,
        costPerShare: 120,
        currency: "USD",
        fxToUsdAtOpen: null,
        origin: "buy",
        parentLotId: null,
        status: "open",
        side: "long",
        source: "manual",
      },
    ];
    //   4. target tx's own closures (none — the deleted buy opened lot 1)
    const targetClosures: unknown[] = [];

    writeSpy.results = [depTxRows, depClosures, liveLots, targetClosures];

    const preview = await replanLotsAfterMutation(
      "u",
      { op: "delete", targetTxId: 1, dependentCloseTxIds: [99] },
      { dryRun: true },
    );

    expect(writeSpy.inserts).toBe(0);
    expect(writeSpy.updates).toBe(0);
    expect(writeSpy.deletes).toBe(0);
    expect(preview.dependentCloseTxIds).toEqual([99]);
    expect(preview.proposedClosures.length).toBeGreaterThan(0);
  });
});

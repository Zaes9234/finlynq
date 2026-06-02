/**
 * Pure-unit tests for buildNetWorthHistory (plan/net-worth-over-time.md Part A).
 *
 * Self-contained: `@/lib/fx-service` is mocked so the suite never bootstraps
 * the Postgres harness. The mock mirrors the real convertWithRateMap math
 * (amount × rate, rounded to cents).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/fx-service", () => ({
  convertWithRateMap: (amount: number, ccy: string, rateMap: Map<string, number>) =>
    Math.round(amount * (rateMap.get(String(ccy).toUpperCase()) ?? 1) * 100) / 100,
}));

import {
  buildNetWorthHistory,
  type CashDelta,
  type InvestmentSnapshot,
} from "@/lib/net-worth-history";

const CAD = new Map<string, number>([["CAD", 1]]);

describe("buildNetWorthHistory", () => {
  it("carries cash forward across quiet days (all period)", () => {
    const cashDeltas: CashDelta[] = [
      { date: "2026-05-01", currency: "CAD", delta: 100 },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashDeltas,
      snapshots: [],
      today: "2026-05-03",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 100 },
      { date: "2026-05-02", value: 100 },
      { date: "2026-05-03", value: 100 },
    ]);
    expect(res.hasInvestmentData).toBe(false);
  });

  it("includes the full pre-window cumulative balance on the first day of a 6m window", () => {
    // A single old delta — by the time the 6m window starts, the running
    // total must already be 500 (deltas before firstDay fold into day 1).
    const cashDeltas: CashDelta[] = [
      { date: "2020-01-01", currency: "CAD", delta: 500 },
    ];
    const res = buildNetWorthHistory({
      period: "6m",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashDeltas,
      snapshots: [],
      today: "2026-06-02",
    });
    // 180 days back, inclusive → 181 points.
    expect(res.series.length).toBe(181);
    expect(res.series[0]).toEqual({ date: "2025-12-04", value: 500 });
    expect(res.series[res.series.length - 1]).toEqual({
      date: "2026-06-02",
      value: 500,
    });
  });

  it("reads investment value from the nearest snapshot at-or-before each day", () => {
    const snapshots: InvestmentSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 1000, currency: "CAD" },
      { accountId: 1, snapDate: "2026-05-03", marketValue: 1100, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashDeltas: [],
      snapshots,
      today: "2026-05-04",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 1000 },
      { date: "2026-05-02", value: 1000 }, // carry-forward
      { date: "2026-05-03", value: 1100 },
      { date: "2026-05-04", value: 1100 }, // carry-forward
    ]);
    expect(res.hasInvestmentData).toBe(true);
  });

  it("converts multiple currencies via the rate map", () => {
    const rateMap = new Map<string, number>([
      ["CAD", 1],
      ["USD", 1.4],
    ]);
    const cashDeltas: CashDelta[] = [
      { date: "2026-05-01", currency: "CAD", delta: 100 },
      { date: "2026-05-01", currency: "USD", delta: 50 },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap,
      cashDeltas,
      snapshots: [],
      today: "2026-05-01",
    });
    // 100 CAD + 50 USD × 1.4 = 170
    expect(res.series).toEqual([{ date: "2026-05-01", value: 170 }]);
  });

  it("substitutes live holdings value on the final (today) grid point", () => {
    const snapshots: InvestmentSnapshot[] = [
      { accountId: 1, snapDate: "2026-05-01", marketValue: 1000, currency: "CAD" },
    ];
    const live = new Map([[1, { value: 1200, currency: "CAD" }]]);
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashDeltas: [],
      snapshots,
      liveInvestmentByAccount: live,
      today: "2026-05-02",
    });
    expect(res.series).toEqual([
      { date: "2026-05-01", value: 1000 }, // historical snapshot
      { date: "2026-05-02", value: 1200 }, // live override on today
    ]);
    expect(res.hasInvestmentData).toBe(true);
  });

  it("excludes investment accounts from the cash sum — combines both sides", () => {
    // Cash account delta + investment snapshot, same day. The investment
    // account's tx legs are NOT in cashDeltas (the query filters them out),
    // so the merged value is cash + snapshot.
    const cashDeltas: CashDelta[] = [
      { date: "2026-05-01", currency: "CAD", delta: 250 },
    ];
    const snapshots: InvestmentSnapshot[] = [
      { accountId: 2, snapDate: "2026-05-01", marketValue: 800, currency: "CAD" },
    ];
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashDeltas,
      snapshots,
      today: "2026-05-01",
    });
    expect(res.series).toEqual([{ date: "2026-05-01", value: 1050 }]);
  });

  it("returns hasInvestmentData=false and a zero series when there is no data", () => {
    const res = buildNetWorthHistory({
      period: "all",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashDeltas: [],
      snapshots: [],
      today: "2026-05-01",
    });
    expect(res.series).toEqual([{ date: "2026-05-01", value: 0 }]);
    expect(res.hasInvestmentData).toBe(false);
    expect(res.fxApproximation).toBe(true);
  });

  it("produces 366 points for a 1y window (365 days back, inclusive)", () => {
    const res = buildNetWorthHistory({
      period: "1y",
      displayCurrency: "CAD",
      rateMap: CAD,
      cashDeltas: [],
      snapshots: [],
      today: "2026-06-02",
    });
    expect(res.series.length).toBe(366);
    expect(res.series[0].date).toBe("2025-06-02");
    expect(res.series[res.series.length - 1].date).toBe("2026-06-02");
  });
});

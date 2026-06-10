/**
 * Pure-unit tests for buildStackedSeries (FINLYNQ-129 — chart stacked-member
 * toggle). Builds on the FINLYNQ-128 BreakdownMember shape; the gating
 * invariant is that the stacked bands re-sum to the aggregate `total` at every
 * point (the outer stack boundary equals the aggregate line — tc-1/tc-2/tc-3).
 *
 * Self-contained: buildStackedSeries depends only on the static chart palette,
 * so no harness bootstrap.
 */

import { describe, it, expect } from "vitest";
import {
  buildStackedSeries,
  OTHER_STACK_KEY,
  type StackPoint,
} from "@/lib/chart-stack";
import type { BreakdownMember } from "@/lib/chart-breakdown";

const m = (id: number, name: string, value: number): BreakdownMember => ({ id, name, value });

/** Sum every numeric band on a row (excludes the date string). */
function rowBandSum(row: Record<string, string | number>): number {
  return Object.entries(row)
    .filter(([k]) => k !== "date")
    .reduce((s, [, v]) => s + (typeof v === "number" ? v : 0), 0);
}

describe("buildStackedSeries", () => {
  it("emits one row per point with the date under the default dateKey", () => {
    const points: StackPoint[] = [
      { date: "2026-01-01", total: 30, members: [m(1, "A", 10), m(2, "B", 20)] },
      { date: "2026-01-02", total: 40, members: [m(1, "A", 15), m(2, "B", 25)] },
    ];
    const { rows } = buildStackedSeries(points);
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe("2026-01-01");
    expect(rows[1].date).toBe("2026-01-02");
  });

  it("preserves the aggregate: band sum equals total at every point (no Other)", () => {
    const points: StackPoint[] = [
      { date: "d1", total: 30, members: [m(1, "A", 10), m(2, "B", 20)] },
      { date: "d2", total: 50, members: [m(1, "A", 30), m(2, "B", 20)] },
    ];
    const { rows, legend } = buildStackedSeries(points, { maxMembers: 10 });
    expect(legend.some((l) => l.isOther)).toBe(false);
    expect(rowBandSum(rows[0])).toBeCloseTo(30, 6);
    expect(rowBandSum(rows[1])).toBeCloseTo(50, 6);
  });

  it("collapses members past maxMembers into a signed Other residual that ties to total", () => {
    // 13 members; top-10 kept, tail (3) → Other.
    const members = Array.from({ length: 13 }, (_, i) => m(i, `m${i}`, i + 1));
    const total = members.reduce((s, x) => s + x.value, 0); // 91
    const { rows, legend } = buildStackedSeries([{ date: "d1", total, members }], {
      maxMembers: 10,
    });
    const other = legend.find((l) => l.isOther);
    expect(other).toBeDefined();
    expect(legend.filter((l) => !l.isOther)).toHaveLength(10);
    // Outer stack boundary equals the aggregate at this point.
    expect(rowBandSum(rows[0])).toBeCloseTo(total, 6);
    // The residual key carries the signed remainder (1+2+3 = 6).
    expect(rows[0][OTHER_STACK_KEY]).toBeCloseTo(6, 6);
  });

  it("ranks bands by average absolute contribution across the whole window", () => {
    // B dominates on average even though A leads on the first point.
    const points: StackPoint[] = [
      { date: "d1", total: 30, members: [m(1, "A", 25), m(2, "B", 5)] },
      { date: "d2", total: 200, members: [m(1, "A", 5), m(2, "B", 195)] },
    ];
    const { legend } = buildStackedSeries(points, { maxMembers: 1 });
    // maxMembers=1 → only the top-ranked member named; the rest → Other.
    expect(legend[0].name).toBe("B");
    expect(legend.some((l) => l.isOther)).toBe(true);
  });

  it("seeds absent members to 0 so a band stays flat on a gap (no dropped series)", () => {
    const points: StackPoint[] = [
      { date: "d1", total: 30, members: [m(1, "A", 10), m(2, "B", 20)] },
      { date: "d2", total: 20, members: [m(2, "B", 20)] }, // A absent
    ];
    const { rows, legend } = buildStackedSeries(points, { maxMembers: 10 });
    const aKey = legend.find((l) => l.name === "A")!.key;
    expect(rows[1][aKey]).toBe(0);
    expect(rowBandSum(rows[1])).toBeCloseTo(20, 6);
  });

  it("honours a custom dateKey and otherLabel", () => {
    const members = Array.from({ length: 12 }, (_, i) => m(i, `m${i}`, i + 1));
    const total = members.reduce((s, x) => s + x.value, 0);
    const { rows, legend } = buildStackedSeries([{ date: "2026-03", total, members }], {
      maxMembers: 10,
      dateKey: "month",
      otherLabel: "Everything else",
    });
    expect(rows[0].month).toBe("2026-03");
    expect(legend.find((l) => l.isOther)!.name).toBe("Everything else");
  });

  it("keys members by id so same-name distinct ids stay separate bands", () => {
    const points: StackPoint[] = [
      {
        date: "d1",
        total: 30,
        members: [m(1, "Cash", 10), m(2, "Cash", 20)],
      },
    ];
    const { legend } = buildStackedSeries(points, { maxMembers: 10 });
    // Two distinct ids → two bands even though the names collide.
    expect(legend.filter((l) => !l.isOther)).toHaveLength(2);
  });

  it("returns empty rows + empty legend for no points", () => {
    const { rows, legend } = buildStackedSeries([]);
    expect(rows).toEqual([]);
    expect(legend).toEqual([]);
  });
});

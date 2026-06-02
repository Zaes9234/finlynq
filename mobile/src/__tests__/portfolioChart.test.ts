import { cumulativeFractions, arcPath, seriesRange, scalePoints } from "../lib/portfolio/chart";

describe("cumulativeFractions", () => {
  it("splits values into cumulative [start,end) fractions", () => {
    const f = cumulativeFractions([50, 30, 20]);
    expect(f[0]).toEqual({ start: 0, end: 0.5 });
    expect(f[1]).toEqual({ start: 0.5, end: 0.8 });
    expect(f[2].end).toBe(1); // last snaps to exactly 1
  });

  it("returns empty for empty input", () => {
    expect(cumulativeFractions([])).toEqual([]);
  });

  it("yields all-zero segments when the total is non-positive", () => {
    expect(cumulativeFractions([0, 0])).toEqual([
      { start: 0, end: 0 },
      { start: 0, end: 0 },
    ]);
  });

  it("clamps negative values to 0", () => {
    const f = cumulativeFractions([-10, 100]);
    expect(f[0]).toEqual({ start: 0, end: 0 });
    expect(f[1].end).toBe(1);
  });
});

describe("arcPath", () => {
  it("returns a closed donut-wedge path", () => {
    const d = arcPath(50, 50, 50, 30, 0, 0.25);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("A");
    expect(d.endsWith("Z")).toBe(true);
  });

  it("does not blow up on a full-circle wedge", () => {
    const d = arcPath(50, 50, 50, 30, 0, 1);
    expect(typeof d).toBe("string");
    expect(d.length).toBeGreaterThan(0);
  });

  it("returns empty string for a zero/negative span", () => {
    expect(arcPath(50, 50, 50, 30, 0.5, 0.5)).toBe("");
  });
});

describe("seriesRange", () => {
  it("computes the combined min/max across series", () => {
    expect(seriesRange([[1, 2, 3], [2, 4]])).toEqual({ min: 1, max: 4 });
  });

  it("expands a flat series so it has a non-zero span", () => {
    expect(seriesRange([[5, 5, 5]])).toEqual({ min: 4, max: 6 });
  });

  it("defaults to 0..1 for empty input", () => {
    expect(seriesRange([[]])).toEqual({ min: 0, max: 1 });
  });
});

describe("scalePoints", () => {
  it("inverts the Y axis (max value sits highest)", () => {
    const pts = scalePoints([0, 10], 0, 10, 100, 100, 0).split(" ");
    expect(pts).toHaveLength(2);
    const [, y0] = pts[0].split(",").map(Number);
    const [, y1] = pts[1].split(",").map(Number);
    expect(y0).toBeGreaterThan(y1); // value 0 lower on screen than value 10
  });

  it("centers a single point horizontally", () => {
    expect(scalePoints([5], 0, 10, 100, 100, 0)).toBe("50,50");
  });

  it("returns empty for no values", () => {
    expect(scalePoints([], 0, 10, 100, 100)).toBe("");
  });
});

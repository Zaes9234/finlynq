import { describe, it, expect } from "vitest";
import { resolvePreviousClose, deriveDayChange } from "@/lib/price-service";

// FINLYNQ-92 follow-up — Yahoo's chart API omits `meta.previousClose` whenever
// the regular session is closed (weekends, exchange holidays, pre-/after-hours)
// and only returns `meta.chartPreviousClose`. `resolvePreviousClose` must fall
// back to it so day-change survives closed markets. Pure functions, no DB/network.
describe("resolvePreviousClose", () => {
  it("prefers meta.previousClose when present (weekday / in-session)", () => {
    expect(resolvePreviousClose({ previousClose: 304.99, chartPreviousClose: 300 })).toBe(304.99);
  });

  it("falls back to chartPreviousClose when previousClose is absent (closed market)", () => {
    // The weekend/after-hours shape: previousClose omitted, chartPreviousClose present.
    expect(resolvePreviousClose({ chartPreviousClose: 304.99 })).toBe(304.99);
    expect(resolvePreviousClose({ previousClose: null, chartPreviousClose: 304.99 })).toBe(304.99);
  });

  it("returns null when both are absent (back-compat: degrades to 0/0)", () => {
    expect(resolvePreviousClose({})).toBe(null);
    expect(resolvePreviousClose({ previousClose: null, chartPreviousClose: null })).toBe(null);
    expect(resolvePreviousClose(null)).toBe(null);
    expect(resolvePreviousClose(undefined)).toBe(null);
  });

  it("does not treat a 0 previousClose as missing (uses ?? not ||)", () => {
    // ?? only falls through on null/undefined, so a genuine 0 close is kept
    // (deriveDayChange then guards the divide-by-zero separately).
    expect(resolvePreviousClose({ previousClose: 0, chartPreviousClose: 304.99 })).toBe(0);
  });
});

// End-to-end: the resolved previousClose feeds deriveDayChange. These three
// cases mirror the handover's required coverage.
describe("resolvePreviousClose + deriveDayChange (closed-market day change)", () => {
  it("computes a non-zero change when only chartPreviousClose is available", () => {
    const prev = resolvePreviousClose({ regularMarketPrice: 308.82, chartPreviousClose: 304.99 } as never);
    const { change, changePct } = deriveDayChange(308.82, prev);
    expect(change).toBeCloseTo(3.83, 2);
    expect(changePct).toBeCloseTo(1.2558, 3);
  });

  it("prefers previousClose when both are present", () => {
    const prev = resolvePreviousClose({ previousClose: 305, chartPreviousClose: 999 });
    const { change } = deriveDayChange(308.82, prev);
    expect(change).toBeCloseTo(3.82, 2);
  });

  it("degrades to 0/0 when neither prior-close field is present", () => {
    const prev = resolvePreviousClose({ regularMarketPrice: 308.82 } as never);
    expect(deriveDayChange(308.82, prev)).toEqual({ change: 0, changePct: 0 });
  });
});

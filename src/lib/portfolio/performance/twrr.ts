/**
 * Time-weighted rate of return (TWRR) — Phase 3 of
 * plan/portfolio-lots-and-performance.md.
 *
 * Modified Dietz approximation: returns the period's return adjusted
 * for the timing of contributions. Pure function — no DB I/O. Caller
 * passes daily snapshots (market_value at each bar) and any net
 * contributions on or between bars.
 *
 * For a single period [t0, t1]:
 *
 *   r = (mv_t1 − mv_t0 − Σ contributions) / (mv_t0 + Σ weighted_contributions)
 *
 *   where weighted_contribution = contribution × ((t1 − contrib_date) / (t1 − t0))
 *
 * Chained across daily bars, the per-day returns multiply
 * geometrically to yield the period TWRR:
 *
 *   TWRR = (1 + r_1) × (1 + r_2) × ... × (1 + r_n) − 1
 *
 * Validates against the CFA Modified-Dietz worked example fixture in
 * tests/portfolio-twrr.test.ts. Annualization is the caller's job —
 * the function returns a period rate, not an annualized one.
 */

export interface DailySnapshotPoint {
  date: string;        // YYYY-MM-DD
  marketValue: number;
  /** Net contribution on this snap_date (transfer-in − transfer-out). */
  contribution: number;
}

export interface TwrrResult {
  periodReturn: number;        // 0.05 = +5% over the period
  dailyReturns: Array<{ date: string; r: number }>;
  /** True if any bar had non-zero contribution; useful for UI badge. */
  hadContributions: boolean;
}

/**
 * Computes TWRR over the chronological snapshots. Caller pre-sorts
 * by date ASC; the function does NOT sort defensively.
 */
export function computeTwrr(
  snapshots: DailySnapshotPoint[],
): TwrrResult {
  if (snapshots.length < 2) {
    return { periodReturn: 0, dailyReturns: [], hadContributions: false };
  }

  const dailyReturns: Array<{ date: string; r: number }> = [];
  let chained = 1;
  let hadContributions = false;

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    const contribution = cur.contribution;
    if (contribution !== 0) hadContributions = true;
    // Modified Dietz over a single day → contribution is assumed to land
    // at the START of the day (most conservative — drives the largest
    // weighted contribution). When prev.marketValue is 0 (account just
    // opened today with a contribution), the bar's return is 0.
    const denom = prev.marketValue + contribution;
    const r = denom !== 0
      ? (cur.marketValue - prev.marketValue - contribution) / denom
      : 0;
    dailyReturns.push({ date: cur.date, r });
    chained *= 1 + r;
  }

  return {
    periodReturn: chained - 1,
    dailyReturns,
    hadContributions,
  };
}

/**
 * Annualize a period return given the period length in days. Uses the
 * compound-annual formula: (1 + r)^(365 / days) - 1.
 */
export function annualizeReturn(periodReturn: number, days: number): number {
  if (days <= 0) return 0;
  return Math.pow(1 + periodReturn, 365 / days) - 1;
}

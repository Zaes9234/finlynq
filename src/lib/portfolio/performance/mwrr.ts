/**
 * Money-weighted rate of return (MWRR / IRR) — Phase 3 of
 * plan/portfolio-lots-and-performance.md.
 *
 * Pure Newton-Raphson IRR. Caller supplies dated cash flows and the
 * final value of the portfolio (treated as a final outflow). Returns
 * the annualized rate r such that:
 *
 *   Σ_i  cf_i / (1 + r)^((t_i − t_0) / 365)  =  0
 *
 * Convention: cash INTO the portfolio is NEGATIVE (you spent it); cash
 * OUT of the portfolio is POSITIVE (you got it back). The final
 * value is added as a positive flow on the as-of date. Matches Excel
 * XIRR exactly when the date axis is the same.
 */

export interface CashFlow {
  date: string;     // YYYY-MM-DD
  amount: number;   // negative = contribution into the account; positive = withdrawal
}

export interface MwrrResult {
  irr: number;            // annualized; 0.05 = +5%/yr
  iterations: number;
  converged: boolean;
}

/**
 * Newton-Raphson IRR. Defaults to 50 iterations × 1e-8 tolerance.
 *
 * Returns `converged: false` when the iteration didn't find a root.
 * Common cause: all-positive or all-negative cash flow (no sign
 * change → no root). Callers should check `converged` before using
 * `irr` in user-facing math.
 */
export function computeMwrr(
  cashFlows: CashFlow[],
  finalValue: number,
  asOfDate: string,
  opts: { maxIter?: number; tol?: number; initialGuess?: number } = {},
): MwrrResult {
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-8;
  let r = opts.initialGuess ?? 0.1;

  // Build the flat flow list: each user contribution + a single final
  // outflow representing the as-of portfolio value (positive = "we
  // got this back when we closed out").
  const flows: CashFlow[] = [...cashFlows, { date: asOfDate, amount: finalValue }];
  if (flows.length < 2) {
    return { irr: 0, iterations: 0, converged: false };
  }
  const t0 = Date.parse(`${flows[0].date}T00:00:00Z`);

  const tsYears = (date: string): number => {
    const ms = Date.parse(`${date}T00:00:00Z`) - t0;
    return ms / (365 * 86400000);
  };

  for (let i = 0; i < maxIter; i++) {
    let npv = 0;
    let dnpv = 0;
    for (const f of flows) {
      const t = tsYears(f.date);
      const denom = Math.pow(1 + r, t);
      npv += f.amount / denom;
      dnpv += -t * f.amount / Math.pow(1 + r, t + 1);
    }
    if (Math.abs(npv) < tol) {
      return { irr: r, iterations: i + 1, converged: true };
    }
    if (Math.abs(dnpv) < 1e-12) {
      // Flat tangent — bump the guess and continue.
      r = r + 0.001;
      continue;
    }
    r = r - npv / dnpv;
    if (r <= -0.999) r = -0.999; // clamp pathological undershoot
  }

  return { irr: r, iterations: maxIter, converged: false };
}

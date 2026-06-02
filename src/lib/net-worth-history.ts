/**
 * Net Worth & Account Balance Over Time — pure core.
 *
 * Builds a daily series merging two data sources that the rest of the app
 * already trusts:
 *   - CASH / LIABILITY accounts: cumulative `SUM(transactions.amount)` per day
 *     (computed live from the `transactions` ledger).
 *   - INVESTMENT accounts: market value read from the stored daily
 *     `portfolio_snapshots` (nearest snapshot at-or-before each grid day),
 *     with TODAY substituted by the live holdings aggregator so the latest
 *     point matches the dashboard hero net-worth number exactly.
 *
 * Why not the legacy `getNetWorthOverTime()` (pure SUM of tx amounts)? For an
 * investment account the buy/sell legs net to ~0 under the two-leg convention,
 * so its real value is `holdings.value` (market value), not its tx sum. This
 * module excludes investment accounts from the cash sum and reads their value
 * from snapshots instead.
 *
 * Pure / unit-testable: no DB, no HTTP, no `Date.now()`. The caller supplies
 * `today` and pre-fetched rows. FX uses the same CURRENT-rate approximation as
 * the existing dashboard chart (`convertWithRateMap`); historical-rate FX for
 * the cash side is an explicit out-of-scope follow-up.
 */

import { convertWithRateMap } from "@/lib/fx-service";

export type NetWorthPeriod = "6m" | "1y" | "all";

/** Per-day, per-currency cash delta for non-investment accounts (sorted asc by date). */
export interface CashDelta {
  date: string; // YYYY-MM-DD
  currency: string;
  delta: number;
}

/** One per-account portfolio snapshot row. `marketValue` is in `currency`. */
export interface InvestmentSnapshot {
  accountId: number;
  snapDate: string; // YYYY-MM-DD
  marketValue: number;
  currency: string;
}

/** Live (today's) holdings value per investment account, in account currency. */
export interface LiveInvestmentValue {
  value: number;
  currency: string;
}

export interface BuildNetWorthHistoryInput {
  period: NetWorthPeriod;
  displayCurrency: string;
  /** Rate map keyed by source currency → factor to displayCurrency (getRateMap). */
  rateMap: Map<string, number>;
  /** All cash/liability deltas over ALL history (sorted asc by date). */
  cashDeltas: CashDelta[];
  /** Per-account investment snapshots over the requested range (any order). */
  snapshots: InvestmentSnapshot[];
  /**
   * Today's live holdings value per investment account (account currency).
   * Used to override the snapshot value on the final grid day so the latest
   * point matches the dashboard hero exactly. Restrict to non-archived
   * investment accounts in the caller to mirror the hero's account set.
   */
  liveInvestmentByAccount?: Map<number, LiveInvestmentValue>;
  /** Today, YYYY-MM-DD (UTC). The grid never extends past this. */
  today: string;
}

export interface NetWorthPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface BuildNetWorthHistoryResult {
  series: NetWorthPoint[];
  hasInvestmentData: boolean;
  /** Always true — the cash side uses current-rate FX (documented approximation). */
  fxApproximation: true;
}

const PERIOD_DAYS: Record<Exclude<NetWorthPeriod, "all">, number> = {
  "6m": 180,
  "1y": 365,
};

/** Add `days` (can be negative) to an ISO date, dialect-agnostic via UTC. */
function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ascending min of two optional ISO dates */
function minDate(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return a < b ? a : b;
}

export function buildNetWorthHistory(
  input: BuildNetWorthHistoryInput,
): BuildNetWorthHistoryResult {
  const {
    period,
    rateMap,
    cashDeltas,
    snapshots,
    liveInvestmentByAccount,
    today,
  } = input;

  const hasInvestmentData =
    snapshots.length > 0 || (liveInvestmentByAccount?.size ?? 0) > 0;

  // ── 1. Determine the first grid day ──────────────────────────────────────
  let firstDay: string;
  if (period === "all") {
    const earliestCash = cashDeltas.length > 0 ? cashDeltas[0].date : null;
    const earliestSnap =
      snapshots.length > 0
        ? snapshots.reduce<string | null>(
            (m, s) => (m == null || s.snapDate < m ? s.snapDate : m),
            null,
          )
        : null;
    firstDay = minDate(earliestCash, earliestSnap) ?? today;
  } else {
    firstDay = addDaysISO(today, -PERIOD_DAYS[period]);
  }
  if (firstDay > today) firstDay = today;

  // Sort the cash deltas defensively (the query orders by date, but a pure
  // function shouldn't assume it).
  const sortedDeltas = [...cashDeltas].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  // ── 2. Pre-group + sort investment snapshots per account ─────────────────
  const snapsByAccount = new Map<number, InvestmentSnapshot[]>();
  for (const s of snapshots) {
    const arr = snapsByAccount.get(s.accountId) ?? [];
    arr.push(s);
    snapsByAccount.set(s.accountId, arr);
  }
  for (const arr of snapsByAccount.values()) {
    arr.sort((a, b) =>
      a.snapDate < b.snapDate ? -1 : a.snapDate > b.snapDate ? 1 : 0,
    );
  }

  // Per-account walking pointer + last carried value (in displayCurrency).
  const snapState = new Map<
    number,
    { ptr: number; lastValue: number; rows: InvestmentSnapshot[] }
  >();
  for (const [accountId, rows] of snapsByAccount) {
    snapState.set(accountId, { ptr: 0, lastValue: 0, rows });
  }

  // ── 3. Walk the daily grid ───────────────────────────────────────────────
  const series: NetWorthPoint[] = [];
  const runningByCcy = new Map<string, number>();
  let deltaPtr = 0;

  let day = firstDay;
  // Hard guard against pathological inputs (never loop more than ~30y of days).
  const MAX_DAYS = 30 * 366;
  let guard = 0;

  while (day <= today && guard < MAX_DAYS) {
    guard++;

    // Cash pass: fold in every delta whose date is on-or-before this grid day.
    while (deltaPtr < sortedDeltas.length && sortedDeltas[deltaPtr].date <= day) {
      const d = sortedDeltas[deltaPtr];
      const ccy = d.currency.toUpperCase();
      runningByCcy.set(ccy, (runningByCcy.get(ccy) ?? 0) + d.delta);
      deltaPtr++;
    }
    let cash = 0;
    for (const [ccy, cum] of runningByCcy) {
      cash += convertWithRateMap(cum, ccy, rateMap);
    }

    // Investment pass: nearest snapshot at-or-before this grid day, per account,
    // carried forward across quiet days.
    let investment = 0;
    const isFinalDay = day === today;
    if (isFinalDay && liveInvestmentByAccount && liveInvestmentByAccount.size > 0) {
      // Substitute the live holdings value so the last point matches the hero.
      for (const [, live] of liveInvestmentByAccount) {
        investment += convertWithRateMap(live.value, live.currency, rateMap);
      }
    } else {
      for (const st of snapState.values()) {
        while (st.ptr < st.rows.length && st.rows[st.ptr].snapDate <= day) {
          const snap = st.rows[st.ptr];
          st.lastValue = convertWithRateMap(
            snap.marketValue,
            snap.currency,
            rateMap,
          );
          st.ptr++;
        }
        investment += st.lastValue;
      }
    }

    series.push({ date: day, value: Math.round((cash + investment) * 100) / 100 });

    if (day === today) break;
    day = addDaysISO(day, 1);
  }

  return { series, hasInvestmentData, fxApproximation: true };
}

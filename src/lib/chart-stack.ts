/**
 * chart-stack.ts — shared pure util for the FINLYNQ-129 stacked-member toggle.
 *
 * Turns a set of value-over-time points, each carrying a per-member breakdown,
 * into the row shape Recharts `<Area stackId>` needs PLUS the legend describing
 * each coloured band. Builds ON the FINLYNQ-128 breakdown layer: callers pass
 * the same `BreakdownMember`-shaped members (id + display name + value) that the
 * tooltip uses; the names are already DEK-resolved at the API boundary.
 *
 * What it does (single source of truth for the stacking math):
 *   1. Rank members by AVERAGE absolute contribution across the WHOLE window
 *      (per the item spec — re-ranks when the caller passes a new window), then
 *      keep the top `maxMembers` distinct member keys.
 *   2. Emit one row per point: `{ [dateKey]: date, <key>: value, … , __other }`
 *      where each kept key gets that point's value (0 when absent) and `__other`
 *      is the SIGNED residual `total − Σ(kept)` so the outer stack boundary
 *      equals the aggregate `total` at EVERY point (tc-1 / tc-2 / tc-3 gate).
 *   3. Return a `legend` (key → display name → palette colour) — "Other" always
 *      takes the last/neutral slot.
 *
 * PURE / CLIENT-SAFE: zero deps beyond the shared palette + the BreakdownMember
 * type, no @/db, no next/server, no Date.now(). Safe from "use client".
 */

import type { BreakdownMember } from "@/lib/chart-breakdown";
import { CHART_COLORS } from "@/lib/chart-colors";

/** Stable key prefix for a member band data key (avoids collisions with "date"/"total"). */
export const STACK_KEY_PREFIX = "m_";
/** Reserved data key for the collapsed "Other" residual band. */
export const OTHER_STACK_KEY = "__other";

/** One point on the value-over-time axis with its per-member decomposition. */
export interface StackPoint {
  /** X-axis value (ISO date or "YYYY-MM" month label). */
  date: string;
  /** The aggregate value at this point — the stack's outer boundary must equal it. */
  total: number;
  /** Per-member contributions at this point. Names pre-resolved by the caller. */
  members: BreakdownMember[];
}

export interface BuildStackedSeriesOptions {
  /** Max named bands before the tail collapses into "Other". Default 10. */
  maxMembers?: number;
  /** Property name to write the X value under in each row. Default "date". */
  dateKey?: string;
  /** Label for the residual band. Default "Other". */
  otherLabel?: string;
}

/** One coloured band in the legend / one `<Area>` to render, in stack order. */
export interface StackLegendEntry {
  /** Data key on each row (e.g. "m_42" or "__other"). */
  key: string;
  /** Display name for the legend. */
  name: string;
  /** Palette colour. */
  color: string;
  /** True for the collapsed "Other" residual band. */
  isOther: boolean;
}

export interface StackedSeriesResult {
  /** Recharts rows: `{ [dateKey]: string, [key]: number, … }`. */
  rows: Array<Record<string, string | number>>;
  /**
   * Bands in render order (top-N desc by average contribution, then "Other"
   * last). Drives both the `<Area stackId>` list and the legend below the chart.
   */
  legend: StackLegendEntry[];
}

/** Stable string key for a member (its id when present, else its name). */
function memberKey(m: BreakdownMember): string {
  const raw = m.id != null ? String(m.id) : `name:${m.name}`;
  return `${STACK_KEY_PREFIX}${raw}`;
}

/**
 * Pick the colour for the i-th band from the shared palette, cycling if there
 * are more bands than palette slots. "Other" always uses the neutral slot.
 */
function bandColor(index: number): string {
  const palette = CHART_COLORS.categories;
  return palette[index % palette.length];
}

/**
 * Build the stacked-series rows + legend from per-point member breakdowns.
 *
 * Invariants (exercised by the unit test):
 *  - legend has ≤ maxMembers named bands + at most ONE "Other" band (present
 *    iff the window has more than maxMembers distinct contributing members).
 *  - For every row, Σ(kept band values) + __other === that point's `total`
 *    (modulo float) — the outer stack boundary equals the aggregate.
 *  - Ranking is by AVERAGE |value| across all points (re-derived per call, so a
 *    new time window re-ranks). Zero-only members never enter the top-N.
 *  - "Other" band is omitted entirely (no key on rows, no legend entry) when no
 *    member falls outside the top-N.
 */
export function buildStackedSeries(
  points: StackPoint[],
  options: BuildStackedSeriesOptions = {},
): StackedSeriesResult {
  const maxMembers = options.maxMembers ?? 10;
  const dateKey = options.dateKey ?? "date";
  const otherLabel = options.otherLabel ?? "Other";

  // ── 1. Aggregate each member across the window: sum |value| + remember name ──
  const agg = new Map<
    string,
    { key: string; name: string; absSum: number }
  >();
  for (const p of points) {
    for (const m of p.members) {
      if (!Number.isFinite(m.value) || m.value === 0) continue;
      const key = memberKey(m);
      const cur = agg.get(key) ?? { key, name: m.name, absSum: 0 };
      cur.absSum += Math.abs(m.value);
      // Prefer the most recent non-empty name we see (names are stable per key).
      if (m.name) cur.name = m.name;
      agg.set(key, cur);
    }
  }

  const n = points.length || 1;
  // Average absolute contribution over the window drives the ranking.
  const ranked = [...agg.values()].sort((a, b) => {
    const da = b.absSum - a.absSum;
    if (da !== 0) return da;
    return a.name.localeCompare(b.name);
  });

  const topKeys = ranked.slice(0, maxMembers);
  const hasOther = ranked.length > maxMembers;
  const topKeySet = new Set(topKeys.map((r) => r.key));

  // ── 2. Build the legend (top-N in rank order, then "Other" in the last slot) ──
  const legend: StackLegendEntry[] = topKeys.map((r, i) => ({
    key: r.key,
    name: r.name,
    color: bandColor(i),
    isOther: false,
  }));
  if (hasOther) {
    legend.push({
      key: OTHER_STACK_KEY,
      name: otherLabel,
      color: CHART_COLORS.neutral,
      isOther: true,
    });
  }

  // ── 3. Emit one row per point ────────────────────────────────────────────
  const rows: Array<Record<string, string | number>> = points.map((p) => {
    const row: Record<string, string | number> = { [dateKey]: p.date };
    // Seed every kept band to 0 so absent members render as a flat band (and
    // Recharts doesn't drop the series on a gap).
    for (const k of topKeySet) row[k] = 0;
    let keptSum = 0;
    for (const m of p.members) {
      if (!Number.isFinite(m.value) || m.value === 0) continue;
      const key = memberKey(m);
      if (topKeySet.has(key)) {
        row[key] = (row[key] as number) + m.value;
        keptSum += m.value;
      }
    }
    if (hasOther) {
      // SIGNED residual preserves the aggregate: kept + other === total.
      row[OTHER_STACK_KEY] = Math.round((p.total - keptSum) * 100) / 100;
    }
    // Round kept bands too so the rendered stack ties to the rounded total.
    for (const k of topKeySet) {
      row[k] = Math.round((row[k] as number) * 100) / 100;
    }
    return row;
  });

  void n; // average is implicit in absSum ordering; kept for documentation parity
  return { rows, legend };
}

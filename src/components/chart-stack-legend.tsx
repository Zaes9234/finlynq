"use client";

/**
 * StackedChartLegend — the legend rendered BELOW a chart in FINLYNQ-129's
 * stacked-member mode. One coloured swatch + name per band, in stack order
 * (top-N desc by contribution, "Other" last). Wraps on small viewports so the
 * mobile case (tc — "legend readable") stays legible.
 *
 * Pairs with `buildStackedSeries` (src/lib/chart-stack.ts): pass the `legend`
 * it returns straight through.
 */

import type { StackLegendEntry } from "@/lib/chart-stack";

export function StackedChartLegend({ legend }: { legend: StackLegendEntry[] }) {
  if (legend.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 mt-3">
      {legend.map((entry) => (
        <div
          key={entry.key}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <span
            className="h-2.5 w-2.5 rounded-[3px] shrink-0"
            style={{ backgroundColor: entry.color }}
          />
          <span className="truncate max-w-[160px]" title={entry.name}>
            {entry.name}
          </span>
        </div>
      ))}
    </div>
  );
}

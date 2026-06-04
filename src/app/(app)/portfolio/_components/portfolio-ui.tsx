"use client";

/**
 * Small presentational helpers for the portfolio page (FINLYNQ-118 Phase 3).
 *
 * Tooltips, the change badge, the day-change cell, and the loading skeleton —
 * all extracted verbatim from portfolio/page.tsx so the page + the sub-surface
 * components can share them.
 */

import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { ColorDot } from "@/components/csp-safe-bar";

// ── Tooltip Components ──────────────────────────────────────────────
export function GlassTooltip({
  active, payload, label, formatter,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color?: string; payload?: Record<string, unknown> }[];
  label?: string;
  formatter?: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg">
      {label && <p className="text-xs text-muted-foreground mb-1">{label}</p>}
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          {entry.color && <ColorDot color={entry.color} />}
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-semibold">
            {formatter ? formatter(entry.value, entry.name) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ExposurePieTooltip({
  active, payload,
}: {
  active?: boolean;
  payload?: { name: string; value: number; payload: { name: string; pct: number } }[];
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div className="rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold">{entry.payload.name}</p>
      <p className="text-sm font-bold">{entry.payload.pct}%</p>
    </div>
  );
}

// ── Change Badge ────────────────────────────────────────────────────
export function ChangeBadge({ value, className = "" }: { value: number | null; className?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">--</span>;
  const isPositive = value >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono text-sm font-medium ${isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"} ${className}`}>
      {isPositive ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {Math.abs(value).toFixed(2)}%
    </span>
  );
}

// Day-change as a percentage badge with the dollar amount (display currency)
// shown inline beside it. `amount` is this holding's contribution to the
// portfolio day change (change-per-unit × qty, FX-converted server-side).
export function DayChange({
  pct,
  amount,
  currency,
}: { pct: number | null; amount: number | null; currency: string }) {
  if (pct === null || pct === undefined) return <span className="text-muted-foreground">--</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
      <ChangeBadge value={pct} />
      {amount !== null && amount !== undefined && (
        <span className={`text-xs font-mono ${amount >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
          {amount >= 0 ? "+" : ""}{formatCurrency(amount, currency)}
        </span>
      )}
    </span>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────
export function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-48 bg-muted animate-shimmer rounded-lg" />
        <div className="h-4 w-72 bg-muted animate-shimmer rounded-lg mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-5">
              <div className="space-y-2">
                <div className="h-3 w-20 bg-muted animate-shimmer rounded" />
                <div className="h-8 w-28 bg-muted animate-shimmer rounded" />
                <div className="h-3 w-16 bg-muted animate-shimmer rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader><div className="h-5 w-36 bg-muted animate-shimmer rounded" /></CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 py-2">
              <div className="h-8 w-8 rounded-full bg-muted animate-shimmer" />
              <div className="h-4 w-24 bg-muted animate-shimmer rounded" />
              <div className="h-4 w-16 bg-muted animate-shimmer rounded ml-auto" />
              <div className="h-4 w-16 bg-muted animate-shimmer rounded" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

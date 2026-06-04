"use client";

/**
 * Portfolio-page data hooks (FINLYNQ-118 Phase 3).
 *
 * Extracted from portfolio/page.tsx. Behaviour-preserving: same fetch URLs,
 * same triggers (displayCurrency for overview; period + enabled for
 * benchmarks), same `setData`/`setLoading` semantics, same soft-fail to a
 * cleared loading flag. NO data-fetching library (that is FINLYNQ-115) — the
 * bespoke fetch / useState / useEffect / finally pattern is kept verbatim.
 */

import { useCallback, useEffect, useState } from "react";
import type { BenchmarkData, OverviewData } from "../_types";

/**
 * Fetch portfolio overview — re-runs when display currency changes so
 * totals + currency-as-holding prices reflect the user's choice.
 *
 * `reload()` is the imperative refetch the holding edit/create dialog calls
 * on save — it re-arms `loading` before fetching, exactly as the inline
 * onSave handler did.
 */
export function usePortfolioOverview(displayCurrency: string) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/portfolio/overview?currency=${encodeURIComponent(displayCurrency)}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [displayCurrency]);

  const reload = useCallback(() => {
    setLoading(true);
    fetch(`/api/portfolio/overview?currency=${encodeURIComponent(displayCurrency)}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, [displayCurrency]);

  return { data, loading, reload };
}

/**
 * Fetch benchmarks (dev mode only). The `enabled` gate mirrors the inline
 * `if (!devMode) return` early-out — when false the effect never fires and
 * the series stays empty.
 */
export function useBenchmarks(period: string, enabled: boolean) {
  const [benchmarks, setBenchmarks] = useState<BenchmarkData[]>([]);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    setBenchmarkLoading(true);
    fetch(`/api/portfolio/benchmarks?period=${period}`)
      .then(r => r.json())
      .then(d => { setBenchmarks(d.benchmarks ?? []); setBenchmarkLoading(false); })
      .catch(() => setBenchmarkLoading(false));
  }, [period, enabled]);

  return { benchmarks, benchmarkLoading };
}

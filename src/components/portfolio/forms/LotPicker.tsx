"use client";

/**
 * LotPicker — per-lot quantity selector for SellForm (Phase 3, 2026-05-26).
 *
 * Each open lot gets a numeric input for "shares from this lot". The total
 * sell quantity becomes the sum of these inputs. If the user enters more
 * shares for a lot than that lot has open (or types a total exceeding the
 * holding's open inventory), the form surfaces a warning that the excess
 * will open a short position on the holding.
 *
 * Fully controlled — parent owns the `selection` map (lotId → qty).
 */

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/currency";

interface OpenLot {
  lotId: number;
  openDate: string;
  qty: number;
  costPerShare: number;
  costBasis: number;
}

interface LotPickerApiResponse {
  lots?: OpenLot[];
  data?: { lots?: OpenLot[] };
}

export interface LotPickerSelection {
  lotId: number;
  qty: number;
}

interface LotPickerProps {
  holdingId: number;
  currency: string;
  selection: LotPickerSelection[];
  onChange: (selection: LotPickerSelection[]) => void;
}

export default function LotPicker({
  holdingId,
  currency,
  selection,
  onChange,
}: LotPickerProps) {
  const [state, setState] = useState<{
    forHoldingId: number;
    lots: OpenLot[] | null;
    loading: boolean;
    unavailable: boolean;
  }>(() => ({
    forHoldingId: holdingId,
    lots: null,
    loading: true,
    unavailable: false,
  }));
  if (state.forHoldingId !== holdingId) {
    setState({
      forHoldingId: holdingId,
      lots: null,
      loading: true,
      unavailable: false,
    });
  }
  const { lots, loading, unavailable } = state;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/portfolio/lots?holdingId=${holdingId}&openOnly=1`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setState((s) =>
            s.forHoldingId === holdingId
              ? { ...s, unavailable: true, loading: false }
              : s,
          );
          return;
        }
        const json: LotPickerApiResponse = await r.json().catch(() => ({}));
        const rows = json.lots ?? json.data?.lots ?? null;
        if (!Array.isArray(rows)) {
          setState((s) =>
            s.forHoldingId === holdingId
              ? { ...s, unavailable: true, loading: false }
              : s,
          );
          return;
        }
        setState((s) =>
          s.forHoldingId === holdingId
            ? { ...s, lots: rows, loading: false }
            : s,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState((s) =>
          s.forHoldingId === holdingId
            ? { ...s, unavailable: true, loading: false }
            : s,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [holdingId]);

  function updateQty(lotId: number, qty: number) {
    const next = selection.filter((s) => s.lotId !== lotId);
    if (qty > 0) next.push({ lotId, qty });
    onChange(next);
  }

  function getQty(lotId: number): number {
    return selection.find((s) => s.lotId === lotId)?.qty ?? 0;
  }

  if (loading) {
    return (
      <p className="text-xs text-muted-foreground">Loading open lots…</p>
    );
  }
  if (unavailable || !lots) {
    return (
      <p className="text-xs text-muted-foreground">
        Lot picker not available — using FIFO.
      </p>
    );
  }
  if (lots.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No open lots for this holding.
      </p>
    );
  }

  const totalAvailable = lots.reduce((s, l) => s + l.qty, 0);
  const totalSelected = selection.reduce((s, sel) => s + sel.qty, 0);

  return (
    <div className="space-y-1.5">
      <div className="max-h-56 overflow-y-auto rounded-md border border-border/60 bg-muted/30 p-2">
        <ul className="space-y-1.5">
          {lots.map((lot) => {
            const qty = getQty(lot.lotId);
            const overflow = qty > lot.qty;
            return (
              <li
                key={lot.lotId}
                className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50"
              >
                <div className="flex-1 flex items-center justify-between gap-2">
                  <span className="font-mono">{lot.openDate}</span>
                  <span className="text-muted-foreground">
                    {lot.qty} open · {formatCurrency(lot.costPerShare, currency)}/sh
                  </span>
                </div>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qty || ""}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    updateQty(lot.lotId, Number.isFinite(v) && v > 0 ? v : 0);
                  }}
                  placeholder="0"
                  className={`h-7 w-20 rounded border bg-background px-2 text-right text-xs ${
                    overflow
                      ? "border-amber-500/60 text-amber-600 dark:text-amber-400"
                      : "border-border/60"
                  }`}
                />
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        Total to sell:{" "}
        <span className="font-mono font-medium text-foreground">
          {totalSelected}
        </span>
        {" / "}
        <span className="font-mono">{totalAvailable}</span> open.
        {totalSelected > totalAvailable && (
          <span className="ml-2 text-amber-600 dark:text-amber-400">
            Excess {totalSelected - totalAvailable} will open a short position.
          </span>
        )}
      </p>
    </div>
  );
}

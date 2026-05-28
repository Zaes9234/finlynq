"use client";

/**
 * AutoRuleBanner — surfaces recent rule-fired transactions on /inbox's
 * Reconciled tab when the lens is 'auto' (Phase 4, 2026-05-27).
 *
 * Queries /api/reconcile/auto-rule-recent?accountId=X for the rows that
 * the upload-time rule firing materialized to `transactions` with
 * `source='auto_rule'`. Renders a callout banner with the count and the
 * first 5 rows; clicking a row opens the existing TransactionDialog in
 * edit mode so the user can override the rule's choice.
 *
 * Keeps the Auto-pilot pipeline transparent — without this banner, the
 * user can't easily tell which rows were rule-categorized vs. genuinely
 * landed in the right category. The "rule" pill on each row + this
 * summary make the auto behavior auditable in one glance.
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

interface AutoRuleItem {
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  categoryName: string | null;
  bankTransactionId: string | null;
  createdAt: string;
}

interface AutoRuleData {
  count: number;
  windowDays: number;
  items: AutoRuleItem[];
}

const PREVIEW_LIMIT = 5;

export function AutoRuleBanner({
  accountId,
  onRowClick,
}: {
  accountId: number;
  /** Caller wires this to open TransactionDialog in edit mode. */
  onRowClick?: (transactionId: number) => void;
}) {
  const [data, setData] = useState<AutoRuleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/reconcile/auto-rule-recent?accountId=${accountId}`)
      .then((r) => (r.ok ? r.json() : { success: false }))
      .then((body) => {
        if (cancelled) return;
        if (body?.success && body.data) {
          setData(body.data as AutoRuleData);
        } else {
          setData(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (loading || !data || data.count === 0) return null;

  const preview = expanded ? data.items : data.items.slice(0, PREVIEW_LIMIT);
  const hasMore = data.items.length > PREVIEW_LIMIT;

  return (
    <Card className="border-emerald-500/30 bg-emerald-500/5">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Sparkles className="h-4 w-4 text-emerald-500" />
          <p className="text-sm font-medium">
            {data.count} row{data.count === 1 ? "" : "s"} auto-applied by rules
            in the last {data.windowDays} day{data.windowDays === 1 ? "" : "s"}
          </p>
          <Badge
            variant="outline"
            className="text-[10px] font-mono uppercase border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          >
            rule
          </Badge>
        </div>
        <div className="space-y-1">
          {preview.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onRowClick?.(item.id)}
              className="w-full text-left rounded-md border bg-card/60 px-3 py-2 hover:bg-card transition-colors"
            >
              <div className="flex items-baseline gap-3 flex-wrap text-xs">
                <span className="font-mono text-muted-foreground w-20 shrink-0">
                  {item.date}
                </span>
                <span className="truncate flex-1 min-w-0">
                  {item.payee ?? "(no payee)"}
                </span>
                {item.categoryName && (
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    {item.categoryName}
                  </Badge>
                )}
                <span
                  className={`font-mono w-20 text-right shrink-0 ${
                    item.amount < 0 ? "text-rose-500" : "text-emerald-500"
                  }`}
                >
                  {formatCurrency(item.amount, item.currency || "CAD")}
                </span>
              </div>
            </button>
          ))}
        </div>
        {hasMore && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded
              ? `Show fewer`
              : `Show ${data.items.length - PREVIEW_LIMIT} more`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

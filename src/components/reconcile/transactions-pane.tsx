"use client";

/**
 * TransactionsPane — right pane of the /reconcile UI.
 *
 * Renders the user's system-side `transactions` rows for the currently-
 * selected account, with reconcile status pills + an inline SuggestionCard
 * pinned to each tx that has a suggestion. Mirrors the layout pattern of
 * `pf-app/src/components/import/reconcile/file-pane.tsx` (the staged-side
 * right pane on /import/pending) without coupling to the staging shape.
 *
 * Per-row layout when a suggestion is present:
 *   ┌──────────────────────────────────────┐
 *   │ tx row · date · payee · amount       │
 *   ├──────────────────────────────────────┤
 *   │ SuggestionCard (sky-50)              │
 *   └──────────────────────────────────────┘
 *
 * For linked-via-extra rows we surface a "linked + extra link" badge but
 * don't render the SuggestionCard (the join already exists).
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Fragment } from "react";
import { formatCurrency } from "@/lib/currency";
import { MatchPill, type ReconcileBadgeVariant } from "./match-pill";
import {
  SuggestionCard,
  type SuggestionDisplay,
} from "./suggestion-card";

export interface TxRow {
  /** `transactions.id`. */
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  category: string | null;
  status: ReconcileBadgeVariant;
  /** Bank id this tx is linked to (when status is linked_*). */
  linkedBankTransactionId: string | null;
  /** Inline suggestion for this tx, if any. */
  suggestion: SuggestionDisplay | null;
}

export function TransactionsPane({
  rows,
  loading,
  onAccept,
  onReject,
  onRowClick,
  highlightedTxIds,
  busySuggestionKey,
  selectedTxIds,
  onToggleSelect,
  onToggleSelectAll,
}: {
  rows: TxRow[];
  loading: boolean;
  onAccept: (s: SuggestionDisplay) => void;
  onReject: (s: SuggestionDisplay) => void;
  /** Click on the row body — drives cross-pane highlight (plan #5). */
  onRowClick?: (txId: number) => void;
  /** Transaction ids currently highlighted by a click-through. */
  highlightedTxIds?: ReadonlySet<number>;
  /** Composite "txId:bankId" key for the suggestion in flight. */
  busySuggestionKey: string | null;
  /** Transaction ids checked for bulk M:N reconcile (2026-05-27). */
  selectedTxIds?: ReadonlySet<number>;
  /** Toggle a single row's checked state. */
  onToggleSelect?: (txId: number) => void;
  /** Toggle every visible row's checked state at once (header checkbox). */
  onToggleSelectAll?: (checked: boolean) => void;
}) {
  const selectionEnabled = !!onToggleSelect;
  const allChecked =
    selectionEnabled &&
    rows.length > 0 &&
    rows.every((r) => selectedTxIds?.has(r.id));
  const someChecked =
    selectionEnabled &&
    !allChecked &&
    rows.some((r) => selectedTxIds?.has(r.id));
  if (loading) {
    return (
      <p className="p-6 text-sm text-muted-foreground text-center">
        Loading…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground text-center">
        No transactions in this account yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {selectionEnabled && (
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all transactions"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked;
                    }}
                    onChange={(e) => onToggleSelectAll?.(e.target.checked)}
                    className="h-4 w-4 cursor-pointer"
                  />
                </TableHead>
              )}
              <TableHead>Date</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const suggestionKey = r.suggestion
                ? `${r.suggestion.transactionId}:${r.suggestion.bankTransactionId}`
                : null;
              const busy =
                suggestionKey != null && busySuggestionKey === suggestionKey;
              const highlighted = highlightedTxIds?.has(r.id) ?? false;
              const highlightClass = highlighted
                ? "bg-sky-500/10 outline outline-2 outline-sky-500/40"
                : "";
              const checked = selectedTxIds?.has(r.id) ?? false;
              return (
                <Fragment key={r.id}>
                  <TableRow
                    className={`${highlightClass} cursor-pointer`}
                    onClick={(e) => {
                      const t = e.target as HTMLElement;
                      if (t.closest("button")) return;
                      if (t.closest("input")) return;
                      onRowClick?.(r.id);
                    }}
                  >
                    {selectionEnabled && (
                      <TableCell className="w-10">
                        <input
                          type="checkbox"
                          aria-label={`Select transaction ${r.date} ${r.payee ?? ""}`}
                          checked={checked}
                          onChange={() => onToggleSelect?.(r.id)}
                          className="h-4 w-4 cursor-pointer"
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs">
                      {r.date}
                    </TableCell>
                    <TableCell className="text-xs truncate max-w-[220px]">
                      {r.payee || (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {r.category && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {r.category}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <MatchPill
                        variant={r.status}
                        title={
                          r.linkedBankTransactionId != null
                            ? "Linked to a bank-ledger row"
                            : undefined
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatCurrency(r.amount, r.currency || "CAD")}
                    </TableCell>
                  </TableRow>
                  {r.suggestion && (
                    <TableRow>
                      <TableCell
                        colSpan={selectionEnabled ? 5 : 4}
                        className="p-0"
                      >
                        <SuggestionCard
                          suggestion={r.suggestion}
                          onAccept={onAccept}
                          onReject={onReject}
                          busy={busy}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

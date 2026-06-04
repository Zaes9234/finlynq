"use client";

/**
 * RowCard — single bank-row presentation for the Approve-each lens
 * (/inbox To-approve tab). Originally prototyped in the reconcile-v4 preview
 * page (since removed).
 *
 * Pure presentation — every action bubbles to the parent via callbacks.
 * The parent owns the fetch lifecycle and the busy state.
 *
 * Suggestion display: re-uses the same `SuggestionDisplay` shape that the
 * /reconcile suggestion strip renders, plus a derived `suggestedCategoryId`
 * + `suggestedCategoryName` carried by the bank snapshot (from
 * `/api/reconcile/suggestions`). Phase 3 shows the suggested category as
 * a Badge inline; Phase 4 will extend this with a `rule:` pill when the
 * Auto-pilot rule engine matched.
 *
 * The trash icon opens the parent's existing <ConfirmDeleteBankRow>
 * (shipped 2026-05-27) — wired by the parent.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeftRight,
  Check,
  Link2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";

/** A pre-existing unlinked ledger transaction this bank row appears to
 *  duplicate (2026-06-04). When set, the card warns and offers a
 *  "Link to existing" action instead of silently creating a second entry. */
export interface RowCardDuplicate {
  transactionId: number;
  txPayee: string | null;
  txDate: string;
  txAmount: number;
  txCurrency: string;
}

export interface RowCardSuggestion {
  /** Match against an existing tx in the user's ledger. */
  kind: "match";
  transactionId: number;
  txPayee: string | null;
  txCategoryName: string | null;
}
export interface RowCardSuggestionCreate {
  /** Rules / match-engine proposed a category to create as. */
  kind: "create";
  categoryId: number;
  categoryName: string;
}
export interface RowCardSuggestionTransfer {
  /** A transfer-only rule (`create_transfer`, no `set_category`) matched —
   *  approve as a transfer pair (source leg on this bank row → dest account). */
  kind: "transfer";
  destAccountId: number;
  destAccountName: string;
}
export type RowCardSuggestionAny =
  | RowCardSuggestion
  | RowCardSuggestionCreate
  | RowCardSuggestionTransfer;

export interface RowCardBank {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
}

export interface RowCardProps {
  bank: RowCardBank;
  suggestion: RowCardSuggestionAny | null;
  busy: boolean;
  /** Approve with the suggested category (or the parent's chosen default
   *  when no suggestion is present). Parent decides which category to send. */
  onApprove: () => void;
  /** Opens the inline edit affordance — parent decides what UI to show
   *  (Phase 3 ships with a placeholder edit-action that just opens the
   *  same TransactionDialog the Manual lens uses). */
  onEdit: () => void;
  /** Opens the per-row delete confirmation. Parent surfaces the
   *  ConfirmDeleteBankRow modal. */
  onDelete: () => void;
  /** When set, this bank row looks like a duplicate of an existing ledger
   *  transaction — the card warns and surfaces "Link to existing". */
  duplicate?: RowCardDuplicate | null;
  /** Link this bank row to the matched existing transaction instead of
   *  creating a new one (resolves the possible duplicate). */
  onLinkExisting?: () => void;
}

function SuggestionLine({ s }: { s: RowCardSuggestionAny | null }) {
  if (s == null) {
    return (
      <span className="text-xs italic text-muted-foreground">
        no match — needs your decision
      </span>
    );
  }
  if (s.kind === "match") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <Link2 className="h-3.5 w-3.5 text-sky-500" />
        <span className="text-muted-foreground">
          match tx #{s.transactionId}
          {s.txPayee ? ` · ${s.txPayee}` : ""}
        </span>
        {s.txCategoryName && (
          <Badge variant="secondary" className="font-mono text-[10px]">
            {s.txCategoryName}
          </Badge>
        )}
      </span>
    );
  }
  if (s.kind === "transfer") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <ArrowLeftRight className="h-3.5 w-3.5 text-violet-500" />
        <span className="text-muted-foreground">transfer to</span>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {s.destAccountName}
        </Badge>
      </span>
    );
  }
  // kind === "create"
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
      <span className="text-muted-foreground">create as</span>
      <Badge variant="secondary" className="font-mono text-[10px]">
        {s.categoryName}
      </Badge>
    </span>
  );
}

export function RowCard({
  bank,
  suggestion,
  busy,
  onApprove,
  onEdit,
  onDelete,
  duplicate,
  onLinkExisting,
}: RowCardProps) {
  const hasSuggestion = suggestion != null;
  const isDup = duplicate != null;
  return (
    <div
      className={`rounded-lg border bg-card hover:shadow-sm transition-shadow ${
        isDup ? "border-amber-300 dark:border-amber-700" : ""
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="text-xs font-mono text-muted-foreground">
              {bank.date}
            </span>
            <span className="text-sm font-medium truncate">
              {bank.payee ?? "(no payee)"}
            </span>
            <span
              className={`ml-auto text-sm font-mono ${
                bank.amount < 0 ? "text-rose-500" : "text-emerald-500"
              }`}
            >
              {formatCurrency(bank.amount, bank.currency || "CAD")}
            </span>
          </div>
          <div className="mt-1.5">
            {isDup ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Possible duplicate of an existing transaction
                  {duplicate.txPayee ? ` · ${duplicate.txPayee}` : ""} ·{" "}
                  {duplicate.txDate} ·{" "}
                  {formatCurrency(
                    duplicate.txAmount,
                    duplicate.txCurrency || bank.currency || "CAD",
                  )}
                </span>
              </span>
            ) : (
              <SuggestionLine s={suggestion} />
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isDup ? (
            <>
              <Button
                size="sm"
                className="h-7 gap-1"
                onClick={onLinkExisting}
                disabled={busy}
              >
                <Link2 className="h-3.5 w-3.5" /> Link to existing
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1"
                onClick={hasSuggestion ? onApprove : onEdit}
                disabled={busy}
                title="Keep this as a separate transaction"
              >
                Keep separate
              </Button>
            </>
          ) : hasSuggestion ? (
            <Button
              size="sm"
              className="h-7 gap-1"
              onClick={onApprove}
              disabled={busy}
            >
              <Check className="h-3.5 w-3.5" /> Approve
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 gap-1"
              onClick={onEdit}
              disabled={busy}
            >
              <Plus className="h-3.5 w-3.5" /> Categorize
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onEdit}
            disabled={busy}
            aria-label="Edit row"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-500"
            onClick={onDelete}
            disabled={busy}
            aria-label="Delete row"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

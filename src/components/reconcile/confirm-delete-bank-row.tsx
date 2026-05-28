"use client";

/**
 * ConfirmDeleteBankRow — shared 409-confirmation modal for the
 * `DELETE /api/bank-transactions/[bankId]` per-row delete flow
 * (2026-05-27).
 *
 * Mirrors the pattern used by the batch-undo modal in
 * `recent-uploads-panel.tsx` so per-row + per-batch delete share the
 * same visual contract:
 *   - Delete all  → POST with { deleteLinkedTransactions: true }
 *   - Keep tx     → POST with { deleteLinkedTransactions: false }
 *   - Cancel      → no-op
 *
 * Used from:
 *   - BankPane (/reconcile)
 *   - DbPane parent (/import/pending)
 *
 * The parent component owns the actual fetch call — this component is
 * pure presentation + a 3-way callback.
 */

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";

export interface ConfirmDeleteBankRowProps {
  open: boolean;
  /** Counts surfaced by the 409 response payload. */
  linkedTransactionCount: number;
  /** Bank row identifier — date/amount/currency are surfaced in the
   *  modal copy so the user can confirm they're deleting the right row. */
  bankDate: string;
  bankAmount: number;
  bankCurrency: string;
  bankPayee: string | null;
  /** True while a delete fetch is in flight — disables buttons. */
  busy: boolean;
  onConfirm: (deleteLinkedTransactions: boolean) => void;
  onCancel: () => void;
}

export function ConfirmDeleteBankRow({
  open,
  linkedTransactionCount,
  bankDate,
  bankAmount,
  bankCurrency,
  bankPayee,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDeleteBankRowProps) {
  if (!open) return null;

  const isPlural = linkedTransactionCount !== 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg">
        <h3 className="text-base font-semibold">
          Delete bank-ledger row with linked {isPlural ? "transactions" : "transaction"}?
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          You&rsquo;re deleting{" "}
          <strong>
            {formatCurrency(bankAmount, bankCurrency || "CAD")}
          </strong>{" "}
          on <strong>{bankDate}</strong>
          {bankPayee ? (
            <>
              {" "}— <span className="italic">{bankPayee}</span>
            </>
          ) : null}
          .
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          This bank-ledger row is linked to{" "}
          <strong>{linkedTransactionCount}</strong>{" "}
          {isPlural ? "transactions" : "transaction"} in your ledger.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          How do you want to handle the linked{" "}
          {isPlural ? "transactions" : "transaction"}?
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <Button
            onClick={() => onConfirm(true)}
            disabled={busy}
            className="bg-rose-700 hover:bg-rose-800 text-white"
          >
            Delete all (bank row + {isPlural ? "transactions" : "transaction"})
          </Button>
          <Button
            variant="outline"
            onClick={() => onConfirm(false)}
            disabled={busy}
          >
            Keep {isPlural ? "transactions" : "transaction"} (drop bank lineage)
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

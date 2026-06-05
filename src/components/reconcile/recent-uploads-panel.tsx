"use client";

/**
 * Recent Uploads panel — Phase 4 of import-modes refactor (2026-05-25).
 *
 * Per [plan/import-modes-simplified-detailed.md](../../../../plan/import-modes-simplified-detailed.md).
 *
 * Lists the most recent `bank_upload_batches` rows for the active account so
 * the user can undo an upload that landed bad rows (typo'd CSV, wrong
 * account binding, etc.). Each row has a "Delete batch" action that
 * cascades through bank_transactions + bank_daily_balances. If any bank
 * row in the batch is already linked to a `transactions` row (materialized
 * via /reconcile), the server replies with `requiresConfirmation: true`
 * and the panel surfaces a follow-up modal asking whether to also delete
 * those transactions or keep them as bank-lineage-NULL orphans.
 *
 * Data flow:
 *   GET /api/import/uploads?accountId=X  → list of batches
 *   DELETE /api/import/uploads/[batchId] → undo a batch (with optional
 *                                          { deleteLinkedTransactions: true })
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, RefreshCcw, ChevronDown, ChevronRight, Eye } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";

/** One bank_transactions row a batch loaded — fetched on demand when the user
 *  opens a batch's detail dialog to see what it brought in. */
interface LoadedRow {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  note: string | null;
  category: string | null;
  /** Set once the row is materialized into the ledger (else bank-only). */
  linkedTransactionId: number | null;
}

interface BatchRow {
  id: string;
  accountId: number;
  source: "upload" | "email" | "connector";
  mode: "simplified" | "detailed";
  filename: string | null;
  uploadedAt: string;
  rowCount: number;
  anchorCount: number;
  currentRowCount: number;
  hasLinkedTransactions: boolean;
}

interface ConfirmState {
  batch: BatchRow;
  bankRowCount: number;
  linkedTransactionCount: number;
  anchorCount: number;
}

export function RecentUploadsPanel({
  accountId,
  onChange,
  title = "Recent uploads",
  emptyLabel = "No uploads yet for this account.",
}: {
  accountId: number | null;
  onChange?: () => void;
  /** Header label. Defaults to "Recent uploads"; the /import Staging tab
   *  passes "Loaded into the bank ledger" so the section reads as the
   *  processed counterpart to the pending list above it. */
  title?: string;
  /** Empty-state copy when the account has no loaded batches yet. */
  emptyLabel?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // Click-to-view: which batch's read-only detail dialog is open, its loaded
  // rows (cached per batch), and per-batch load/error state.
  const [viewBatchId, setViewBatchId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, LoadedRow[]>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (accountId == null) {
      setBatches([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/import/uploads?accountId=${accountId}&limit=20`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BatchRow[];
      setBatches(data);
      // Drop any cached detail state — a refresh (or post-delete reload) may
      // have changed row counts, so re-opening refetches.
      setViewBatchId(null);
      setDetails({});
      setDetailError({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load recent uploads");
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  /** Fetch the rows a batch loaded (decrypted) — cached per batch. */
  const loadDetail = useCallback(async (batchId: string) => {
    setDetailLoadingId(batchId);
    setDetailError((e) => {
      if (!(batchId in e)) return e;
      const next = { ...e };
      delete next[batchId];
      return next;
    });
    try {
      const res = await fetch(`/api/import/uploads/${batchId}`);
      if (res.status === 423) {
        throw new Error("Unlock your session to view what this batch loaded.");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetails((d) => ({ ...d, [batchId]: Array.isArray(data?.rows) ? data.rows : [] }));
    } catch (e) {
      setDetailError((er) => ({
        ...er,
        [batchId]: e instanceof Error ? e.message : "Failed to load rows",
      }));
    } finally {
      setDetailLoadingId((cur) => (cur === batchId ? null : cur));
    }
  }, []);

  /** Open a batch's read-only detail dialog; fetch its rows on first open. */
  const openView = useCallback(
    (batchId: string) => {
      setViewBatchId(batchId);
      if (!details[batchId] && detailLoadingId !== batchId) {
        void loadDetail(batchId);
      }
    },
    [details, detailLoadingId, loadDetail],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const deleteBatch = useCallback(
    async (batchId: string, deleteLinkedTransactions = false) => {
      setDeletingId(batchId);
      try {
        const res = await fetch(`/api/import/uploads/${batchId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deleteLinkedTransactions }),
        });
        if (res.status === 409) {
          const body = await res.json();
          // Server is asking for confirmation. Surface the modal.
          const batch = batches.find((b) => b.id === batchId);
          if (batch) {
            setConfirm({
              batch,
              bankRowCount: body.bankRowCount ?? 0,
              linkedTransactionCount: body.linkedTransactionCount ?? 0,
              anchorCount: body.anchorCount ?? 0,
            });
          }
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        // Success — refresh list + notify parent so /reconcile re-fetches.
        setConfirm(null);
        await load();
        onChange?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete batch");
      } finally {
        setDeletingId(null);
      }
    },
    [batches, load, onChange],
  );

  if (accountId == null) return null;

  // Derived state for the read-only detail dialog.
  const viewBatch = viewBatchId ? (batches.find((b) => b.id === viewBatchId) ?? null) : null;
  const viewRows = viewBatchId ? details[viewBatchId] : undefined;
  const viewLoading = viewBatchId != null && detailLoadingId === viewBatchId;
  const viewErr = viewBatchId ? detailError[viewBatchId] : undefined;
  const viewInLedger = viewRows ? viewRows.filter((r) => r.linkedTransactionId != null).length : 0;
  const viewDt = viewBatch ? new Date(viewBatch.uploadedAt) : null;
  const viewDateLabel = viewDt
    ? `${viewDt.getFullYear()}-${String(viewDt.getMonth() + 1).padStart(2, "0")}-${String(viewDt.getDate()).padStart(2, "0")} ${String(viewDt.getHours()).padStart(2, "0")}:${String(viewDt.getMinutes()).padStart(2, "0")}`
    : "";

  return (
    <div className="rounded-md border bg-card text-card-foreground">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/40"
      >
        <span className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {title}
          {batches.length > 0 && (
            <span className="text-xs text-muted-foreground font-normal">
              ({batches.length})
            </span>
          )}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            void load();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              void load();
            }
          }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Loading…" : "Refresh"}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t">
          {error && (
            <div className="px-4 py-2 text-xs text-rose-600 bg-rose-50">{error}</div>
          )}
          {batches.length === 0 && !loading && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {emptyLabel}
            </div>
          )}
          {batches.length > 0 && (
            <ul className="divide-y">
              {batches.map((b) => {
                const dt = new Date(b.uploadedAt);
                const dateLabel = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
                return (
                  <li key={b.id} className="text-sm">
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => openView(b.id)}
                        className="min-w-0 flex-1 flex items-start gap-2 text-left hover:opacity-80"
                        title="View what this import loaded"
                      >
                        <Eye className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {dateLabel}
                            </span>
                            <span className="inline-block rounded border border-border bg-muted/40 px-1.5 py-0 text-[10px] uppercase">
                              {b.mode}
                            </span>
                            <span className="inline-block rounded border border-border bg-muted/40 px-1.5 py-0 text-[10px] uppercase">
                              {b.source}
                            </span>
                            {b.hasLinkedTransactions && (
                              <span className="inline-block rounded border border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800">
                                has linked tx
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs">
                            {b.filename ?? "(no filename)"}{" "}
                            <span className="text-muted-foreground">
                              · {b.currentRowCount}/{b.rowCount} rows
                              {b.anchorCount > 0 && ` · ${b.anchorCount} anchor${b.anchorCount === 1 ? "" : "s"}`}
                            </span>
                          </span>
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-rose-700 hover:text-rose-800 hover:bg-rose-50"
                        onClick={() => void deleteBatch(b.id, false)}
                        disabled={deletingId === b.id}
                      >
                        <Trash2 className="h-4 w-4 mr-1.5" />
                        {deletingId === b.id ? "Deleting…" : "Delete batch"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Read-only detail dialog — what this import loaded + where each row is
          now (in-ledger vs bank-only). Sourced from the batch's bank_transactions
          via the lineage chain; a faithful editable staging two-pane isn't
          applicable to an already-processed batch (its staged rows are gone). */}
      <Dialog
        open={viewBatchId != null}
        onOpenChange={(o) => {
          if (!o) setViewBatchId(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="truncate">
              {viewBatch?.filename ?? "Import detail"}
            </DialogTitle>
            <DialogDescription>
              {viewBatch
                ? `${viewDateLabel} · ${viewBatch.mode} · ${viewBatch.source} · ${viewBatch.currentRowCount}/${viewBatch.rowCount} rows${
                    viewBatch.anchorCount > 0
                      ? ` · ${viewBatch.anchorCount} anchor${viewBatch.anchorCount === 1 ? "" : "s"}`
                      : ""
                  }`
                : "What this import loaded."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            {viewLoading && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Loading what this import loaded…
              </p>
            )}
            {viewErr && <p className="py-4 text-sm text-rose-600">{viewErr}</p>}
            {!viewLoading && !viewErr && viewRows && viewRows.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No rows remain from this import — they were deleted from the bank
                ledger.
              </p>
            )}
            {viewRows && viewRows.length > 0 && (
              <>
                <p className="mb-2 text-xs text-muted-foreground">
                  {viewInLedger} of {viewRows.length}{" "}
                  {viewRows.length === 1 ? "row is" : "rows are"} materialized in
                  your ledger; the rest are bank-only.
                </p>
                <table className="w-full text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1.5 pr-2 text-left font-medium">Date</th>
                      <th className="py-1.5 pr-2 text-left font-medium">Payee</th>
                      <th className="py-1.5 pr-2 text-left font-medium">Category</th>
                      <th className="py-1.5 pr-2 text-left font-medium">Status</th>
                      <th className="py-1.5 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {viewRows.map((row) => (
                      <tr key={row.id}>
                        <td className="py-1.5 pr-2 font-mono text-xs whitespace-nowrap">
                          {row.date}
                        </td>
                        <td
                          className="max-w-[200px] truncate py-1.5 pr-2"
                          title={row.payee ?? ""}
                        >
                          {row.payee || "(no payee)"}
                        </td>
                        <td className="py-1.5 pr-2 text-muted-foreground">
                          {row.category ?? "—"}
                        </td>
                        <td className="py-1.5 pr-2">
                          {row.linkedTransactionId != null ? (
                            <span className="inline-block rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700">
                              in ledger
                            </span>
                          ) : (
                            <span className="inline-block rounded border border-border bg-muted/40 px-1.5 py-0 text-[10px] text-muted-foreground">
                              bank-only
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatCurrency(row.amount, row.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation modal for batches with linked transactions. */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg">
            <h3 className="text-base font-semibold">Delete batch with linked transactions?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This batch has <strong>{confirm.bankRowCount}</strong> bank-ledger row{confirm.bankRowCount === 1 ? "" : "s"},
              of which <strong>{confirm.linkedTransactionCount}</strong> {confirm.linkedTransactionCount === 1 ? "is" : "are"} already linked
              to {confirm.linkedTransactionCount === 1 ? "a transaction" : "transactions"} in your ledger
              {confirm.anchorCount > 0 && `, plus ${confirm.anchorCount} balance anchor${confirm.anchorCount === 1 ? "" : "s"}`}.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              How do you want to handle the linked {confirm.linkedTransactionCount === 1 ? "transaction" : "transactions"}?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                onClick={() => void deleteBatch(confirm.batch.id, true)}
                disabled={deletingId === confirm.batch.id}
                className="bg-rose-700 hover:bg-rose-800 text-white"
              >
                Delete all (bank rows + transactions)
              </Button>
              <Button
                variant="outline"
                onClick={() => void deleteBatch(confirm.batch.id, false)}
                disabled={deletingId === confirm.batch.id}
              >
                Keep transactions (drop bank lineage)
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirm(null)}
                disabled={deletingId === confirm.batch.id}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

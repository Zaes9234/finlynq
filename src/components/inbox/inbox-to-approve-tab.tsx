"use client";

/**
 * InboxToApproveTab — Approve-each lens body for /inbox (Phase 3, 2026-05-27).
 *
 * Lists every `bank_transactions` row for the selected account that does
 * NOT yet have a `transaction_bank_links` row. Each row renders as a
 * <RowCard> with an optional inline suggestion (existing match-engine
 * output from /api/reconcile/suggestions). The user approves a row in one
 * click → POST /api/bank-transactions/[bankId]/approve commits the bank
 * row to the ledger with the suggested category.
 *
 * Reuses (does not duplicate):
 *   - /api/reconcile/suggestions — same snapshot the Manual-lens Reconcile
 *     tab fetches; we re-call it locally so the tab is self-contained
 *     (the parent already fetches it for InboxReconciledTab, but a cheap
 *     re-fetch here keeps the lens-flip flow free of cross-component data
 *     plumbing).
 *   - ConfirmDeleteBankRow + DELETE /api/bank-transactions/[bankId] —
 *     dropped in unchanged.
 *   - TransactionDialog — same dialog used by Manual lens for the
 *     materialize-bank-row path; the "Categorize" + "Edit" affordances on
 *     a card open it with the bank row's amount/payee/account prefilled.
 *
 * "Accept all suggested" walks the suggested-but-unlinked rows in parallel
 * via Promise.all of POST /approve calls. Disabled when there are zero
 * suggested rows.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Check, Inbox } from "lucide-react";
import { RowCard, type RowCardSuggestionAny } from "./row-card";
import { ConfirmDeleteBankRow } from "@/components/reconcile/confirm-delete-bank-row";
import {
  TransactionDialog,
  type TransactionDialogInitialState,
  type DialogCategory,
  type DialogHolding,
} from "@/components/transactions/transaction-dialog";
import { safeAccountName } from "@/lib/safe-name";

interface Account {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  archived?: boolean;
  isInvestment?: boolean;
}

interface ReconcileLink {
  transactionId: number;
  bankTransactionId: string;
  linkType: "primary" | "extra";
  source: string;
  createdAt: string;
}

interface ReconcileSuggestion {
  transactionId: number;
  bankTransactionId: string;
  strategy: "join_existing" | "exact_hash" | "fuzzy";
  score: number;
  reason: string;
  daysOff: number;
  amountDeltaAbs: number;
}

interface TxSnapshot {
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  categoryName: string | null;
  categoryType: string | null;
}

interface BankSnapshot {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  accountId: number;
  suggestedCategoryId: number | null;
}

interface SnapshotShape {
  linked: ReconcileLink[];
  suggestions: ReconcileSuggestion[];
  transactions: Record<number, TxSnapshot>;
  bankTransactions: Record<string, BankSnapshot>;
}

export function InboxToApproveTab({
  accountId,
  accounts,
}: {
  accountId: number;
  accounts: Account[];
}) {
  const [snapshot, setSnapshot] = useState<SnapshotShape | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyBankId, setBusyBankId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [categories, setCategories] = useState<DialogCategory[]>([]);
  const [holdings, setHoldings] = useState<DialogHolding[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] =
    useState<TransactionDialogInitialState | null>(null);
  const [materializeBankId, setMaterializeBankId] = useState<string | null>(
    null,
  );
  const [deleteConfirm, setDeleteConfirm] = useState<{
    bankId: string;
    date: string;
    amount: number;
    currency: string;
    payee: string | null;
    linkedTransactionCount: number;
  } | null>(null);

  // Load categories + holdings once for the Edit/Categorize dialog.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled) return;
        if (Array.isArray(rows)) {
          setCategories(
            rows.map(
              (r: {
                id: number;
                name: string | null;
                type: string;
                group?: string | null;
              }) => ({
                id: r.id,
                name: r.name?.trim() ? r.name : `Category #${r.id}`,
                type: r.type,
                group: r.group ?? "",
              }),
            ),
          );
        }
      })
      .catch(() => {
        /* non-fatal — Categorize dialog gracefully degrades */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/portfolio")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled) return;
        setHoldings(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/reconcile/suggestions?accountId=${accountId}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (!body.success) throw new Error(body.error ?? "Unknown error");
      setSnapshot(body.data as SnapshotShape);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Filter to bank rows with no `transaction_bank_links` entry for the
   *  selected account, sorted newest-first. */
  const unlinkedRows = useMemo(() => {
    if (!snapshot) return [] as BankSnapshot[];
    const linkedBankIds = new Set(
      snapshot.linked.map((l) => l.bankTransactionId),
    );
    return Object.values(snapshot.bankTransactions)
      .filter((b) => !linkedBankIds.has(b.id))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [snapshot]);

  /** Build the per-bank-row suggestion shape the RowCard expects. */
  const suggestionByBank = useMemo(() => {
    const map = new Map<string, RowCardSuggestionAny>();
    if (!snapshot) return map;
    // 1) Match against an existing tx — preferred over Create.
    for (const s of snapshot.suggestions) {
      if (map.has(s.bankTransactionId)) continue;
      const tx = snapshot.transactions[s.transactionId];
      if (!tx) continue;
      map.set(s.bankTransactionId, {
        kind: "match",
        transactionId: s.transactionId,
        txPayee: tx.payee,
        txCategoryName: tx.categoryName,
      });
    }
    // 2) Fallback: match-engine's suggestedCategoryId on the bank row
    //    (the same data /reconcile's materialize dialog reads).
    const catName = (id: number) => {
      const c = categories.find((x) => x.id === id);
      return c?.name ?? `Category #${id}`;
    };
    for (const b of Object.values(snapshot.bankTransactions)) {
      if (map.has(b.id)) continue;
      if (b.suggestedCategoryId != null) {
        map.set(b.id, {
          kind: "create",
          categoryId: b.suggestedCategoryId,
          categoryName: catName(b.suggestedCategoryId),
        });
      }
    }
    return map;
  }, [snapshot, categories]);

  const suggestedUnlinked = useMemo(
    () => unlinkedRows.filter((b) => suggestionByBank.has(b.id)),
    [unlinkedRows, suggestionByBank],
  );

  const approveOne = useCallback(
    async (bankId: string, categoryId: number) => {
      const res = await fetch(
        `/api/bank-transactions/${encodeURIComponent(bankId)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categoryId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    [],
  );

  // Declared before onApprove so it can reference onEdit without a temporal
  // dead-zone access (react-hooks/immutability, FINLYNQ-119).
  const onEdit = useCallback(
    (bankId: string) => {
      if (!snapshot) return;
      const snap = snapshot.bankTransactions[bankId];
      if (!snap) return;
      const acct = accounts.find((a) => a.id === snap.accountId);
      if (acct?.isInvestment === true) {
        setError(
          "Investment accounts aren't supported by the Approve-each lens yet — use the Manual lens or the portfolio operations flow.",
        );
        return;
      }
      setDialogInitial({
        kind: "transaction-prefill",
        values: {
          accountId: String(snap.accountId),
          categoryId:
            snap.suggestedCategoryId != null
              ? String(snap.suggestedCategoryId)
              : "",
          date: snap.date,
          currency: snap.currency,
          amount: String(snap.amount),
          payee: snap.payee ?? "",
        },
      });
      setMaterializeBankId(snap.id);
      setDialogOpen(true);
    },
    [snapshot, accounts],
  );

  const onApprove = useCallback(
    async (bankId: string) => {
      const sug = suggestionByBank.get(bankId);
      if (!sug) {
        setError("No suggestion available for this row. Use Categorize.");
        return;
      }
      // For 'match' suggestions we don't have a categoryId on hand — fall
      // back to the linked tx's category if any, else open the dialog so
      // the user picks. Phase 3 keeps the surface simple: 'match' acts
      // identically to 'create' when both the suggested tx and the bank
      // row need a category attached; the dialog handles edge cases.
      let categoryId: number | null = null;
      if (sug.kind === "create") {
        categoryId = sug.categoryId;
      } else if (sug.kind === "match" && snapshot) {
        // 'match' — the linked tx's categoryId is on the suggestion's tx
        // snapshot. We don't have categoryId directly on TxSnapshot; the
        // existing /api/reconcile/links endpoint is the better path here
        // because it just attaches a primary link to the existing tx
        // (no new row needed). But that's outside Phase 3's "POST /approve"
        // contract. Open the dialog so the user confirms the category.
        const tx = snapshot.transactions[sug.transactionId];
        if (tx && tx.categoryName) {
          const match = categories.find((c) => c.name === tx.categoryName);
          if (match) categoryId = match.id;
        }
      }
      if (categoryId == null) {
        // Fall through to the dialog — same path the Categorize button uses.
        onEdit(bankId);
        return;
      }
      setBusyBankId(bankId);
      setError(null);
      try {
        await approveOne(bankId, categoryId);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyBankId(null);
      }
    },
    [approveOne, refresh, snapshot, suggestionByBank, categories, onEdit],
  );

  const deleteBankRow = useCallback(
    async (bankId: string, deleteLinkedTransactions: boolean | null) => {
      setBusyBankId(bankId);
      setError(null);
      try {
        const body: Record<string, unknown> = {};
        if (deleteLinkedTransactions != null) {
          body.deleteLinkedTransactions = deleteLinkedTransactions;
        }
        const res = await fetch(
          `/api/bank-transactions/${encodeURIComponent(bankId)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (res.status === 409) {
          const payload = await res.json();
          const snap = snapshot?.bankTransactions[bankId];
          setDeleteConfirm({
            bankId,
            date: payload.bankDate ?? snap?.date ?? "",
            amount: payload.bankAmount ?? snap?.amount ?? 0,
            currency: payload.bankCurrency ?? snap?.currency ?? "CAD",
            payee: snap?.payee ?? null,
            linkedTransactionCount: payload.linkedTransactionCount ?? 0,
          });
          return;
        }
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        setDeleteConfirm(null);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyBankId(null);
      }
    },
    [snapshot, refresh],
  );

  // Declared after deleteBankRow so it can reference it without a temporal
  // dead-zone access (react-hooks/immutability, FINLYNQ-119).
  const onDelete = useCallback(
    (bankId: string) => {
      void deleteBankRow(bankId, null);
    },
    [deleteBankRow],
  );

  const onAcceptAllSuggested = useCallback(async () => {
    if (suggestedUnlinked.length === 0) return;
    setBulkBusy(true);
    setError(null);
    const errors: string[] = [];
    await Promise.all(
      suggestedUnlinked.map(async (b) => {
        const sug = suggestionByBank.get(b.id);
        if (!sug) return;
        let categoryId: number | null = null;
        if (sug.kind === "create") {
          categoryId = sug.categoryId;
        } else if (sug.kind === "match" && snapshot) {
          const tx = snapshot.transactions[sug.transactionId];
          if (tx?.categoryName) {
            const cat = categories.find((c) => c.name === tx.categoryName);
            if (cat) categoryId = cat.id;
          }
        }
        if (categoryId == null) {
          errors.push(`${b.id}: skipped — no category resolved from suggestion`);
          return;
        }
        try {
          await approveOne(b.id, categoryId);
        } catch (e) {
          errors.push(
            `${b.payee ?? b.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
    if (errors.length > 0) {
      setError(
        `Approved ${suggestedUnlinked.length - errors.length}/${suggestedUnlinked.length} suggested rows. ${errors.length} skipped:\n${errors.join("\n")}`,
      );
    }
    await refresh();
    setBulkBusy(false);
  }, [
    approveOne,
    categories,
    refresh,
    snapshot,
    suggestedUnlinked,
    suggestionByBank,
  ]);

  if (loading && snapshot == null) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          Loading…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 whitespace-pre-line">
          {error}
        </div>
      )}

      {unlinkedRows.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground">
            {unlinkedRows.length} row{unlinkedRows.length === 1 ? "" : "s"}{" "}
            waiting · {suggestedUnlinked.length} with a suggestion
          </p>
          <Button
            size="sm"
            variant="default"
            disabled={suggestedUnlinked.length === 0 || bulkBusy}
            onClick={() => void onAcceptAllSuggested()}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            Accept all suggested ({suggestedUnlinked.length})
          </Button>
        </div>
      )}

      {unlinkedRows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm font-medium">
                No rows waiting for approval
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Upload a statement to this account and rows will appear here
                with one-click approve.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {unlinkedRows.map((b) => (
            <RowCard
              key={b.id}
              bank={{
                id: b.id,
                date: b.date,
                amount: b.amount,
                currency: b.currency,
                payee: b.payee,
              }}
              suggestion={suggestionByBank.get(b.id) ?? null}
              busy={busyBankId === b.id || bulkBusy}
              onApprove={() => void onApprove(b.id)}
              onEdit={() => onEdit(b.id)}
              onDelete={() => onDelete(b.id)}
            />
          ))}
        </div>
      )}

      {deleteConfirm && (
        <ConfirmDeleteBankRow
          open
          linkedTransactionCount={deleteConfirm.linkedTransactionCount}
          bankDate={deleteConfirm.date}
          bankAmount={deleteConfirm.amount}
          bankCurrency={deleteConfirm.currency}
          bankPayee={deleteConfirm.payee}
          busy={busyBankId === deleteConfirm.bankId}
          onConfirm={(deleteLinked) => {
            void deleteBankRow(deleteConfirm.bankId, deleteLinked);
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      <TransactionDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) {
            setDialogInitial(null);
            setMaterializeBankId(null);
          }
        }}
        accounts={accounts.map((a) => ({
          id: a.id,
          name: safeAccountName(a),
          currency: a.currency,
          isInvestment: a.isInvestment,
        }))}
        categories={categories}
        holdings={holdings}
        initialState={dialogInitial}
        onSaved={async (txId) => {
          // Mirror Manual lens: after a manual save through the dialog,
          // primary-link the new tx to the bank row so it leaves "To
          // approve" and shows up in "Reconciled."
          if (materializeBankId) {
            try {
              await fetch("/api/reconcile/links", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  transactionId: txId,
                  bankTransactionId: materializeBankId,
                  linkType: "primary",
                }),
              });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
            setMaterializeBankId(null);
          }
          await refresh();
        }}
      />
    </div>
  );
}

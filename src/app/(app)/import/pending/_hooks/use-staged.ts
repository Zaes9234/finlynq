"use client";

/**
 * /import/pending data hooks (FINLYNQ-118 Phase 4).
 *
 * Extracted from import/pending/page.tsx. Behaviour-preserving: same fetch
 * URLs, same triggers, same parsing + soft-fail semantics. NO data-fetching
 * library (that is FINLYNQ-115) — the bespoke fetch / useState / useEffect /
 * finally pattern is kept verbatim.
 *
 * The hooks own the load-bearing data state (the list; the detail / accounts /
 * holdings; the bank ledger) + their load-on-mount / load-on-change effects.
 * The page keeps the tightly-coupled orchestration (`openId`, `selected`, the
 * match-action callbacks) and threads the returned state + setters through —
 * exactly the FINLYNQ-111 transactions-page split.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type AccountOption as EditorAccountOption,
  type HoldingOption,
} from "@/components/staging/staged-row-editor";
import { type DbTransactionRow } from "@/components/import/reconcile/db-pane";
import type { StagedDetail, StagedRow } from "../_types";

/** The list view — pending batches. Loads on mount; `loadList` is the
 *  imperative reload the Refresh button / approve / reject call. */
export function useStagedImports() {
  const [list, setList] = useState<StagedRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/import/staged");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  return { list, loading, error, loadList };
}

/**
 * Detail batch state — `detail`, the accounts + holdings catalogs, and the
 * detail-loading flag. `loadDetail(id)` runs the same `Promise.all` fetch the
 * inline `openDetail` did (detail + accounts + portfolio), parses + filters the
 * catalog rows identically, sets the hook state, and RETURNS the parsed detail
 * (or throws) so the page keeps ownership of `openId` + the `selected` seed +
 * the error→reset-openId orchestration. `setDetail` is exposed because many
 * page match-action callbacks mutate `detail.rows` in place.
 */
export function useStagedDetail() {
  const [detail, setDetail] = useState<StagedDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [accounts, setAccounts] = useState<EditorAccountOption[]>([]);
  const [holdings, setHoldings] = useState<HoldingOption[]>([]);

  const loadDetail = useCallback(async (id: string): Promise<StagedDetail> => {
    setDetail(null);
    setDetailLoading(true);
    try {
      const [detailRes, acctRes, holdRes] = await Promise.all([
        fetch(`/api/import/staged/${id}`),
        fetch("/api/accounts"),
        fetch("/api/portfolio"),
      ]);
      const data: StagedDetail = await detailRes.json();
      if (!detailRes.ok) {
        throw new Error((data as unknown as { error?: string }).error || "Failed to load");
      }
      setDetail(data);
      if (acctRes.ok) {
        const acctRaw = (await acctRes.json()) as Array<{
          id: number;
          name: string | null;
          currency: string;
          isInvestment?: boolean;
        }>;
        setAccounts(
          acctRaw
            .filter((a) => a.name != null)
            .map((a) => ({
              id: a.id,
              name: a.name as string,
              currency: a.currency,
              isInvestment: Boolean(a.isInvestment),
            })),
        );
      }
      if (holdRes.ok) {
        const holdRaw = (await holdRes.json()) as Array<{
          id: number;
          name: string | null;
          symbol: string | null;
          accountId: number | null;
          currency: string;
        }>;
        setHoldings(
          holdRaw
            .filter((h) => h.name != null)
            .map((h) => ({
              id: h.id,
              name: h.name as string,
              symbol: h.symbol,
              accountId: h.accountId,
              currency: h.currency,
            })),
        );
      }
      return data;
    } finally {
      setDetailLoading(false);
    }
  }, []);

  return {
    detail,
    setDetail,
    detailLoading,
    setDetailLoading,
    accounts,
    holdings,
    loadDetail,
  };
}

/**
 * Bank-side ledger for the selected account. Fetches whenever `accountId`
 * changes (two-ledger refactor 2026-05-22: the continuous `bank_transactions`
 * history, no date window). `onError` surfaces the toast the inline effect set.
 * `setDbRows` is exposed because the page's link/flag/delete callbacks mutate
 * the ledger rows in place between fetches.
 */
export function useBankLedger(
  accountId: number | null,
  onError: (msg: string) => void,
) {
  const [dbRows, setDbRows] = useState<DbTransactionRow[]>([]);
  const [dbRowsLoading, setDbRowsLoading] = useState(false);
  // Bumped to force a re-fetch without changing the account (e.g. after an
  // approve pushes new rows into the bank ledger and we want the left pane
  // to show them immediately).
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    if (!accountId) {
      setDbRows([]);
      return;
    }
    let cancelled = false;
    setDbRowsLoading(true);
    const params = new URLSearchParams({
      accountId: String(accountId),
    });
    fetch(`/api/import/bank-ledger?${params.toString()}`)
      .then((res) =>
        res.json().then((data) => ({ ok: res.ok, status: res.status, data })),
      )
      .then(({ ok, status, data }) => {
        if (cancelled) return;
        if (!ok) {
          const msg =
            status === 423
              ? data?.message ||
                "Your session needs to be unlocked. Reload and sign in again."
              : data?.error || "Failed to load bank ledger";
          onError(msg);
          setDbRows([]);
          return;
        }
        setDbRows(Array.isArray(data?.data?.transactions) ? data.data.transactions : []);
      })
      .catch((e) => {
        if (cancelled) return;
        onError(e instanceof Error ? e.message : "Failed to load");
        setDbRows([]);
      })
      .finally(() => {
        if (cancelled) return;
        setDbRowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, reloadNonce]);

  return { dbRows, setDbRows, dbRowsLoading, reload };
}

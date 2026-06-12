"use client";

/**
 * ReconcileHideAccountsCard (FINLYNQ-147) — per-account "hide from reconcile
 * dropdown" control. Lives on /settings/import (account-agnostic management).
 *
 * Persists a per-user JSON array of hidden account ids via
 * GET/PUT /api/settings/reconcile-hidden-accounts (settings key, no migration).
 * Hidden is a DROPDOWN-ONLY filter on /import: a hidden account stays reachable
 * here and via direct deep-links (/import?account=<id>, /import/pending).
 *
 * Bespoke fetch/useState/useEffect (FINLYNQ-118 money-page pattern, no SWR).
 */

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyeOff, Eye } from "lucide-react";
import { safeAccountName } from "@/lib/safe-name";

interface AccountRow {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  archived?: boolean;
}

export function ReconcileHideAccountsCard() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [hiddenIds, setHiddenIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [accRes, hidRes] = await Promise.all([
          fetch("/api/accounts?includeArchived=1"),
          fetch("/api/settings/reconcile-hidden-accounts"),
        ]);
        const accData = accRes.ok ? await accRes.json() : [];
        const hidData = hidRes.ok ? await hidRes.json() : { accountIds: [] };
        if (cancelled) return;
        if (Array.isArray(accData)) setAccounts(accData);
        if (Array.isArray(hidData.accountIds)) {
          setHiddenIds(
            hidData.accountIds.filter((n: unknown) => typeof n === "number"),
          );
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (accountId: number) => {
    const isHidden = hiddenIds.includes(accountId);
    const next = isHidden
      ? hiddenIds.filter((id) => id !== accountId)
      : [...hiddenIds, accountId];
    const prev = hiddenIds;
    setHiddenIds(next); // optimistic
    setSavingId(accountId);
    setError(null);
    try {
      const res = await fetch("/api/settings/reconcile-hidden-accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: next }),
      });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.accountIds)) {
        setHiddenIds(prev); // revert
        setError(data?.error ?? "Failed to update");
      } else {
        setHiddenIds(data.accountIds);
      }
    } catch (e) {
      setHiddenIds(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
            <EyeOff className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">
              Hide accounts from the reconcile dropdown
            </CardTitle>
            <CardDescription>
              Hidden accounts no longer clutter the account picker on the{" "}
              <a href="/import" className="underline hover:text-foreground">
                Import
              </a>{" "}
              page. They stay fully accessible here and via direct links.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-3 text-sm text-rose-700 dark:text-rose-400">{error}</p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading accounts…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts yet.</p>
        ) : (
          <ul className="divide-y">
            {accounts.map((a) => {
              const isHidden = hiddenIds.includes(a.id);
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium">
                      {safeAccountName(a)}
                    </span>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {a.currency}
                    </span>
                    {a.archived && (
                      <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        archived
                      </span>
                    )}
                    {isHidden && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                        hidden
                      </span>
                    )}
                  </div>
                  <Button
                    variant={isHidden ? "outline" : "ghost"}
                    size="sm"
                    onClick={() => toggle(a.id)}
                    disabled={savingId === a.id}
                  >
                    {isHidden ? (
                      <>
                        <Eye className="h-4 w-4 mr-1.5" /> Show
                      </>
                    ) : (
                      <>
                        <EyeOff className="h-4 w-4 mr-1.5" /> Hide
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

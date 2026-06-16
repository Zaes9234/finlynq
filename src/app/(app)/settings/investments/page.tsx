"use client";

/**
 * /settings/investments — the consolidated Investments surface.
 *
 * One row per SECURITY (the centralized per-(user,ticker) identity from the
 * securities master, Tier 2). This page absorbs the former
 * /settings/holding-accounts ("Holding ↔ Account Map") and /settings/securities
 * pages — both now redirect here. The table is compact + filterable by column
 * header (the owner's ask): filter inputs under each header + click-to-sort.
 *
 * Linking a security to a specific account (qty / cost basis) happens in the
 * transaction / portfolio-entry flow, NOT here — so this page is the catalog +
 * rename, plus the existing "Add holding" form and "Rebuild investment history"
 * utility. Reads GET /api/securities ({ success, data } envelope) which lists
 * each security once with the accounts that hold it; renaming is PATCH
 * /api/securities. Bespoke fetch/useState/useEffect (NO SWR), mirroring the
 * sibling money pages. → plan/architecture/securities.md
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { HoldingEditForm } from "@/components/holdings/holding-edit-form";
import { RebuildSnapshotsButton } from "@/components/portfolio/rebuild-snapshots-button";
import { PageSkeleton } from "@/components/page-skeleton";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { parseSaveError } from "@/lib/save-error";
import {
  Briefcase,
  Plus,
  Pencil,
  History,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

type SecurityAccount = {
  accountId: number;
  accountName: string | null;
  isInvestment: boolean;
  positionId: number;
  isCash: boolean;
};

type Security = {
  id: number;
  symbol: string | null;
  name: string | null;
  assetType: string;
  currency: string;
  isCash: boolean;
  isCrypto: boolean;
  image: string | null;
  accounts: SecurityAccount[];
};

function symbolLabel(s: Security): string {
  return s.symbol?.trim() || s.name?.trim() || "—";
}

/** The human display name, only when it's distinct from the ticker code. */
function descriptionOf(s: Security): string {
  const sym = symbolLabel(s);
  const nm = s.name?.trim() ?? "";
  return nm && nm.toUpperCase() !== sym.toUpperCase() ? nm : "";
}

type SortKey = "symbol" | "description" | "type" | "currency" | "accounts";
type SortDir = "asc" | "desc";
type FilterKey = "symbol" | "description" | "type" | "currency";

const EMPTY_FILTERS: Record<FilterKey, string> = {
  symbol: "",
  description: "",
  type: "",
  currency: "",
};

export default function InvestmentsSettingsPage() {
  const [securities, setSecurities] = useState<Security[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  // Table controls.
  const [filters, setFilters] = useState<Record<FilterKey, string>>(EMPTY_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "symbol", dir: "asc" });

  // Add-holding dialog (the existing shared form; also mounts on /portfolio).
  const [addOpen, setAddOpen] = useState(false);

  // Rename dialog.
  const [renameSecurity, setRenameSecurity] = useState<Security | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/securities");
      if (!res.ok) throw new Error("Failed to load securities");
      const json: { data: Security[] } = await res.json();
      setSecurities(json.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  }

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }

  const rows = useMemo(() => {
    if (!securities) return [];
    const mapped = securities.map((s) => ({
      s,
      symbol: symbolLabel(s),
      description: descriptionOf(s),
      type: s.assetType,
      currency: s.currency,
      accounts: s.accounts.length,
    }));
    const filtered = mapped.filter(
      (r) =>
        (!filters.symbol || r.symbol.toLowerCase().includes(filters.symbol.toLowerCase())) &&
        (!filters.description ||
          r.description.toLowerCase().includes(filters.description.toLowerCase())) &&
        (!filters.type || r.type.toLowerCase().includes(filters.type.toLowerCase())) &&
        (!filters.currency ||
          r.currency.toLowerCase().includes(filters.currency.toLowerCase())),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      if (sort.key === "accounts") return (a.accounts - b.accounts) * dir;
      const av = String(a[sort.key] ?? "").toLowerCase();
      const bv = String(b[sort.key] ?? "").toLowerCase();
      return av.localeCompare(bv) * dir;
    });
    return filtered;
  }, [securities, filters, sort]);

  const hasActiveFilter = Object.values(filters).some((v) => v.trim() !== "");

  // ---- Rename ----------------------------------------------------------

  function openRename(s: Security) {
    setRenameSecurity(s);
    setRenameValue(s.name ?? "");
    setRenameErrors({});
  }

  async function submitRename() {
    if (!renameSecurity) return;
    const name = renameValue.trim();
    if (!name) {
      setRenameErrors({ name: "Name is required" });
      return;
    }
    setRenameErrors({});
    setRenaming(true);
    try {
      const res = await fetch("/api/securities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: renameSecurity.id, name }),
      });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to rename security");
        setRenameErrors({ name: msg });
        return;
      }
      setRenameSecurity(null);
      showToast("success", "Security renamed");
      await load();
    } catch (e) {
      setRenameErrors({ name: e instanceof Error ? e.message : "Rename failed" });
    } finally {
      setRenaming(false);
    }
  }

  // ---- Render ----------------------------------------------------------

  if (loading && !securities) {
    return (
      <div className="max-w-5xl">
        <PageSkeleton variant="cards" rows={4} />
      </div>
    );
  }

  if (error && !securities) {
    return (
      <div className="max-w-5xl">
        <ErrorState title="Couldn't load investments" message={error} onRetry={load} />
      </div>
    );
  }

  // Render helpers (lowercase, called inline — NOT components defined during
  // render, which the react-hooks compiler rule forbids).
  const sortHeader = (k: SortKey, label: string) => {
    const active = sort.key === k;
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
      >
        {label}
        {active ? (
          sort.dir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    );
  };

  const filterInput = (col: FilterKey, placeholder: string) => (
    <Input
      value={filters[col]}
      onChange={(e) => setFilters((p) => ({ ...p, [col]: e.target.value }))}
      placeholder={placeholder}
      className="h-7 text-xs"
      aria-label={`Filter by ${col}`}
    />
  );

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Investments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Every security you hold appears once. Filter by any column header.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" /> Add holding
        </Button>
      </div>

      {toast && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            toast.type === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900"
              : "border-rose-300 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {securities && securities.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No securities yet"
          description="Add a holding to get started — each ticker you hold will then appear here once."
          action={{ label: "Add holding", onClick: () => setAddOpen(true) }}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Securities</CardTitle>
            <CardDescription>
              The centralized list of tickers, cash positions, and other holdings you
              own. Rename a security here; add it to an account by recording a
              transaction.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{sortHeader("symbol", "Symbol")}</TableHead>
                    <TableHead>{sortHeader("description", "Description")}</TableHead>
                    <TableHead>{sortHeader("type", "Type")}</TableHead>
                    <TableHead>{sortHeader("currency", "Currency")}</TableHead>
                    <TableHead className="text-right">
                      {sortHeader("accounts", "# Accounts")}
                    </TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                  <TableRow>
                    <TableHead className="py-1">{filterInput("symbol", "Filter…")}</TableHead>
                    <TableHead className="py-1">
                      {filterInput("description", "Filter…")}
                    </TableHead>
                    <TableHead className="py-1">{filterInput("type", "Filter…")}</TableHead>
                    <TableHead className="py-1">{filterInput("currency", "Filter…")}</TableHead>
                    <TableHead className="py-1" />
                    <TableHead className="py-1" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                        {hasActiveFilter
                          ? "No securities match the current filters."
                          : "No securities."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r) => (
                      <TableRow key={r.s.id}>
                        <TableCell className="text-sm font-mono font-medium">
                          {r.symbol}
                          {r.s.isCash && (
                            <Badge variant="outline" className="ml-1.5 text-[10px]">
                              cash
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {r.description || <span className="text-muted-foreground">--</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {r.type}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {r.currency}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          <span
                            title={
                              r.s.accounts.length
                                ? r.s.accounts.map((a) => a.accountName ?? "—").join(", ")
                                : "Not held in any account yet"
                            }
                          >
                            {r.accounts}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openRename(r.s)}
                          >
                            <Pencil className="h-3.5 w-3.5 mr-1" /> Rename
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {rows.length} of {securities?.length ?? 0} securities
              {hasActiveFilter ? " (filtered)" : ""}.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Rebuild investment history — re-materializes daily portfolio_snapshots
          from the first transaction to today so the "Net Worth / Balance Over
          Time" charts reflect back-dated investment edits. The nightly cron is
          forward-only; this is the manual trigger. plan/net-worth-over-time.md. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
              <History className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Rebuild investment history</CardTitle>
              <CardDescription>
                Recompute daily portfolio value snapshots from your first
                transaction to today. Run this if the &ldquo;Net Worth Over
                Time&rdquo; chart looks stale after a back-dated trade edit.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <RebuildSnapshotsButton />
        </CardContent>
      </Card>

      {/* Add-holding dialog — the shared <HoldingEditForm> (same component as
          /portfolio mounts). Creating a holding dual-writes its security, which
          then appears in the table above. */}
      <Dialog open={addOpen} onOpenChange={(open) => { if (!open) setAddOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Holding</DialogTitle>
          </DialogHeader>
          {addOpen && (
            <HoldingEditForm
              onCancel={() => setAddOpen(false)}
              onSave={(result) => {
                setAddOpen(false);
                if (result.kind === "saved") showToast("success", "Holding saved");
                load();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog
        open={renameSecurity != null}
        onOpenChange={(open) => { if (!open) setRenameSecurity(null); }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename security</DialogTitle>
            <DialogDescription>
              Update the display label for{" "}
              {renameSecurity ? symbolLabel(renameSecurity) : "this security"}. This
              renames it across every account that holds it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Display name</Label>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="e.g. Apple Inc."
              />
              {renameErrors.name && (
                <p className="text-xs text-rose-600 mt-1">{renameErrors.name}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameSecurity(null)} disabled={renaming}>
              Cancel
            </Button>
            <Button onClick={submitRename} disabled={renaming}>
              {renaming ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

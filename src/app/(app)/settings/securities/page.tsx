"use client";

/**
 * /settings/securities — Securities master management UI.
 *
 * Lists each of the user's securities ONCE (centralized per-ticker
 * identity), shows which accounts hold each, and lets the user:
 *   - rename a security's display name (PATCH, re-encrypts)
 *   - link the security to another investment account (POST)
 *   - unlink it from an account (DELETE — transaction-free positions only)
 *
 * Bespoke fetch/useState/useEffect data loading (NO SWR), mirroring the
 * sibling /settings/holding-accounts page. All endpoints live at
 * /api/securities and use the `{ success, data }` envelope on success;
 * failures return non-2xx with `{ error }`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageSkeleton } from "@/components/page-skeleton";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { parseSaveError } from "@/lib/save-error";
import { Briefcase, Plus, Trash2, Pencil, RefreshCw } from "lucide-react";

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

type Account = {
  id: number;
  name: string;
  type: string;
  currency: string;
  isInvestment: boolean;
  archived?: boolean;
};

function securityLabel(s: Security): string {
  if (s.symbol && s.symbol.trim()) return s.symbol.trim();
  if (s.name && s.name.trim()) return s.name.trim();
  return "—";
}

function accountLabel(a: SecurityAccount): string {
  return a.accountName ?? "(unnamed)";
}

export default function SecuritiesPage() {
  const [securities, setSecurities] = useState<Security[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  // Rename dialog state.
  const [renameSecurity, setRenameSecurity] = useState<Security | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);

  // Link-account dialog state.
  const [linkSecurity, setLinkSecurity] = useState<Security | null>(null);
  const [linkAccountId, setLinkAccountId] = useState<string>("");
  const [linkErrors, setLinkErrors] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState(false);

  // Unlink confirm state.
  const [unlinkTarget, setUnlinkTarget] = useState<{ security: Security; account: SecurityAccount } | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, aRes] = await Promise.all([
        fetch("/api/securities"),
        fetch("/api/accounts"),
      ]);
      if (!sRes.ok) throw new Error("Failed to load securities");
      if (!aRes.ok) throw new Error("Failed to load accounts");
      const sJson: { data: Security[] } = await sRes.json();
      const aJson: Account[] = await aRes.json();
      setSecurities(sJson.data);
      setAccounts(aJson);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  }

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
      await loadAll();
    } catch (e) {
      setRenameErrors({ name: e instanceof Error ? e.message : "Rename failed" });
    } finally {
      setRenaming(false);
    }
  }

  // ---- Link account ----------------------------------------------------

  const eligibleAccountsForLink = useMemo(() => {
    if (!linkSecurity) return [];
    const taken = new Set(linkSecurity.accounts.map((a) => a.accountId));
    return accounts.filter((a) => a.isInvestment && !a.archived && !taken.has(a.id));
  }, [linkSecurity, accounts]);

  function openLink(s: Security) {
    setLinkSecurity(s);
    setLinkAccountId("");
    setLinkErrors({});
  }

  async function submitLink() {
    if (!linkSecurity) return;
    const accountId = parseInt(linkAccountId, 10);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      setLinkErrors({ account: "Account is required" });
      return;
    }
    setLinkErrors({});
    setLinking(true);
    try {
      const res = await fetch("/api/securities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ securityId: linkSecurity.id, accountId }),
      });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to link account");
        setLinkErrors({ account: msg });
        return;
      }
      setLinkSecurity(null);
      showToast("success", "Account linked");
      await loadAll();
    } catch (e) {
      setLinkErrors({ account: e instanceof Error ? e.message : "Link failed" });
    } finally {
      setLinking(false);
    }
  }

  // ---- Unlink ----------------------------------------------------------

  async function confirmUnlink() {
    if (!unlinkTarget) return;
    setUnlinking(true);
    try {
      const params = new URLSearchParams({ positionId: String(unlinkTarget.account.positionId) });
      const res = await fetch(`/api/securities?${params.toString()}`, { method: "DELETE" });
      if (!res.ok) {
        const msg = await parseSaveError(res, "Failed to unlink account");
        showToast("error", msg);
        return;
      }
      showToast("success", "Account unlinked");
      setUnlinkTarget(null);
      await loadAll();
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "Unlink failed");
    } finally {
      setUnlinking(false);
    }
  }

  // ---- Render ----------------------------------------------------------

  if (loading && !securities) {
    return (
      <div className="max-w-4xl">
        <PageSkeleton variant="cards" rows={4} />
      </div>
    );
  }

  if (error && !securities) {
    return (
      <div className="max-w-4xl">
        <ErrorState
          title="Couldn't load securities"
          message={error}
          onRetry={loadAll}
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Securities</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Each ticker you hold appears once here. Link it to more accounts or rename its display label.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {toast && (
        <Card className={toast.type === "success" ? "border-emerald-200 bg-emerald-50/30" : "border-rose-200 bg-rose-50/30"}>
          <CardContent className="py-3 text-sm">{toast.msg}</CardContent>
        </Card>
      )}

      {securities && securities.length === 0 && (
        <EmptyState
          icon={Briefcase}
          title="No securities yet"
          description="Add a holding from the Portfolio page first. Each ticker you hold will then appear here."
          action={{ label: "Go to Portfolio", href: "/portfolio" }}
        />
      )}

      {securities && securities.length > 0 && (
        <div className="space-y-4">
          {securities.map((s) => (
            <Card key={s.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base inline-flex items-center gap-2">
                      <Briefcase className="h-4 w-4 text-cyan-500" />
                      {securityLabel(s)}
                      <Badge variant="outline" className="text-[10px]">{s.assetType}</Badge>
                      <Badge variant="outline" className="text-[10px] font-mono">{s.currency}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {s.name && s.name.trim() && s.name.trim() !== securityLabel(s)
                        ? s.name.trim()
                        : s.accounts.length === 0
                          ? "Not linked to any account yet."
                          : `Held in ${s.accounts.length} ${s.accounts.length === 1 ? "account" : "accounts"}.`}
                    </CardDescription>
                  </div>
                  <div className="inline-flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => openRename(s)} title="Rename">
                      <Pencil className="h-3.5 w-3.5 mr-1" />
                      Rename
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openLink(s)}>
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Link account
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {s.accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No linked accounts.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {s.accounts.map((a) => (
                      <li key={a.positionId} className="flex items-center justify-between gap-3 py-2">
                        <div>
                          <div className="font-medium text-sm">{accountLabel(a)}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {a.isCash
                              ? "Cash sleeve"
                              : a.isInvestment
                                ? "Investment account"
                                : "Non-investment account"}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setUnlinkTarget({ security: s, account: a })}
                          title="Unlink"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1 text-rose-500" />
                          Unlink
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Rename dialog */}
      <Dialog open={renameSecurity != null} onOpenChange={(open) => { if (!open) setRenameSecurity(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename security</DialogTitle>
            <DialogDescription>
              Update the display label for {renameSecurity ? securityLabel(renameSecurity) : "this security"}. This renames it across every account that holds it.
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
              {renameErrors.name && <p className="text-xs text-rose-600 mt-1">{renameErrors.name}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameSecurity(null)} disabled={renaming}>Cancel</Button>
            <Button onClick={submitRename} disabled={renaming}>
              {renaming ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link-account dialog */}
      <Dialog open={linkSecurity != null} onOpenChange={(open) => { if (!open) setLinkSecurity(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Link account</DialogTitle>
            <DialogDescription>
              Add an investment account that holds {linkSecurity ? securityLabel(linkSecurity) : "this security"}. This creates an empty position you can populate from the Portfolio page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Account</Label>
              <Select value={linkAccountId} onValueChange={(v) => setLinkAccountId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Choose an account" /></SelectTrigger>
                <SelectContent>
                  {eligibleAccountsForLink.length === 0 ? (
                    <SelectItem value="__none__" disabled>No eligible accounts</SelectItem>
                  ) : (
                    eligibleAccountsForLink.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name} <span className="text-muted-foreground">({a.currency})</span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {linkErrors.account && <p className="text-xs text-rose-600 mt-1">{linkErrors.account}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkSecurity(null)} disabled={linking}>Cancel</Button>
            <Button onClick={submitLink} disabled={linking}>
              {linking ? "Linking…" : "Link account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlink confirmation */}
      <ConfirmDialog
        open={unlinkTarget != null}
        onOpenChange={(open) => { if (!open) setUnlinkTarget(null); }}
        title="Unlink account"
        description={
          unlinkTarget
            ? `Remove ${accountLabel(unlinkTarget.account)} from ${securityLabel(unlinkTarget.security)}? This only unlinks the position; transactions are never touched.`
            : ""
        }
        confirmLabel="Unlink"
        busyLabel="Unlinking…"
        busy={unlinking}
        onConfirm={confirmUnlink}
      />
    </div>
  );
}

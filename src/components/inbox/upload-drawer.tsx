"use client";

/**
 * UploadDrawer — account-pre-scoped right-side drawer triggered from the
 * /inbox header.
 *
 * Phase 2 of the money-in consolidation: the drawer now performs the upload
 * IN PLACE instead of routing out to /import. It reuses ReconcileUploadCard
 * (with the account locked to the drawer's account) + ColumnMappingDialog and
 * POSTs to the same /api/import/staging/upload endpoint /import/reconcile uses.
 * On success it calls `onUploaded()` so the parent surface refreshes the
 * policy-appropriate tab — the user never leaves /inbox.
 *
 * The upload route branches on the account's POLICY server-side (auto/approve
 * → simplified path → bank_transactions; manual → per-template import_mode →
 * staging or bank). The "After upload" bullets below describe that policy
 * behavior so the user knows where the rows will land.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, CheckCircle2, AlertCircle } from "lucide-react";
import { MODES, type Mode } from "./modes";
import { ReconcileUploadCard } from "@/components/reconcile/upload-card";
import type { AccountOption } from "@/components/reconcile/preview-table";
import { ColumnMappingDialog } from "@/app/(app)/import/components/column-mapping-dialog";
import type { ColumnMapping, ImportTemplate } from "@/lib/import-templates";

interface AfterUploadBullet {
  body: React.ReactNode;
}

function bulletsForPolicy(policy: Mode): AfterUploadBullet[] {
  if (policy === "auto") {
    return [
      {
        body: (
          <>
            Matched rules →{" "}
            <span className="font-medium text-foreground">Reconciled</span>
          </>
        ),
      },
      {
        body: (
          <>
            Unmatched →{" "}
            <span className="font-medium text-foreground">To categorize</span>
          </>
        ),
      },
    ];
  }
  if (policy === "approve") {
    return [
      {
        body: (
          <>
            Rows land in{" "}
            <span className="font-medium text-foreground">To approve</span>{" "}
            with suggestions
          </>
        ),
      },
    ];
  }
  return [
    {
      body: (
        <>
          Rows land in{" "}
          <span className="font-medium text-foreground">Staging</span>{" "}
          two-pane for parse review
        </>
      ),
    },
    {
      body: (
        <>
          Approved rows move to{" "}
          <span className="font-medium text-foreground">Reconcile</span>{" "}
          two-pane
        </>
      ),
    },
  ];
}

type DateFormatOverrideUi = "auto" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

interface UploadParams {
  file: File;
  accountId: number | null;
  tolerance: number;
  templateId: number | null;
  statementBalance: number | null;
  skipHeaderRows: number;
  skipFooterRows: number;
  dateFormatOverride: DateFormatOverrideUi;
  defaultCurrency: string | null;
}

interface UploadResponse {
  stagedImportId: string;
  redirectTo: string;
  format: "csv" | "ofx" | "qfx";
  counts: {
    new?: number;
    existing?: number;
    probableDuplicate?: number;
    skippedDuplicate?: number;
    appended?: number;
    alreadyInBatch?: number;
    errors: number;
  };
  tolerance: number;
  merged?: boolean;
}

export function UploadDrawer({
  open,
  onOpenChange,
  accountId,
  accountLabel,
  accountCurrency,
  policy,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: number;
  accountLabel: string;
  accountCurrency: string;
  policy: Mode;
  /** Called after a successful upload so the parent surface can refresh the
   *  policy-appropriate tab. The drawer stays open showing a result panel; the
   *  parent decides when to close it (the "View rows" button calls this). */
  onUploaded: () => void;
}) {
  const cfg = MODES[policy];
  const bullets = bulletsForPolicy(policy);

  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [accountNames, setAccountNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);

  // Column-mapping dialog state — mirrors /import/reconcile. Non-canonical
  // CSVs (IBKR etc.) need a column-mapping pass before staging can persist.
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [mappingHeaders, setMappingHeaders] = useState<string[]>([]);
  const [mappingSampleRows, setMappingSampleRows] = useState<
    Record<string, string>[]
  >([]);
  const [mappingSuggested, setMappingSuggested] = useState<ColumnMapping | null>(
    null,
  );
  const [mappingFileName, setMappingFileName] = useState<string>("");
  const [mappingSubmitting, setMappingSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingParams, setPendingParams] = useState<Omit<
    UploadParams,
    "file" | "templateId"
  > | null>(null);

  const lockedAccount: AccountOption = useMemo(
    () => ({
      id: accountId,
      name: accountLabel,
      currency: accountCurrency,
      isInvestment: false,
    }),
    [accountId, accountLabel, accountCurrency],
  );

  // Load templates + account names when the drawer opens. Account names feed
  // the ColumnMappingDialog's default-account picker; templates feed the card.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([
      fetch("/api/import/templates").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/accounts").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([tpls, accts]) => {
        if (cancelled) return;
        if (Array.isArray(tpls)) setTemplates(tpls);
        if (Array.isArray(accts)) {
          setAccountNames(accts.map((a: { name: string }) => a.name));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset transient state each time the drawer opens or the account changes,
  // so a prior upload's result/error doesn't leak into a fresh session.
  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setUploadLoading(false);
    }
  }, [open, accountId]);

  // ESC closes the drawer — matches the standard sheet/dialog interaction.
  // Skip while the mapping dialog is open so ESC dismisses the dialog first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !mappingDialogOpen) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange, mappingDialogOpen]);

  const submitUpload = useCallback(
    async (params: UploadParams) => {
      const {
        file,
        tolerance,
        templateId,
        statementBalance,
        skipHeaderRows,
        skipFooterRows,
        dateFormatOverride,
        defaultCurrency,
      } = params;
      setError(null);
      setUploadLoading(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        // Account is always the drawer's account (locked).
        fd.append("accountId", String(accountId));
        if (templateId) fd.append("templateId", String(templateId));
        fd.append("tolerance", String(tolerance));
        if (statementBalance !== null) {
          fd.append("statementBalance", String(statementBalance));
        }
        if (skipHeaderRows > 0) fd.append("skipHeaderRows", String(skipHeaderRows));
        if (skipFooterRows > 0) fd.append("skipFooterRows", String(skipFooterRows));
        if (dateFormatOverride !== "auto") {
          fd.append("dateFormatOverride", dateFormatOverride);
        }
        if (defaultCurrency) fd.append("defaultCurrency", defaultCurrency);

        const res = await fetch("/api/import/staging/upload", {
          method: "POST",
          body: fd,
        });
        const json = await res.json();
        if (!res.ok) {
          // 422 csv-needs-mapping → open the column-mapping dialog, save the
          // mapping as a template, then re-fire the upload with the templateId.
          if (
            res.status === 422 &&
            json &&
            typeof json === "object" &&
            json.type === "csv-needs-mapping"
          ) {
            setMappingHeaders(Array.isArray(json.headers) ? json.headers : []);
            setMappingSampleRows(
              Array.isArray(json.sampleRows) ? json.sampleRows : [],
            );
            setMappingSuggested(json.suggestedMapping ?? null);
            setMappingFileName(
              typeof json.fileName === "string" && json.fileName
                ? json.fileName
                : file.name,
            );
            setPendingFile(file);
            setPendingParams({
              accountId,
              tolerance,
              statementBalance,
              skipHeaderRows,
              skipFooterRows,
              dateFormatOverride,
              defaultCurrency,
            });
            setMappingDialogOpen(true);
            setUploadLoading(false);
            return;
          }
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        const data = json as UploadResponse;
        setResult(data);
        setUploadLoading(false);
        // Tell the parent to refresh the policy-appropriate tab. The drawer
        // stays open showing the result; the user clicks "View rows" to close.
        onUploaded();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
        setUploadLoading(false);
      }
    },
    [accountId, onUploaded],
  );

  const handleMappingConfirm = useCallback(
    async (params: {
      mapping: ColumnMapping;
      defaultAccount: string | null;
      templateName: string;
    }) => {
      if (!pendingFile || !pendingParams) {
        setMappingDialogOpen(false);
        return;
      }
      setMappingSubmitting(true);
      try {
        const tplRes = await fetch("/api/import/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: params.templateName,
            fileHeaders: mappingHeaders,
            columnMapping: params.mapping,
            defaultAccount: params.defaultAccount ?? undefined,
            skipHeaderRows: pendingParams.skipHeaderRows,
            skipFooterRows: pendingParams.skipFooterRows,
            dateFormatOverride:
              pendingParams.dateFormatOverride === "auto"
                ? null
                : pendingParams.dateFormatOverride,
            defaultCurrency: pendingParams.defaultCurrency,
          }),
        });
        const saved = await tplRes.json();
        if (!tplRes.ok || !saved?.id) {
          throw new Error(
            (saved && typeof saved.error === "string" ? saved.error : null) ??
              "Failed to save template",
          );
        }
        setTemplates((prev) =>
          prev.find((t) => t.id === saved.id) ? prev : [...prev, saved],
        );

        setMappingDialogOpen(false);
        const file = pendingFile;
        const carried = pendingParams;
        setPendingFile(null);
        setPendingParams(null);

        await submitUpload({
          file,
          accountId: carried.accountId,
          tolerance: carried.tolerance,
          templateId: saved.id as number,
          statementBalance: carried.statementBalance,
          skipHeaderRows: carried.skipHeaderRows,
          skipFooterRows: carried.skipFooterRows,
          dateFormatOverride: carried.dateFormatOverride,
          defaultCurrency: carried.defaultCurrency,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save template");
        setMappingDialogOpen(false);
      } finally {
        setMappingSubmitting(false);
      }
    },
    [pendingFile, pendingParams, mappingHeaders, submitUpload],
  );

  const templateOptions = useMemo(
    () =>
      templates.map((t) => ({
        id: t.id,
        name: t.name,
        skipHeaderRows: t.skipHeaderRows,
        skipFooterRows: t.skipFooterRows,
        dateFormatOverride: t.dateFormatOverride,
        defaultCurrency: t.defaultCurrency,
        defaultAccount: t.defaultAccount ?? null,
      })),
    [templates],
  );

  if (!open) return null;

  const c = result?.counts;
  const newCount = (c?.new ?? c?.appended ?? 0) as number;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l bg-background shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Upload to {accountLabel}</h2>
            <p className="text-xs text-muted-foreground">
              Policy: {cfg.label} · {cfg.gates} gate
              {cfg.gates !== 1 ? "s" : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => onOpenChange(false)}
            aria-label="Close upload drawer"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-5 space-y-5 flex-1 overflow-y-auto">
          {result ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/10 px-4 py-4 text-center">
                <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-600" />
                <p className="mt-2 text-sm font-medium">Upload complete</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {newCount} row{newCount === 1 ? "" : "s"} from your{" "}
                  {result.format.toUpperCase()} added to {accountLabel}
                  {c?.skippedDuplicate
                    ? ` · ${c.skippedDuplicate} duplicate${c.skippedDuplicate === 1 ? "" : "s"} skipped`
                    : ""}
                  {c?.errors ? ` · ${c.errors} error${c.errors === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              <div className={`rounded-md border px-3 py-2.5 text-xs ${cfg.tone}`}>
                <p className="font-medium">Where they landed — {cfg.label}:</p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc pl-4">
                  {bullets.map((b, i) => (
                    <li key={i}>{b.body}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <>
              <ReconcileUploadCard
                accounts={[lockedAccount]}
                templates={templateOptions}
                loading={uploadLoading}
                lockedAccount={lockedAccount}
                onUpload={(params) => void submitUpload(params)}
              />
              {error && (
                <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1">{error}</div>
                </div>
              )}
              <div className={`rounded-md border px-3 py-2.5 text-xs ${cfg.tone}`}>
                <p className="font-medium">After upload — {cfg.label}:</p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc pl-4">
                  {bullets.map((b, i) => (
                    <li key={i}>{b.body}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>

        <div className="border-t bg-background px-5 py-3 flex justify-end gap-2">
          {result ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResult(null)}
              >
                Upload another
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                View rows
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      <ColumnMappingDialog
        open={mappingDialogOpen}
        onOpenChange={(o) => {
          setMappingDialogOpen(o);
          if (!o) {
            setPendingFile(null);
            setPendingParams(null);
            setUploadLoading(false);
          }
        }}
        fileName={mappingFileName}
        headers={mappingHeaders}
        sampleRows={mappingSampleRows}
        suggestedMapping={mappingSuggested}
        accounts={accountNames}
        onConfirm={handleMappingConfirm}
        submitting={mappingSubmitting}
      />
    </>
  );
}

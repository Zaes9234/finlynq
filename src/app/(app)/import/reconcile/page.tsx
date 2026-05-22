"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertCircle, ArrowLeft, Download } from "lucide-react";
import { ReconcileUploadCard } from "@/components/reconcile/upload-card";
import type { AccountOption } from "@/components/reconcile/preview-table";
import { ColumnMappingDialog } from "@/app/(app)/import/components/column-mapping-dialog";
import type { ColumnMapping, ImportTemplate } from "@/lib/import-templates";

/**
 * /import/reconcile — upload entry point that routes everything through the
 * unified staging tables (issue #153). The upload posts to
 * `/api/import/staging/upload`, which persists rows into `staged_imports` +
 * `staged_transactions`, then redirects to `/import/pending?id=<stagedImportId>`
 * where the user reviews and approves the batch.
 *
 * The old preview-and-commit pair on `/api/import/reconcile/{preview,commit}`
 * is gone; everything materializes through the same `/import/pending` review
 * surface as the email-import path.
 */

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

interface UploadParams {
  file: File;
  accountId: number | null;
  tolerance: number;
  templateId: number | null;
  statementBalance: number | null;
  /** FINLYNQ-54 parser knobs — defaults preserve pre-FINLYNQ-54 behavior. */
  skipHeaderRows: number;
  skipFooterRows: number;
  dateFormatOverride: "auto" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
  defaultCurrency: string | null;
}

export default function ReconcilePage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [accountNames, setAccountNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);

  // Mapping dialog state — same as before. Non-canonical CSVs (IBKR etc.)
  // still need a column-mapping dialog before staging can persist them.
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
  const [pendingParams, setPendingParams] = useState<{
    accountId: number | null;
    tolerance: number;
    statementBalance: number | null;
    skipHeaderRows: number;
    skipFooterRows: number;
    dateFormatOverride: "auto" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
    defaultCurrency: string | null;
  } | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch("/api/accounts").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/import/templates").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([accts, tpls]) => {
        if (Array.isArray(accts)) {
          setAccounts(
            accts.map((a: { id: number; name: string; currency: string; isInvestment?: boolean }) => ({
              id: a.id,
              name: a.name,
              currency: a.currency,
              isInvestment: !!a.isInvestment,
            })),
          );
          setAccountNames(accts.map((a: { name: string }) => a.name));
        }
        if (Array.isArray(tpls)) {
          setTemplates(tpls);
        }
      })
      .catch(() => {});
  }, []);

  const submitUpload = useCallback(
    async (params: UploadParams) => {
      const {
        file,
        accountId,
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
        if (accountId) fd.append("accountId", String(accountId));
        if (templateId) fd.append("templateId", String(templateId));
        fd.append("tolerance", String(tolerance));
        if (statementBalance !== null) {
          fd.append("statementBalance", String(statementBalance));
        }
        // FINLYNQ-54 — only forward knobs when they differ from the defaults
        // so the server-side validator doesn't have to special-case "0"/"auto"
        // strings. Server defaults to 0/0/null/null when fields are absent.
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
          // 422 with type:"csv-needs-mapping" → open the column-mapping
          // dialog. The user maps columns, we POST /api/import/templates to
          // persist the mapping, then re-fire this upload with the new
          // templateId so staging gets the parsed rows.
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
            return;
          }
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        const data = json as UploadResponse;
        // Redirect to the unified review page. The review-and-commit
        // experience is exclusively at /import/pending now.
        router.push(data.redirectTo ?? `/import/pending?id=${data.stagedImportId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
        setUploadLoading(false);
      }
    },
    [router],
  );

  const handleUpload = useCallback(
    (params: UploadParams) => {
      void submitUpload(params);
    },
    [submitUpload],
  );

  // Column-mapping confirm — save the mapping as a template, then re-fire
  // the upload using that template so staging actually receives parsed rows.
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
            // Persist the user's current parser knobs on the new template so
            // the next upload from this source auto-applies them. The server
            // clamps + validates these — UI sends raw values from pendingParams.
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
            (saved && typeof saved.error === "string"
              ? saved.error
              : null) ?? "Failed to save template",
          );
        }
        setTemplates((prev) => {
          if (prev.find((t) => t.id === saved.id)) return prev;
          return [...prev, saved];
        });

        setMappingDialogOpen(false);
        const file = pendingFile;
        const {
          accountId,
          tolerance,
          statementBalance,
          skipHeaderRows,
          skipFooterRows,
          dateFormatOverride,
          defaultCurrency,
        } = pendingParams;
        setPendingFile(null);
        setPendingParams(null);

        await submitUpload({
          file,
          accountId,
          tolerance,
          templateId: saved.id as number,
          statementBalance,
          skipHeaderRows,
          skipFooterRows,
          dateFormatOverride,
          defaultCurrency,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to save template";
        setError(message);
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
      })),
    [templates],
  );

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reconciliation Mode</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Upload a statement (CSV / OFX / QFX) — every row lands in the{" "}
            <Link href="/import/pending" className="underline font-medium">
              pending-imports queue
            </Link>{" "}
            for review. Each row is classified as <strong>New</strong>,{" "}
            <strong>Existing</strong>, or <strong>Probable duplicate</strong>{" "}
            against your current Finlynq state before any write.
          </p>
        </div>
        <Link
          href="/import"
          className="text-xs text-muted-foreground inline-flex items-center hover:underline"
        >
          <ArrowLeft className="h-3 w-3 mr-1" /> Back to Import
        </Link>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
          <div className="flex-1">{error}</div>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Upload statement</CardTitle>
              <CardDescription>
                Supported: CSV (with <code>Date,Account,Amount,Payee</code>{" "}
                headers, a saved template, or column-mapping on the fly) and
                OFX/QFX (single-account statements — pick the destination
                Finlynq account below). After upload you&rsquo;ll be
                redirected to the review queue.
              </CardDescription>
            </div>
            <a
              href="/sample-statement.ofx"
              download
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
              aria-label="Download a sample OFX statement to try the upload flow"
            >
              <Download className="h-3.5 w-3.5" />
              Download sample OFX
            </a>
          </div>
        </CardHeader>
        <CardContent>
          <ReconcileUploadCard
            accounts={accounts}
            templates={templateOptions}
            loading={uploadLoading}
            onUpload={handleUpload}
          />
        </CardContent>
      </Card>

      <ColumnMappingDialog
        open={mappingDialogOpen}
        onOpenChange={(open) => {
          setMappingDialogOpen(open);
          if (!open) {
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

    </div>
  );
}

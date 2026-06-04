"use client";

/**
 * InvestmentStatementImporter — the advanced investment-statement upload path
 * (issue #64) relocated to /settings/import as part of the money-in
 * consolidation (Phase 3).
 *
 * Handles the two things the account-anchored /import upload drawer can't:
 *   - IBKR FlexQuery XML (.xml) statements.
 *   - Multi-account investment statements (one file → bind each brokerage
 *     sub-account to a different Finlynq account).
 *
 * It is the SAME flow the legacy /import page ran for `type:"investment-
 * statement"` previews: file → POST /api/import/preview → InvestmentStatement
 * Preview (bind external accounts) → POST /api/import/execute. Plain CSV / OFX
 * bank statements should go through the account surface's upload drawer
 * (staging) instead; this importer rejects them with a pointer.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, AlertCircle, Landmark, Loader2 } from "lucide-react";
import { FileDropZone } from "./file-drop-zone";
import {
  InvestmentStatementPreview,
  type InvestmentExternalAccount,
} from "./investment-statement-preview";
import type { RawTransaction } from "@/lib/import-pipeline";

export function InvestmentStatementImporter() {
  const [accountNames, setAccountNames] = useState<string[]>([]);
  const [status, setStatus] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);
  const [busy, setBusy] = useState(false);

  // Investment-statement preview state (mirrors the legacy /import page).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [format, setFormat] = useState<"ofx" | "qfx" | "ibkr-xml">("ofx");
  const [externalAccounts, setExternalAccounts] = useState<
    InvestmentExternalAccount[]
  >([]);
  const [rows, setRows] = useState<RawTransaction[]>([]);
  const [dateRange, setDateRange] = useState<{
    start: string;
    end: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setAccountNames(data.map((a: { name: string }) => a.name));
        }
      })
      .catch(() => {});
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setStatus(null);
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/import/preview", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.type === "investment-statement") {
        const fmt: "ofx" | "qfx" | "ibkr-xml" =
          data.format === "qfx"
            ? "qfx"
            : data.format === "ibkr-xml"
              ? "ibkr-xml"
              : "ofx";
        setFormat(fmt);
        setExternalAccounts(data.externalAccounts ?? []);
        setRows(data.rows ?? []);
        setDateRange(data.dateRange ?? null);
        setPreviewOpen(true);
      } else {
        setStatus({
          type: "error",
          message:
            "That doesn't look like an investment statement (IBKR XML / OFX-INVSTMTRS). For CSV or plain bank OFX/QFX, upload it from the Import page instead.",
        });
      }
    } catch (err: unknown) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to process file",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const handleConfirm = useCallback(async (boundRows: RawTransaction[]) => {
    setPreviewOpen(false);
    setBusy(true);
    try {
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: boundRows, forceImportIndices: [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const errCount = Array.isArray(data.errors) ? data.errors.length : 0;
      const errSuffix = errCount > 0 ? `, ${errCount} errors` : "";
      setStatus({
        type: errCount > 0 && data.imported === 0 ? "error" : "success",
        message: `Imported ${data.imported} rows (${data.skippedDuplicates ?? 0} duplicates skipped${errSuffix})`,
      });
    } catch (err: unknown) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Import failed",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-4 space-y-1.5">
        <p className="text-sm font-medium flex items-center gap-2">
          <Landmark className="h-4 w-4 text-indigo-600" />
          Investment statements
        </p>
        <p className="text-xs text-muted-foreground">
          Upload an IBKR FlexQuery XML or an OFX/QFX investment statement
          (with <code>&lt;INVSTMTRS&gt;</code>). Multi-account files let you
          bind each brokerage sub-account to a different Finlynq account before
          import. For plain CSV or bank OFX/QFX, use the Import page upload
          instead.
        </p>
      </div>

      <FileDropZone accept=".ofx,.qfx,.xml" disabled={busy} onFileSelected={handleFile} />

      {busy && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Processing…
        </div>
      )}

      {status && (
        <Card
          className={
            status.type === "success"
              ? "border-emerald-200 bg-emerald-50/30"
              : "border-rose-200 bg-rose-50/30"
          }
        >
          <CardContent className="py-3">
            <div className="flex items-start gap-2">
              {status.type === "success" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-600 mt-0.5" />
              )}
              <p
                className={`text-sm ${status.type === "success" ? "text-emerald-700" : "text-rose-700"}`}
              >
                {status.message}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <InvestmentStatementPreview
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        format={format}
        externalAccounts={externalAccounts}
        rows={rows}
        dateRange={dateRange}
        finlynqAccounts={accountNames}
        onConfirm={handleConfirm}
      />
    </div>
  );
}

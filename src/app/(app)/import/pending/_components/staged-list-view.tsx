"use client";

/**
 * Pending-imports list view (FINLYNQ-118 Phase 4).
 *
 * The `openId == null` branch — pending batches; click a card to open the
 * two-pane reconciliation view. Extracted verbatim from import/pending/page.tsx.
 */

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, Inbox, Mail, Upload, Clock, RefreshCw,
} from "lucide-react";
import { daysUntil, type StagedRow } from "../_types";

export function StagedListView({
  list,
  loading,
  error,
  toast,
  loadList,
  openDetail,
  embedded = false,
}: {
  list: StagedRow[] | null;
  loading: boolean;
  error: string | null;
  toast: { type: "success" | "error"; msg: string } | null;
  loadList: () => void;
  openDetail: (id: string) => void;
  /** When embedded inside the /import Staging tab, drop the standalone-page
   *  chrome (Back-to-Import link + big "Pending Imports" h1) and show a
   *  lighter inline strip instead — the surrounding tab already provides the
   *  page header + account context. */
  embedded?: boolean;
}) {
  return (
    <div className={embedded ? "space-y-3" : "space-y-6"}>
      {!embedded && (
        <div className="flex items-center gap-3">
          <Link
            href="/import"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Import
          </Link>
        </div>
      )}

      {embedded ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs flex items-center justify-between gap-2">
          <span>
            Staged imports for this account waiting for parse review. Click a
            batch to open the two-pane staging surface for approve / discard /
            re-apply rules.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={loadList}
            disabled={loading}
            className="h-7"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pending Imports</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Transactions from email forwards or file uploads (CSV / OFX /
              QFX), waiting for your review. Rows auto-expire after 60 days.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={loadList} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      )}

      {toast && (
        <Card
          className={
            toast.type === "success"
              ? "border-emerald-200 bg-emerald-50/30"
              : "border-rose-200 bg-rose-50/30"
          }
        >
          <CardContent className="py-3 text-sm">{toast.msg}</CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-rose-200 bg-rose-50/30">
          <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
        </Card>
      )}

      {loading && !list && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground text-center">
            Loading…
          </CardContent>
        </Card>
      )}

      {list && list.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm font-medium">Nothing pending</p>
              <p className="text-xs text-muted-foreground mt-1">
                Upload a CSV/OFX/QFX statement from the{" "}
                <Link href="/import" className="underline">
                  Import
                </Link>{" "}
                page, or forward a bank statement to your import address — both
                land here for review.
              </p>
            </div>
            <Link href="/import" className="inline-block">
              <Button variant="outline" size="sm">
                View import options
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {list && list.length > 0 && (
        <div className="space-y-3">
          {list.map((row) => {
            const isUpload = row.source === "upload";
            const Icon = isUpload ? Upload : Mail;
            const headline = isUpload
              ? row.originalFilename || "Uploaded file"
              : row.subject || "(no subject)";
            const subline = isUpload
              ? `${(row.fileFormat ?? "file").toUpperCase()} upload · ${new Date(
                  row.receivedAt,
                ).toLocaleString()}`
              : `from ${row.fromAddress || "(unknown)"} · received ${new Date(
                  row.receivedAt,
                ).toLocaleString()}`;
            return (
              <Card
                key={row.id}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => openDetail(row.id)}
              >
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                        <p className="text-sm font-medium truncate">{headline}</p>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{subline}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="font-mono">
                        {row.totalRowCount} {row.totalRowCount === 1 ? "row" : "rows"}
                      </Badge>
                      {row.duplicateCount > 0 && (
                        <Badge
                          variant="outline"
                          className="bg-amber-50 text-amber-700 border-amber-200"
                        >
                          {row.duplicateCount} dupe{row.duplicateCount === 1 ? "" : "s"}
                        </Badge>
                      )}
                      <Badge variant="outline" className="bg-muted/60 text-xs">
                        <Clock className="h-3 w-3 mr-1" />
                        {daysUntil(row.expiresAt)}d left
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

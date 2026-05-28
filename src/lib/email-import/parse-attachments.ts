/**
 * Resend Inbound attachment → RawTransaction[] parser.
 *
 * Resend posts attachments as base64-encoded bytes alongside a filename and
 * content type. We decode, dispatch to the existing CSV/OFX/PDF/Excel parsers
 * in src/lib/*, and return flat rows for staging.
 *
 * Bank templates are applied per-user — we try to match the CSV header row
 * against the user's saved `import_templates` before falling back to
 * auto-detect. (Same logic as the old auto-import multipart handler.)
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractCSVHeaders,
} from "@/lib/csv-parser";
import { extractExcelRows, parseExcelSheets } from "@/lib/excel-parser";
import type { RawTransaction } from "@/lib/import-pipeline";
import { deserializeTemplate, findBestTemplate, autoDetectColumnMapping } from "@/lib/import-templates";

export interface ResendAttachment {
  filename: string;
  /** Resend may send either `content_type` or `contentType` — we accept both. */
  contentType?: string;
  /** base64-encoded bytes. Resend docs currently say `content_b64`; accept `content` too. */
  content: string;
}

/**
 * Result of parsing email-import attachments.
 *
 * `rows` is the flat per-transaction list (input for stageEmailImport).
 *
 * `csvFallbackMeta` carries the headers + first ~3 data rows from the
 * FIRST CSV attachment, captured unconditionally for every CSV regardless
 * of whether a template matched. The /import/pending detail page uses it
 * to render a "Pick template / Bind to account" picker when the resulting
 * staged_transactions rows lack a usable account_name (either no template
 * matched, OR a template matched but its defaultAccount was empty — the
 * smoke-template case that bit us on first ship). The route handler is
 * what decides whether to surface the picker; the parser just snapshots
 * the metadata so the data is there if needed. Null for non-CSV inputs.
 *
 * We capture only the first CSV because the typical email-import case is
 * one CSV per email; the second-onwards would overwrite the first in the
 * staged_imports row anyway, and showing a second metadata snapshot in
 * the UI would be confusing.
 */
export interface ParseResendAttachmentsResult {
  rows: RawTransaction[];
  csvFallbackMeta: {
    headers: string[];
    sampleRows: Array<Record<string, string>>;
  } | null;
}

const SAMPLE_ROW_COUNT = 3;

/**
 * Parse Resend attachments into flat RawTransaction rows for the given user.
 * Unrecognized file types are skipped silently.
 */
export async function parseResendAttachments(
  attachments: ResendAttachment[],
  userId: string,
): Promise<ParseResendAttachmentsResult> {
  // Load the user's templates once for CSV header matching.
  const templateRows = await db
    .select()
    .from(schema.importTemplates)
    .where(eq(schema.importTemplates.userId, userId))
    .all();
  const templates = templateRows.map(deserializeTemplate);

  const allRows: RawTransaction[] = [];
  let csvFallbackMeta: ParseResendAttachmentsResult["csvFallbackMeta"] = null;

  for (const att of attachments) {
    const ext = att.filename.split(".").pop()?.toLowerCase();
    const buffer = Buffer.from(att.content, "base64");
    let rows: RawTransaction[] = [];

    if (ext === "csv" || att.contentType === "text/csv") {
      const text = buffer.toString("utf8");
      const headers = extractCSVHeaders(text);
      const bestMatch = findBestTemplate(headers, templates);

      if (bestMatch) {
        const result = csvToRawTransactionsWithMapping(
          text,
          bestMatch.template.columnMapping as unknown as Record<string, string>,
        );
        rows = result.rows;
        if (bestMatch.template.defaultAccount) {
          rows = rows.map((r) => ({
            ...r,
            account: r.account || bestMatch.template.defaultAccount!,
          }));
        }
      } else {
        rows = csvToRawTransactions(text).rows;
      }

      // Capture metadata for the FIRST CSV attachment unconditionally —
      // see interface doc. Picker visibility is decided downstream based
      // on whether the resulting staged_transactions rows have a usable
      // account_name (template-matched-with-empty-defaultAccount produces
      // bound rows here but unbound rows downstream, so capture is the
      // safe default).
      if (csvFallbackMeta === null && headers.length > 0) {
        const sampleRows: Array<Record<string, string>> = [];
        const dataLines = text.split(/\r?\n/).slice(1, 1 + SAMPLE_ROW_COUNT);
        for (const line of dataLines) {
          if (!line.trim()) continue;
          const cells = parseCsvLine(line);
          const row: Record<string, string> = {};
          headers.forEach((h, i) => {
            row[h] = cells[i] ?? "";
          });
          sampleRows.push(row);
        }
        csvFallbackMeta = { headers, sampleRows };
      }
    } else if (ext === "pdf" || att.contentType === "application/pdf") {
      // Dynamic import — PDF parser is heavy (~5 MB), lazy-load.
      const { parsePdfToTransactions } = await import("@/lib/pdf-parser");
      const result = await parsePdfToTransactions(buffer);
      rows = result.rows;
    } else if (ext === "xlsx" || ext === "xls") {
      const sheets = await parseExcelSheets(buffer);
      if (sheets.length > 0 && sheets[0].headers.length > 0) {
        const sheet = sheets[0];
        const mapping = autoDetectColumnMapping(sheet.headers);
        if (mapping) {
          rows = (await extractExcelRows(buffer, sheet.name, mapping)).rows;
        }
      }
    }
    // OFX/QFX from email — add later if needed (banks rarely send OFX).

    allRows.push(...rows);
  }

  return { rows: allRows, csvFallbackMeta };
}

/**
 * Minimal RFC4180-ish CSV line splitter for sample-row capture. Handles
 * double-quoted fields with embedded commas + escaped quotes. Not used for
 * actual import parsing (`csv-parser.ts` owns that) — only for snapshotting
 * preview rows surfaced in the manual-pick UI.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"' && cur === "") {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

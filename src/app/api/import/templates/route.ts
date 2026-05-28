import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { deserializeTemplate, autoDetectColumnMapping } from "@/lib/import-templates";
import type {
  ColumnMapping,
  DateFormatOverride,
  ImportMode,
} from "@/lib/import-templates";
import { SUPPORTED_CURRENCIES } from "@/lib/fx/supported-currencies";

/** Phase 2 of import-modes refactor — accept 'simplified' | 'detailed', fall
 *  back to 'detailed' for anything else (back-compat with pre-Phase-1 clients). */
function coerceImportMode(raw: unknown): ImportMode {
  return raw === "simplified" ? "simplified" : "detailed";
}

/** Coerce + clamp the int knobs and validate the enum knobs. Returns the
 *  shape we feed to Drizzle. Centralized so POST and PUT can't drift. */
function sanitizeKnobs(body: {
  skipHeaderRows?: unknown;
  skipFooterRows?: unknown;
  dateFormatOverride?: unknown;
  defaultCurrency?: unknown;
}): {
  skipHeaderRows: number;
  skipFooterRows: number;
  dateFormatOverride: DateFormatOverride | null;
  defaultCurrency: string | null;
} {
  const clampInt = (raw: unknown) => {
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? 0), 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(100, Math.floor(n));
  };
  const fmtRaw = body.dateFormatOverride;
  const fmt: DateFormatOverride | null =
    fmtRaw === "DD/MM/YYYY" || fmtRaw === "MM/DD/YYYY" || fmtRaw === "YYYY-MM-DD"
      ? fmtRaw
      : null;
  const ccyRaw = typeof body.defaultCurrency === "string" ? body.defaultCurrency.toUpperCase() : null;
  const ccy =
    ccyRaw && (SUPPORTED_CURRENCIES as readonly string[]).includes(ccyRaw) ? ccyRaw : null;
  return {
    skipHeaderRows: clampInt(body.skipHeaderRows),
    skipFooterRows: clampInt(body.skipFooterRows),
    dateFormatOverride: fmt,
    defaultCurrency: ccy,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const rows = await db
      .select()
      .from(schema.importTemplates)
      .where(eq(schema.importTemplates.userId, userId))
      .all();

    return NextResponse.json(rows.map(deserializeTemplate));
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to fetch templates") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const body = await request.json() as {
      name: string;
      fileHeaders: string[];
      columnMapping?: ColumnMapping;
      defaultAccount?: string;
      isDefault?: boolean;
      skipHeaderRows?: number;
      skipFooterRows?: number;
      dateFormatOverride?: string | null;
      defaultCurrency?: string | null;
      importMode?: ImportMode | string | null;
    };

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Template name is required" }, { status: 400 });
    }
    if (!Array.isArray(body.fileHeaders) || body.fileHeaders.length === 0) {
      return NextResponse.json({ error: "fileHeaders is required" }, { status: 400 });
    }

    // Auto-detect mapping if not provided
    const mapping: ColumnMapping | null =
      body.columnMapping ?? autoDetectColumnMapping(body.fileHeaders);

    if (!mapping) {
      return NextResponse.json(
        { error: "Could not detect column mapping. Please provide columnMapping explicitly." },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();

    // If this is set as default, clear other defaults for user
    if (body.isDefault) {
      await db.update(schema.importTemplates)
        .set({ isDefault: 0 })
        .where(eq(schema.importTemplates.userId, userId))
        ;
    }

    const knobs = sanitizeKnobs(body);

    const result = await db
      .insert(schema.importTemplates)
      .values({
        userId,
        name: body.name.trim(),
        fileHeaders: JSON.stringify(body.fileHeaders),
        columnMapping: JSON.stringify(mapping),
        defaultAccount: body.defaultAccount ?? null,
        isDefault: body.isDefault ? 1 : 0,
        skipHeaderRows: knobs.skipHeaderRows,
        skipFooterRows: knobs.skipFooterRows,
        dateFormatOverride: knobs.dateFormatOverride,
        defaultCurrency: knobs.defaultCurrency,
        importMode: coerceImportMode(body.importMode),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return NextResponse.json(deserializeTemplate(result), { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create template") }, { status: 500 });
  }
}

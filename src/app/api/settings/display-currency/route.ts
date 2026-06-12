import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { isSupportedCurrency } from "@/lib/fx/supported-currencies";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { recomputeReportingAmounts } from "@/lib/fx/reporting-amount";

const DEFAULT_CURRENCY = "CAD";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, "display_currency"),
        eq(schema.settings.userId, auth.context.userId)
      )
    )
    .limit(1);
  const displayCurrency = row[0]?.value ?? DEFAULT_CURRENCY;
  return NextResponse.json({ displayCurrency });
}

const putSchema = z.object({
  displayCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO 4217 code"),
});

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, putSchema);
  if (parsed.error) return parsed.error;
  const { displayCurrency } = parsed.data;

  if (!isSupportedCurrency(displayCurrency)) {
    return NextResponse.json(
      {
        error: `Currency ${displayCurrency} is not in the supported list. Add a custom rate via Settings → Custom exchange rates first.`,
        code: "currency-unsupported",
      },
      { status: 400 }
    );
  }

  try {
    // Read the prior value so we only recompute reporting amounts on a real
    // change (currency rework Phase 3).
    const prior = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, "display_currency"),
          eq(schema.settings.userId, auth.context.userId)
        )
      )
      .limit(1);
    const changed = (prior[0]?.value ?? DEFAULT_CURRENCY).toUpperCase() !== displayCurrency;

    await db
      .insert(schema.settings)
      .values({
        key: "display_currency",
        userId: auth.context.userId,
        value: displayCurrency,
      })
      .onConflictDoUpdate({
        target: [schema.settings.key, schema.settings.userId],
        set: { value: displayCurrency },
      });

    // Currency rework Phase 3 — re-derive every transaction's stored reporting
    // amount into the new currency at historical rates. Fire-and-forget: the
    // persistent Node server keeps running it; `reporting_recompute_status`
    // tracks progress for the Settings toast; reports stay correct meanwhile
    // via the on-the-fly fallback. Guarded against concurrent runs.
    if (changed) {
      void recomputeReportingAmounts(auth.context.userId, displayCurrency).catch((err) => {

        console.error("[display-currency] reporting recompute failed:", err);
      });
    }

    return NextResponse.json({ displayCurrency, recomputing: changed });
  } catch (error: unknown) {
    await logApiError("PUT", "/api/settings/display-currency", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update display currency") }, { status: 500 });
  }
}

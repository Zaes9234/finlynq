/**
 * Settle FX rates on transactions that were future-dated when entered.
 *
 * When a user records a row dated in the future, getRateAtDate returns
 * today's rate as a best estimate (no Yahoo data exists for tomorrow).
 * Once the date has arrived, the actual rate for that day is now
 * available — this cron re-fetches the rate, updates entered_fx_rate
 * and amount on the row, and logs the change.
 *
 * Eligibility:
 *   - date <= today (the future has caught up)
 *   - date > entered_at::date (it WAS future-dated at entry)
 *   - entered_currency != currency (a real cross-currency conversion)
 *   - settled_fx_at IS NULL OR settled_fx_at < date  (un-settled or stale)
 *
 * The cron is wired in instrumentation.ts on a daily interval. Safe to
 * run repeatedly — the WHERE clauses make it idempotent.
 */

import { db, schema } from "@/db";
import { sql, and, eq, lt, isNotNull } from "drizzle-orm";
import { convertToAccountCurrency } from "@/lib/currency-conversion";
import { todayISO } from "@/lib/utils/date";
import { computeReportingFields } from "@/lib/fx/reporting-amount";
import { getDisplayCurrency } from "@/lib/fx-service";

export type SettleResult = { settled: number; failed: number; errors: string[] };

/**
 * Find and settle future-dated rows whose date has arrived. Best-effort —
 * a failure on one row doesn't stop the rest.
 */
export async function settleFutureFxRates(): Promise<SettleResult> {
  const today = todayISO();

  // Find candidate rows. The (date <= today AND date > entered_at::date)
  // pair narrows to rows whose date has passed but was forward-dated at entry.
  // entered_currency != currency ensures there's a real conversion to settle.
  const candidates = await db
    .select({
      id: schema.transactions.id,
      userId: schema.transactions.userId,
      date: schema.transactions.date,
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      enteredFxRate: schema.transactions.enteredFxRate,
      currency: schema.transactions.currency,
      enteredAt: schema.transactions.enteredAt,
    })
    .from(schema.transactions)
    .where(and(
      isNotNull(schema.transactions.enteredAmount),
      isNotNull(schema.transactions.enteredCurrency),
      sql`${schema.transactions.enteredCurrency} != ${schema.transactions.currency}`,
      lt(schema.transactions.date, sql`(${today}::date + INTERVAL '1 day')::text`),
      sql`${schema.transactions.date}::date > ${schema.transactions.enteredAt}::date`,
    ));

  let settled = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of candidates) {
    if (!row.enteredAmount || !row.enteredCurrency) continue;
    try {
      const conv = await convertToAccountCurrency({
        enteredAmount: row.enteredAmount,
        enteredCurrency: row.enteredCurrency,
        accountCurrency: row.currency,
        date: row.date,
        userId: row.userId,
      });
      // Skip if FX is still a fallback — wait for next sweep when Yahoo
      // (probably) has caught up. Avoids overwriting a good locked rate
      // with a worse fallback.
      if (conv.source === "fallback") continue;
      // Skip if the rate hasn't actually changed materially (avoid churn).
      if (Math.abs(conv.enteredFxRate - (row.enteredFxRate ?? 1)) < 1e-6) continue;
      await db
        .update(schema.transactions)
        .set({
          amount: conv.amount,
          enteredFxRate: conv.enteredFxRate,
          // Issue #28: any DB-side row mutation bumps updated_at, including
          // system-driven settlement. `source` is preserved (INSERT-only),
          // so an originally-imported row stays 'import' even after the cron
          // re-locks its rate.
          updatedAt: sql`NOW()`,
        })
        .where(eq(schema.transactions.id, row.id));
      settled++;
    } catch (err) {
      failed++;
      errors.push(`tx ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { settled, failed, errors };
}

/**
 * Re-rate the STORED reporting_amount (currency rework Phase 3) for rows that
 * were future-dated at entry. At write time a future-dated row's reporting
 * amount is computed against today's spot (no rate exists for a future day);
 * once the date arrives the true historical rate is available. Unlike the
 * self-heal (which only fires on NULL / currency-mismatch rows), a future-dated
 * row already carries a stored value in the right currency, so only this cron
 * catches the rate drift.
 *
 * Candidate set mirrors the entered-settle query (date arrived AND was
 * post-dated at entry) but does NOT require entered_currency != currency — the
 * reporting leg drifts whenever account currency != display currency,
 * regardless of the entered leg. Best-effort + idempotent (skips rows whose
 * rate hasn't materially changed).
 */
export async function settleFutureReportingRates(): Promise<SettleResult> {
  const today = todayISO();

  const candidates = await db
    .select({
      id: schema.transactions.id,
      userId: schema.transactions.userId,
      date: schema.transactions.date,
      currency: schema.transactions.currency,
      amount: schema.transactions.amount,
      reportingCurrency: schema.transactions.reportingCurrency,
      reportingRate: schema.transactions.reportingRate,
    })
    .from(schema.transactions)
    .where(and(
      lt(schema.transactions.date, sql`(${today}::date + INTERVAL '1 day')::text`),
      sql`${schema.transactions.date}::date > ${schema.transactions.enteredAt}::date`,
    ));

  let settled = 0;
  let failed = 0;
  const errors: string[] = [];
  const dispCache = new Map<string, string>();

  for (const row of candidates) {
    try {
      let disp = dispCache.get(row.userId);
      if (!disp) {
        disp = (await getDisplayCurrency(row.userId)).toUpperCase();
        dispCache.set(row.userId, disp);
      }
      const r = await computeReportingFields({
        userId: row.userId,
        accountCurrency: row.currency,
        amount: row.amount ?? 0,
        date: row.date,
        reportingCurrency: disp,
      });
      if (!r) continue; // rate still unresolved — wait for the next sweep
      // Skip if already stored in the right currency at an unchanged rate.
      if (
        row.reportingCurrency === r.reportingCurrency &&
        row.reportingRate != null &&
        Math.abs(r.reportingRate - row.reportingRate) < 1e-9
      ) {
        continue;
      }
      await db
        .update(schema.transactions)
        .set({
          reportingCurrency: r.reportingCurrency,
          reportingRate: r.reportingRate,
          reportingAmount: r.reportingAmount,
          updatedAt: sql`NOW()`,
        })
        .where(eq(schema.transactions.id, row.id));
      settled++;
    } catch (err) {
      failed++;
      errors.push(`tx ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { settled, failed, errors };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the daily settle interval. Safe to call multiple times — second
 * call is a no-op.
 */
export function startSettleFutureFxTimer(): void {
  if (timer) return;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  timer = setInterval(() => {
    settleFutureFxRates().catch((err) => {

      console.error("[settle-future-fx] sweep failed:", err);
    });
    settleFutureReportingRates().catch((err) => {

      console.error("[settle-future-fx] reporting sweep failed:", err);
    });
  }, ONE_DAY);
  if (timer.unref) timer.unref();
}

export function stopSettleFutureFxTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

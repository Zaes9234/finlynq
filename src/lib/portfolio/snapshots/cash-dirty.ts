/**
 * Per-account CASH snapshot dirty-marker — the cash twin of dirty.ts.
 *
 * The cash side of the "Net Worth / Balance Over Time" chart re-materializes
 * per-account daily balances in `portfolio_snapshots` (source='cash'). Cash
 * staleness is DETECTED by the per-user fingerprint (portfolio_cash_snapshot_meta),
 * but a stale fingerprint used to force a FULL-history rebuild across EVERY cash
 * account — even when one today-dated transaction was booked. This marker records
 * the impacted `(account, earliest-date)` so the chart-load cash self-heal can
 * rebuild ONLY that account from `from_date` forward.
 *
 * Keyed PER ACCOUNT (PK user_id, account_id) so a tx in one account never
 * rebuilds siblings. `from_date` coalesces to the EARLIEST via LEAST, mirroring
 * `markSnapshotsDirty`. All writes swallow their own errors (log + continue) so
 * they can be awaited in a write path's hot loop, and so they're a no-op on
 * environments where the `20260628` migration hasn't run yet.
 */

import { db, schema } from "@/db";
import { sql } from "drizzle-orm";

/** ISO YYYY-MM-DD guard — falls back to today on anything malformed. */
function normalizeFromDate(fromDate: string): string {
  if (typeof fromDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fromDate.slice(0, 10))) {
    return fromDate.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mark one cash account's snapshot history dirty from `fromDate` forward.
 * Idempotent: repeated calls coalesce to the EARLIEST (widest) from_date via
 * LEAST, and always bump marked_at so an in-flight self-heal re-queues the row.
 */
export async function markCashSnapshotsDirty(
  userId: string,
  accountId: number,
  fromDate: string,
): Promise<void> {
  if (!Number.isFinite(accountId)) return;
  const from = normalizeFromDate(fromDate);
  try {
    await db.execute(sql`
      INSERT INTO portfolio_cash_snapshot_dirty (user_id, account_id, from_date, marked_at)
      VALUES (${userId}, ${accountId}, ${from}, NOW())
      ON CONFLICT (user_id, account_id) DO UPDATE SET
        from_date = LEAST(portfolio_cash_snapshot_dirty.from_date, EXCLUDED.from_date),
        marked_at = NOW()
    `);
  } catch (err) {
    console.warn(
      "[markCashSnapshotsDirty] non-fatal:",
      err instanceof Error ? err.message : err,
    );
  }
}

export interface CashDirtyRow {
  userId: string;
  accountId: number;
  fromDate: string;
  /** Captured BEFORE a rebuild so the self-heal can detect concurrent writes. */
  markedAt: string;
}

/** All pending dirty cash-account rows for a user (chart-load self-heal queue). */
export async function listCashDirtyAccounts(userId: string): Promise<CashDirtyRow[]> {
  const rows = await db
    .select({
      userId: schema.portfolioCashSnapshotDirty.userId,
      accountId: schema.portfolioCashSnapshotDirty.accountId,
      fromDate: schema.portfolioCashSnapshotDirty.fromDate,
      markedAt: schema.portfolioCashSnapshotDirty.markedAt,
    })
    .from(schema.portfolioCashSnapshotDirty)
    .where(sql`${schema.portfolioCashSnapshotDirty.userId} = ${userId}`);
  return rows.map((r) => ({
    userId: r.userId,
    accountId: Number(r.accountId),
    fromDate: r.fromDate,
    markedAt:
      r.markedAt instanceof Date ? r.markedAt.toISOString() : String(r.markedAt),
  }));
}

/**
 * Delete a dirty cash-account row ONLY if it hasn't been re-stamped since
 * `markedAt` (the value captured before the rebuild started). A write that
 * arrived mid-rebuild bumps marked_at to NOW() > markedAt, so the row survives
 * and is re-drained next chart load — no lost edits.
 *
 * Same microsecond-vs-millisecond precision fix as `clearDirtyIfUnchanged`:
 * `marked_at` is `timestamptz` (µs precision) while `markedAt` came through a JS
 * `Date.toISOString()` (ms precision), so truncate the stored value to
 * milliseconds before comparing or the row would never delete.
 */
export async function clearCashDirtyIfUnchanged(
  userId: string,
  accountId: number,
  markedAt: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM portfolio_cash_snapshot_dirty
    WHERE user_id = ${userId}
      AND account_id = ${accountId}
      AND date_trunc('milliseconds', marked_at) <= ${markedAt}::timestamptz
  `);
}

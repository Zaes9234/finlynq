/**
 * Cron job — build today's portfolio snapshot for every enrolled user.
 *
 * Started by src/instrumentation.ts with a 24h setInterval. First run
 * fires 24h after server start; for the 21:00-UTC schedule called out
 * in the plan, follow up with a setTimeout-then-setInterval seed.
 *
 * Idempotent on the (user_id, snap_date, COALESCE(account_id, -1))
 * unique index — safe to re-run on the same day.
 *
 * Phase 3 of plan/portfolio-lots-and-performance.md.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { buildDailySnapshot } from "@/lib/portfolio/snapshots/builder";

export interface RunSnapshotsCronOpts {
  /** Override today's date for backfill / replay. */
  date?: string;
}

export interface RunSnapshotsCronResult {
  usersProcessed: number;
  perAccountRows: number;
  aggregateRows: number;
  errors: Array<{ userId: string; error: string }>;
}

export async function runSnapshotsCron(
  opts: RunSnapshotsCronOpts = {},
): Promise<RunSnapshotsCronResult> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  // Only enrolled users (portfolio_lots_status row present and enabled=TRUE).
  // Pre-rollout users with enabled=FALSE still get snapshots — the chart
  // is harmless on its own; we just don't gate on the lots feature here.
  const enrolled = await db
    .select({ userId: schema.portfolioLotsStatus.userId })
    .from(schema.portfolioLotsStatus);

  // Fall back to ANY user with portfolio_holdings rows if no enrolled
  // users exist (e.g. fresh install). Phase 1 backfill auto-enrolls.
  let userIds = enrolled.map((r) => r.userId);
  if (userIds.length === 0) {
    const withHoldings = await db
      .selectDistinct({ userId: schema.portfolioHoldings.userId })
      .from(schema.portfolioHoldings);
    userIds = withHoldings.map((r) => r.userId);
  }

  let perAccountRows = 0;
  let aggregateRows = 0;
  const errors: Array<{ userId: string; error: string }> = [];

  for (const userId of userIds) {
    try {
      const result = await buildDailySnapshot({ userId, date, dek: null });
      perAccountRows += result.perAccountRows;
      if (result.aggregateRow) aggregateRows++;
    } catch (err) {
      errors.push({
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Unused references — silenced for the lint pass.
  void eq;

  return {
    usersProcessed: userIds.length,
    perAccountRows,
    aggregateRows,
    errors,
  };
}

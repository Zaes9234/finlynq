/**
 * Snapshot-drain cron — auto-rebuild stale portfolio snapshots.
 *
 * Reads every `portfolio_snapshot_dirty` row, re-materializes
 * `[from_date, today]` for that user (rebuildPortfolioSnapshots, dek=null —
 * market value needs no names), then clears the row IF it hasn't been
 * re-stamped since before the rebuild started. A write arriving mid-rebuild
 * bumps marked_at to NOW() > the captured value, so its row survives and is
 * re-drained on the next tick — no lost edits.
 *
 * Registered in src/instrumentation.ts with a ~5-minute setInterval (+
 * timer.unref()), same pattern as the nightly snapshot cron.
 *
 * plan/net-worth-over-time.md Part B.
 */

import {
  listDirtySnapshotUsers,
  clearDirtyIfUnchanged,
} from "@/lib/portfolio/snapshots/dirty";
import { rebuildPortfolioSnapshots } from "@/lib/portfolio/snapshots/rebuild";

export interface RunSnapshotDrainResult {
  usersProcessed: number;
  daysProcessed: number;
  errors: Array<{ userId: string; error: string }>;
}

export async function runSnapshotDrainCron(): Promise<RunSnapshotDrainResult> {
  const dirty = await listDirtySnapshotUsers();

  let usersProcessed = 0;
  let daysProcessed = 0;
  const errors: Array<{ userId: string; error: string }> = [];

  for (const row of dirty) {
    try {
      const summary = await rebuildPortfolioSnapshots(
        row.userId,
        row.fromDate,
        null,
        null,
      );
      daysProcessed += summary.daysProcessed;
      // Clear only if no new write re-stamped the row during the rebuild.
      await clearDirtyIfUnchanged(row.userId, row.markedAt);
      usersProcessed++;
    } catch (err) {
      errors.push({
        userId: row.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { usersProcessed, daysProcessed, errors };
}

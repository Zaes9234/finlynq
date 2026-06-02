/**
 * Admin script — backfill historical portfolio snapshots for one user.
 *
 * Usage:
 *   cd pf-app && DATABASE_URL="postgresql://..." npx tsx scripts/backfill-portfolio-snapshots.ts <userId> [<fromDate>]
 *
 * Walks from the user's first transaction date (or <fromDate> if
 * provided) to today, building one snapshot per day. Uses the same
 * buildDailySnapshot helper as the nightly cron, so output shape is
 * identical.
 *
 * Idempotent — re-runs UPSERT via the unique index. `gaps_filled=true`
 * tracks days where price_cache or fx_rates fell back; the UI surfaces
 * that on the performance chart so users can interpret accordingly.
 *
 * Phase 3 of plan/portfolio-lots-and-performance.md.
 */

import { PostgresAdapter } from "../src/db/adapters/postgres";
import { setAdapter, setDialect } from "../src/db";
import { rebuildPortfolioSnapshots } from "../src/lib/portfolio/snapshots/rebuild";

async function main(): Promise<number> {
  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: npx tsx scripts/backfill-portfolio-snapshots.ts <userId> [<fromDate>]");
    return 1;
  }
  const fromArg = process.argv[3] ?? null;

  const databaseUrl = process.env.DATABASE_URL || process.env.PF_DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL (or PF_DATABASE_URL) must be set");
    return 1;
  }

  setDialect("postgres");
  const adapter = new PostgresAdapter();
  await adapter.initialize({
    dialect: "postgres",
    postgres: { connectionString: databaseUrl, userId },
  });
  setAdapter(adapter);

  try {
    // Shared walk loop (also used by the manual rebuild endpoint + the
    // auto-rebuild drain cron) — discovers fromDate = MIN(tx.date) when null.
    console.log(`Backfilling daily snapshots for user ${userId}`);
    const summary = await rebuildPortfolioSnapshots(userId, fromArg, null, null);
    console.log(`  Range: ${summary.fromDate} → ${summary.toDate}`);
    console.log("");
    console.log("Summary");
    console.log("───────");
    console.log(`  Days processed:        ${summary.daysProcessed}`);
    console.log(`  Days with gap-fills:   ${summary.gapsFilledDays}`);
    console.log("");
    console.log("Next step — visit /portfolio and click the Performance chart's All button.");
    return 0;
  } catch (err) {
    console.error("FATAL:", err);
    return 1;
  } finally {
    await adapter.close();
  }
}

main().then((code) => process.exit(code));

/**
 * Next.js instrumentation — runs once when the server starts.
 *
 * Initializes the correct database adapter based on DATABASE_URL:
 * - If DATABASE_URL is set → PostgreSQL (managed mode)
 * - Otherwise → SQLite (self-hosted, initialized lazily via unlock)
 */

export async function register() {
  // Only run on the server
  if (typeof window !== "undefined") return;

  const databaseUrl = process.env.PF_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) return; // SQLite mode — initialized on unlock

  const { PostgresAdapter } = await import("@/db/adapters/postgres");
  const { setAdapter, setDialect } = await import("@/db");

  const adapter = new PostgresAdapter();
  await adapter.initialize({
    dialect: "postgres",
    postgres: {
      connectionString: databaseUrl,
      userId: "", // Multi-tenant user scoping handled at query level
    },
  });

  setAdapter(adapter);
  setDialect("postgres");

  console.log("[instrumentation] PostgreSQL adapter initialized (managed mode)");

  // ─── Cron registration ──────────────────────────────────────────────────
  // Phase 3 of plan/portfolio-lots-and-performance.md — nightly snapshot
  // builder. Uses setInterval with a 24h period; first run fires 24h
  // after server start. For the proper 21:00-UTC schedule, a follow-up
  // can compute the delay to next 21:00 UTC and seed with setTimeout.
  //
  // Note: the older crons (settle-future-fx, sweep-mcp-idempotency,
  // sweep-revoked-jtis) export startSettleFutureFxTimer() etc. but
  // aren't currently invoked from anywhere — a pre-existing latent
  // issue separate from this phase. Fixing them is out of scope here.
  try {
    const { runSnapshotsCron } = await import(
      "./lib/cron/portfolio-snapshots"
    );
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const timer: NodeJS.Timeout = setInterval(() => {
      runSnapshotsCron().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[portfolio-snapshots-cron] run failed:", err);
      });
    }, ONE_DAY);
    if (timer.unref) timer.unref();
    console.log("[instrumentation] portfolio-snapshots cron registered (24h interval)");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[instrumentation] failed to register portfolio-snapshots cron:", err);
  }

  // ─── Snapshot-drain cron ───────────────────────────────────────────────
  // Auto-rebuild stale snapshots after back-dated investment edits. Reads the
  // portfolio_snapshot_dirty work-queue (stamped by markSnapshotsDirty on
  // every investment write) every ~5 minutes and re-materializes each user's
  // dirty range. plan/net-worth-over-time.md Part B.
  try {
    const { runSnapshotDrainCron } = await import("./lib/cron/snapshot-drain");
    const FIVE_MIN = 5 * 60 * 1000;
    const drainTimer: NodeJS.Timeout = setInterval(() => {
      runSnapshotDrainCron().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[snapshot-drain-cron] run failed:", err);
      });
    }, FIVE_MIN);
    if (drainTimer.unref) drainTimer.unref();
    console.log("[instrumentation] snapshot-drain cron registered (5m interval)");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[instrumentation] failed to register snapshot-drain cron:", err);
  }
}

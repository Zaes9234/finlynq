/**
 * POST /api/portfolio/snapshots/rebuild
 *
 * Synchronously re-materializes the user's daily `portfolio_snapshots` from
 * `fromDate` (default: their earliest transaction) to today. Backs the
 * "Rebuild investment history" button (Settings → Investments + the net-worth
 * chart empty-state). Idempotent on the snapshot unique index.
 *
 * Uses requireAuth + getDEK (NOT requireEncryption) — market value needs no
 * decrypted names, so a cold DEK still rebuilds (matches the dashboard's
 * nullable-DEK posture).
 *
 * Guards against an overlapping per-user run (409) so a double-click doesn't
 * spawn two long walks. plan/net-worth-over-time.md Part B.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { logApiError } from "@/lib/validate";
import { rebuildPortfolioSnapshots } from "@/lib/portfolio/snapshots/rebuild";
import { clearDirtyIfUnchanged, listDirtySnapshotUsers } from "@/lib/portfolio/snapshots/dirty";

// HMR-safe in-flight guard (same pattern as the tx cache + DB adapter).
const g = globalThis as typeof globalThis & { __pfRebuildInFlight?: Set<string> };
function inFlight(): Set<string> {
  if (!g.__pfRebuildInFlight) g.__pfRebuildInFlight = new Set();
  return g.__pfRebuildInFlight;
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const running = inFlight();
  if (running.has(userId)) {
    return NextResponse.json(
      { error: "A rebuild is already running for your account. Please wait.", code: "rebuild_in_progress" },
      { status: 409 },
    );
  }

  try {
    let fromDate: string | undefined;
    try {
      const body = await request.json();
      if (body && typeof body.fromDate === "string") fromDate = body.fromDate;
    } catch {
      /* empty body is fine */
    }

    running.add(userId);
    const summary = await rebuildPortfolioSnapshots(userId, fromDate ?? null, null, dek);

    // The manual rebuild covers whatever the auto-drain would have — clear any
    // pending dirty row that hasn't been re-stamped since before this run.
    try {
      const dirty = await listDirtySnapshotUsers();
      const mine = dirty.find((d) => d.userId === userId);
      if (mine) await clearDirtyIfUnchanged(userId, mine.markedAt);
    } catch {
      /* dirty-row cleanup is best-effort */
    }

    return NextResponse.json(summary);
  } catch (error: unknown) {
    await logApiError("POST", "/api/portfolio/snapshots/rebuild", error, userId);
    const message = error instanceof Error ? error.message : "Rebuild failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    running.delete(userId);
  }
}

/**
 * POST /api/import/staged/[id]/apply-rules
 *
 * FINLYNQ-88 phase 3 — manual "Re-apply rules" button on `/import/pending`.
 * Walks every active rule over every row in the batch via
 * `applyRulesToStagedBatch` so the user can refresh rule effects after
 * editing rules in `/settings/rules` or after creating one through the
 * inline-banner surface.
 *
 * Body: none. Operates over the entire batch (no `rowIds` filter — intentional;
 * this is the "refresh" button, not a per-row action). The confirmation modal
 * on the UI is the safety net for "this may overwrite manual edits".
 *
 * Response: `{ success: true, data: { rowsTouched: number, matches: Array<{rowId, ruleId}> } }`
 *
 * Auth: `requireEncryption` — 423 if no DEK. Staged-batch rule application
 * needs a DEK for tier-preserving re-encryption (CLAUDE.md "Staged-
 * transactions reads MUST branch on encryption_tier per row").
 *
 * Load-bearing rules (CLAUDE.md + the helper's file header):
 *   - import_hash NEVER recomputed (helper enforces).
 *   - encryption_tier NEVER flipped (helper enforces).
 *   - reconcile_state IN ('linked', 'skipped_duplicate') rows SKIPPED entirely
 *     (helper enforces).
 *   - link_id / trade_link_id are approve-time-only — helper sets tx_type='R'
 *     + target_account_id only; createTransferPair mints the UUID later.
 *   - Cross-tenant FK guards inside the helper.
 *
 * HTTP only — stdio MCP has no DEK on the staging tier (CLAUDE.md gotcha).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { applyRulesToStagedBatch } from "@/lib/rules/apply-to-staged-batch";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  // Verify ownership + pending status. Mirrors the inline create-rule
  // endpoint's ownership probe — same 404 / 409 shape.
  const staged = await db
    .select({ id: schema.stagedImports.id, status: schema.stagedImports.status })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (staged.status !== "pending") {
    return NextResponse.json(
      { error: "Staged import is not pending — edits are no longer accepted" },
      { status: 409 },
    );
  }

  try {
    const result = await applyRulesToStagedBatch(db, userId, dek, id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {

    console.error("[apply-rules] applyRulesToStagedBatch threw", {
      userId,
      stagedImportId: id,
      err: err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Rule application failed",
      },
      { status: 500 },
    );
  }
}

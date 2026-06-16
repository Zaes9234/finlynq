/**
 * POST /api/transactions/lot-replan-preview — FINLYNQ-176
 *
 * Dry-run preview for the warn-and-reallocate flow. When the user attempts
 * to edit/delete a buy/transfer-in whose opened lot has been consumed by a
 * sell/transfer-out closure, the transactions route returns a 409
 * `portfolio_edit_blocked` (unchanged default). The client then POSTs here
 * to fetch what WOULD happen if it proceeds: the proposed reallocated
 * closures, any short lots that would open, and the realized-gain delta
 * bucketed by calendar year — so the confirm dialog can warn the user.
 *
 * Writes NOTHING (the orchestrator's dryRun path). Re-running it is safe.
 *
 * Request body:  { op: "edit" | "delete", id: number }
 * 200: { preview: LotReallocationPreview }
 *   - When canEditPortfolioRow(id).allowed === true (no dependents), the
 *     preview is empty (no reallocation needed) — the client can proceed
 *     with a plain edit/delete.
 *
 * Auth: requireEncryption — the dry-run resolves the Dividends category for
 * the lot context (DEK-bearing).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { canEditPortfolioRow } from "@/lib/portfolio/operations";
import { replanLotsAfterMutation } from "@/lib/portfolio/lots/write-hooks";
import type { LotReallocationPreview } from "@/lib/portfolio/lots/types";

const bodySchema = z.object({
  op: z.enum(["edit", "delete"]),
  id: z.number().int().positive(),
});

const EMPTY_PREVIEW: LotReallocationPreview = {
  affectedHoldingIds: [],
  dependentCloseTxIds: [],
  proposedClosures: [],
  openedShortLots: [],
  realizedGainDeltaByYear: {},
};

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, bodySchema);
    if (parsed.error) return parsed.error;
    const { op, id } = parsed.data;

    const guard = await canEditPortfolioRow(auth.userId, id);
    if (guard.allowed) {
      // No dependent closures — nothing to reallocate.
      return NextResponse.json({ preview: EMPTY_PREVIEW });
    }

    const preview = await replanLotsAfterMutation(
      auth.userId,
      {
        op,
        targetTxId: id,
        dependentCloseTxIds: guard.blockingClosureTxIds ?? [],
      },
      { dryRun: true, dek: auth.dek },
    );
    return NextResponse.json({ preview });
  } catch (error) {
    await logApiError("POST", "/api/transactions/lot-replan-preview", error, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to compute reallocation preview") },
      { status: 500 },
    );
  }
}

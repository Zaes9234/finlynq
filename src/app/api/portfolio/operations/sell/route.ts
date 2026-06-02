import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { recordSell } from "@/lib/portfolio/operations";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { mapOperationError, cascadeDeleteForReplace } from "../_helpers";

const schema = z.object({
  accountId: z.number().int().positive(),
  holdingId: z.number().int().positive(),
  qty: z.number().positive(),
  totalProceeds: z.number().positive(),
  date: z.string(),
  payee: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  cashSleeveHoldingId: z.number().int().positive().optional(),
  lotSelection: z
    .object({
      // Mirrors LotSelectionStrategy in src/lib/portfolio/lots/types.ts —
      // HIFO (Highest-in-first-out), NOT LIFO. FIFO is the default when
      // omitted; SPECIFIC requires lotIds (legacy) OR lots (Phase 3 per-lot qty).
      method: z.enum(["FIFO", "HIFO", "SPECIFIC"]),
      lotIds: z.array(z.number().int().positive()).optional(),
      lots: z
        .array(
          z.object({
            lotId: z.number().int().positive(),
            qty: z.number().positive(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Phase 2 edit-as-replace (2026-05-25 follow-up). When set, cascade-deletes
  // the existing pair (via trade_link_id) before creating the new one.
  editId: z.number().int().positive().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, schema);
    if (parsed.error) return parsed.error;
    const { editId, ...input } = parsed.data;
    if (editId != null) {
      const refusal = await cascadeDeleteForReplace(auth.userId, editId);
      if (refusal) return refusal;
    }
    const result = await recordSell({
      ...input,
      userId: auth.userId,
      dek: auth.dek,
      source: "manual",
    });
    invalidateUserTxCache(auth.userId);
    // Snapshot history is stale from this trade date forward — auto-rebuild.
    await markSnapshotsDirty(auth.userId, input.date);
    return NextResponse.json(
      editId != null ? { ...result, replaced: editId } : result,
      { status: 201 },
    );
  } catch (err: unknown) {
    const mapped = mapOperationError(err);
    if (mapped) return mapped;
    await logApiError("POST", "/api/portfolio/operations/sell", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to record sell") },
      { status: 500 },
    );
  }
}

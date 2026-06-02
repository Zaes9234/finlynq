import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { recordPortfolioIncomeOrExpense } from "@/lib/portfolio/operations";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { mapOperationError, cascadeDeleteForReplace } from "../_helpers";

const schema = z.object({
  accountId: z.number().int().positive(),
  currency: z.string().min(2).max(8),
  amount: z.number().refine((v) => v !== 0, { message: "amount cannot be 0" }),
  relatedHoldingId: z.number().int().positive().nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  date: z.string(),
  payee: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
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
    const result = await recordPortfolioIncomeOrExpense({
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
    await logApiError("POST", "/api/portfolio/operations/income-expense", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to record portfolio income/expense") },
      { status: 500 },
    );
  }
}

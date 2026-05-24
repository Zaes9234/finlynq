import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { recordBrokerageDeposit } from "@/lib/portfolio/operations";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { mapOperationError, cascadeDeleteForReplace } from "../_helpers";

const schema = z.object({
  sourceAccountId: z.number().int().positive(),
  destAccountId: z.number().int().positive(),
  destCashSleeveHoldingId: z.number().int().positive().optional(),
  amount: z.number().positive(),
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
    const result = await recordBrokerageDeposit({
      ...input,
      userId: auth.userId,
      dek: auth.dek,
      source: "manual",
    });
    invalidateUserTxCache(auth.userId);
    return NextResponse.json(
      editId != null ? { ...result, replaced: editId } : result,
      { status: 201 },
    );
  } catch (err: unknown) {
    const mapped = mapOperationError(err);
    if (mapped) return mapped;
    await logApiError("POST", "/api/portfolio/operations/deposit", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to record brokerage deposit") },
      { status: 500 },
    );
  }
}

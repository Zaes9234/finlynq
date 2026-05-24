/**
 * Realized-gain endpoint — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * GET /api/portfolio/realized-gains?from=&to=&taxYear=&holdingId=&accountId=&term=&format=csv
 *
 * Returns the same shape as the MCP HTTP `get_realized_gains` tool. CSV
 * stream when `format=csv`. Cross-tenant filters enforced via the
 * session DEK (decryptName returns null on mismatch — never leaks
 * another user's data) plus `userId` predicate in the helper.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import {
  augmentWithBaseCurrency,
  listRealizedGainClosures,
  realizedGainsToCsv,
  type RealizedGainsFilter,
} from "@/lib/portfolio/realized-gains";
import { getBaseCurrency } from "@/lib/fx-service";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const filter: RealizedGainsFilter = {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    taxYear: params.get("taxYear")
      ? parseInt(params.get("taxYear")!, 10)
      : undefined,
    holdingId: params.get("holdingId")
      ? parseInt(params.get("holdingId")!, 10)
      : undefined,
    accountId: params.get("accountId")
      ? parseInt(params.get("accountId")!, 10)
      : undefined,
    term: (params.get("term") as RealizedGainsFilter["term"]) ?? "all",
  };

  const result = await listRealizedGainClosures(userId, dek, filter);

  // Phase 5 — base-currency augmentation when ?currency=base is set.
  const useBase = params.get("currency") === "base";
  let augmented:
    | (typeof result & { totalRealizedGainInBase: number })
    | null = null;
  if (useBase) {
    const baseCurrency = await getBaseCurrency(
      userId,
      params.get("baseCurrency"),
    );
    augmented = await augmentWithBaseCurrency(result, userId, baseCurrency);
  }

  if (params.get("format") === "csv") {
    const csv = realizedGainsToCsv(result);
    const filenameParts: string[] = ["realized-gains"];
    if (filter.taxYear) filenameParts.push(String(filter.taxYear));
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filenameParts.join("-")}.csv"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    data: augmented ?? result,
  });
}

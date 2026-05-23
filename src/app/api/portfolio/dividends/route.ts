/**
 * Dividend-income endpoint — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * GET /api/portfolio/dividends?from=&to=&taxYear=&holdingId=&accountId=&groupBy=&format=csv
 *
 * `groupBy ∈ {quarter, year, holding}` returns aggregated rows;
 * omit `groupBy` to get raw transaction rows. CSV stream when
 * `format=csv`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import {
  listDividendIncome,
  dividendsToCsv,
  type DividendIncomeFilter,
} from "@/lib/portfolio/dividends";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const groupByRaw = params.get("groupBy");
  const filter: DividendIncomeFilter = {
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
    groupBy:
      groupByRaw === "quarter" || groupByRaw === "year" || groupByRaw === "holding"
        ? groupByRaw
        : undefined,
  };

  const result = await listDividendIncome(userId, dek, filter);

  if (params.get("format") === "csv") {
    const csv = dividendsToCsv(result);
    const filenameParts: string[] = ["dividends"];
    if (filter.taxYear) filenameParts.push(String(filter.taxYear));
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filenameParts.join("-")}.csv"`,
      },
    });
  }

  return NextResponse.json({ success: true, data: result });
}

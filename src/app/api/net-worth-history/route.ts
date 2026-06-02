/**
 * GET /api/net-worth-history?period=6m|1y|all&accountId=<optional int>
 *
 * Accurate "Net Worth Over Time" (and per-account "Balance Over Time") daily
 * series. Cash/liability accounts are computed live from `transactions`;
 * investment accounts read the stored daily `portfolio_snapshots`, with TODAY
 * substituted by the live holdings aggregator so the latest point matches the
 * dashboard hero net-worth number exactly.
 *
 * Mirrors the head of /api/dashboard (requireAuth → getDEK → getDisplayCurrency
 * → getRateMap). The heavy lifting is the pure `buildNetWorthHistory` core.
 *
 * plan/net-worth-over-time.md Part A.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import {
  getRateMap,
  getDisplayCurrency,
} from "@/lib/fx-service";
import { getAccountBalances, getCashDailyDeltas, getInvestmentSnapshotsInRange } from "@/lib/queries";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { logApiError } from "@/lib/validate";
import {
  buildNetWorthHistory,
  type NetWorthPeriod,
  type LiveInvestmentValue,
} from "@/lib/net-worth-history";

function parsePeriod(raw: string | null): NetWorthPeriod {
  return raw === "6m" || raw === "1y" || raw === "all" ? raw : "6m";
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const period = parsePeriod(params.get("period"));
  const accountId = params.get("accountId")
    ? parseInt(params.get("accountId")!, 10)
    : null;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const displayCurrency = await getDisplayCurrency(userId, params.get("currency"));
    const rateMap = await getRateMap(displayCurrency, userId);

    // Cash side (live from transactions) + investment side (stored snapshots).
    const cashDeltas = await getCashDailyDeltas(userId, accountId ?? undefined);
    const snapshotRows = await getInvestmentSnapshotsInRange(
      userId,
      "1900-01-01",
      today,
      accountId ?? undefined,
    );

    // Today's live override. Restrict to the SAME non-archived investment
    // account set the dashboard hero sums over, so the latest point matches.
    const balances = await getAccountBalances(userId);
    const investmentAccountIds = new Set(
      balances.filter((b) => Boolean(b.isInvestment)).map((b) => b.accountId),
    );
    const holdingsByAccount = await getHoldingsValueByAccount(userId, dek);
    const liveInvestmentByAccount = new Map<number, LiveInvestmentValue>();
    for (const [accId, v] of holdingsByAccount) {
      if (!investmentAccountIds.has(accId)) continue;
      if (accountId != null && accId !== accountId) continue;
      liveInvestmentByAccount.set(accId, { value: v.value, currency: v.currency });
    }

    const snapshots = snapshotRows.map((r) => ({
      accountId: r.accountId as number,
      snapDate: r.snapDate,
      marketValue: Number(r.marketValue),
      currency: r.currency,
    }));

    const { series, hasInvestmentData, fxApproximation } = buildNetWorthHistory({
      period,
      displayCurrency,
      rateMap,
      cashDeltas: cashDeltas.map((d) => ({
        date: d.date,
        currency: d.currency,
        delta: Number(d.delta),
      })),
      snapshots,
      liveInvestmentByAccount,
      today,
    });

    return NextResponse.json({
      displayCurrency,
      period,
      accountId,
      series,
      hasInvestmentData,
      fxApproximation,
    });
  } catch (error: unknown) {
    await logApiError("GET", "/api/net-worth-history", error, userId);
    const message =
      error instanceof Error ? error.message : "Failed to load net worth history";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

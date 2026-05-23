/**
 * Portfolio-performance endpoint — Phase 3 of plan/portfolio-lots-and-performance.md.
 *
 * GET /api/portfolio/performance?period=1m|3m|6m|ytd|1y|all&accountId=…
 *
 * Returns: daily value series + TWRR + MWRR for the period. Reads
 * `portfolio_snapshots` (built nightly by the cron) for the time
 * series; reads `transactions` for the MWRR cash flows.
 *
 * The chart on /portfolio consumes this. Stdio MCP cannot read names
 * but CAN read snapshot numbers; the new MCP tool
 * `get_portfolio_performance_v2` wraps this same logic.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { computeTwrr, annualizeReturn } from "@/lib/portfolio/performance/twrr";
import { computeMwrr } from "@/lib/portfolio/performance/mwrr";
import { computeNetContributions } from "@/lib/portfolio/performance/contributions";

const PERIOD_DAYS: Record<string, number | null> = {
  "1m": 30,
  "3m": 90,
  "6m": 180,
  ytd: -1, // sentinel: from Jan 1 of asOfDate's year
  "1y": 365,
  all: null,
};

function rangeStart(period: string, asOfDate: string): string {
  if (period === "ytd") return `${asOfDate.slice(0, 4)}-01-01`;
  const days = PERIOD_DAYS[period];
  if (days == null) return "1900-01-01";
  const d = new Date(`${asOfDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const params = request.nextUrl.searchParams;
  const period = params.get("period") ?? "1y";
  const accountId = params.get("accountId")
    ? parseInt(params.get("accountId")!, 10)
    : null;

  const asOfDate = new Date().toISOString().slice(0, 10);
  const from = rangeStart(period, asOfDate);

  const preds = [
    eq(schema.portfolioSnapshots.userId, userId),
    gte(schema.portfolioSnapshots.snapDate, from),
    lte(schema.portfolioSnapshots.snapDate, asOfDate),
  ];
  if (accountId != null) {
    preds.push(eq(schema.portfolioSnapshots.accountId, accountId));
  } else {
    // Aggregate-row only (account_id IS NULL).
    preds.push(isNull(schema.portfolioSnapshots.accountId));
  }

  const rows = await db
    .select({
      date: schema.portfolioSnapshots.snapDate,
      marketValue: schema.portfolioSnapshots.marketValue,
      costBasis: schema.portfolioSnapshots.costBasis,
      netContribution: schema.portfolioSnapshots.netContribution,
      currency: schema.portfolioSnapshots.currency,
      gapsFilled: schema.portfolioSnapshots.gapsFilled,
    })
    .from(schema.portfolioSnapshots)
    .where(and(...preds))
    .orderBy(schema.portfolioSnapshots.snapDate);

  // Suppress unused-import warning — sql may be referenced by callers
  // expanding this file with raw SQL.
  void sql;

  const series = rows.map((r) => ({
    date: r.date,
    marketValue: Number(r.marketValue),
    costBasis: Number(r.costBasis),
    contribution: Number(r.netContribution),
    gapsFilled: r.gapsFilled,
  }));

  // ─── TWRR ───
  const twrr = computeTwrr(
    series.map((p) => ({
      date: p.date,
      marketValue: p.marketValue,
      contribution: p.contribution,
    })),
  );

  // ─── MWRR / XIRR ───
  let mwrr: { irr: number; converged: boolean } = { irr: 0, converged: false };
  if (series.length > 0) {
    const flows = await computeNetContributions({
      userId,
      accountId,
      fromDate: from,
      toDate: asOfDate,
    });
    // Initial value at the start of the period is treated as a contribution.
    const startMv = series[0]?.marketValue ?? 0;
    if (startMv > 0) {
      flows.unshift({ date: from, amount: -startMv });
    }
    const finalMv = series[series.length - 1]?.marketValue ?? 0;
    const result = computeMwrr(flows, finalMv, asOfDate);
    mwrr = { irr: result.irr, converged: result.converged };
  }

  const periodDays =
    series.length >= 2
      ? Math.max(
          1,
          Math.round(
            (Date.parse(series[series.length - 1].date) -
              Date.parse(series[0].date)) /
              86400000,
          ),
        )
      : 0;
  const twrrAnnualized = annualizeReturn(twrr.periodReturn, periodDays);

  return NextResponse.json({
    success: true,
    data: {
      period,
      accountId,
      from,
      to: asOfDate,
      currency: rows[0]?.currency ?? "USD",
      series,
      twrr: {
        period: twrr.periodReturn,
        annualized: twrrAnnualized,
        hadContributions: twrr.hadContributions,
      },
      mwrr,
      gapsFilledDays: series.filter((p) => p.gapsFilled).length,
    },
  });
}

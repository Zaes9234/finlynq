/**
 * Realized-gain query — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Reads `holding_lot_closures` (written by the Phase 1 lot engine),
 * JOINs `portfolio_holdings` (decrypted name via DEK) + `accounts`
 * (decrypted name via DEK) + `holding_lots` (origin info for audit
 * filtering). Returns closure rows in a UI-shaped format suitable for
 * the /portfolio/realized-gains dashboard and the
 * `get_realized_gains` MCP HTTP tool.
 *
 * Filters:
 *   from / to       — close_date range, inclusive
 *   taxYear         — convenience for `from=YYYY-01-01, to=YYYY-12-31`
 *   holdingId       — single holding scope
 *   accountId       — single account scope
 *   term            — 'short' (days_held ≤ 365) / 'long' (> 365) / 'all'
 *
 * Does NOT compute lot-derived realized gain on the fly — relies on
 * `realized_gain` snapshot stored at close time. Phase 1 invariants
 * guarantee that number is post-issue-#96 substitution + post-#128
 * paired-cash-leg skip.
 *
 * NOT gated on `portfolio_lots_status.enabled` — Phase 2 only shows
 * data when there are closure rows to show. Pre-backfill users see an
 * empty list, which is the correct affordance.
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptName } from "@/lib/crypto/encrypted-columns";

export interface RealizedGainsFilter {
  from?: string;       // YYYY-MM-DD
  to?: string;         // YYYY-MM-DD
  taxYear?: number;
  holdingId?: number;
  accountId?: number;
  term?: "short" | "long" | "all";
}

export interface RealizedGainRow {
  closureId: number;
  closeDate: string;
  closeTxId: number;
  lotId: number;
  holdingId: number;
  holdingName: string | null;   // decrypted (HTTP) or null (stdio + no DEK)
  accountId: number;
  accountName: string | null;   // decrypted (HTTP) or null
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  realizedGain: number;
  currency: string;
  openDate: string;
  daysHeld: number;
  term: "short" | "long";
  closeKind: "sell" | "transfer_out";
  source: string;
}

export interface RealizedGainsResult {
  rows: RealizedGainRow[];
  totals: {
    realizedGain: number;       // sum of realized_gain across the matched rows, in mixed currencies
    qtyClosed: number;
    rowCount: number;
    /** Per-currency totals — for cross-currency portfolios; FX-convert downstream as needed. */
    byCurrency: Record<string, { realizedGain: number; qtyClosed: number }>;
  };
  filter: Required<RealizedGainsFilter>;
}

const TERM_BOUNDARY_DAYS = 365;

export async function listRealizedGainClosures(
  userId: string,
  dek: Buffer | null,
  filter: RealizedGainsFilter = {},
): Promise<RealizedGainsResult> {
  const term = filter.term ?? "all";
  let from = filter.from;
  let to = filter.to;
  if (filter.taxYear != null) {
    from = from ?? `${filter.taxYear}-01-01`;
    to = to ?? `${filter.taxYear}-12-31`;
  }

  // Base predicate
  const preds = [eq(schema.holdingLotClosures.userId, userId)];
  if (from) preds.push(gte(schema.holdingLotClosures.closeDate, from));
  if (to) preds.push(lte(schema.holdingLotClosures.closeDate, to));
  if (filter.holdingId != null) {
    preds.push(eq(schema.holdingLots.holdingId, filter.holdingId));
  }
  if (filter.accountId != null) {
    preds.push(eq(schema.holdingLots.accountId, filter.accountId));
  }
  if (term === "short") {
    preds.push(lte(schema.holdingLotClosures.daysHeld, TERM_BOUNDARY_DAYS));
  } else if (term === "long") {
    preds.push(
      sql`${schema.holdingLotClosures.daysHeld} > ${TERM_BOUNDARY_DAYS}`,
    );
  }

  const rows = await db
    .select({
      closureId: schema.holdingLotClosures.id,
      closeDate: schema.holdingLotClosures.closeDate,
      closeTxId: schema.holdingLotClosures.closeTxId,
      lotId: schema.holdingLotClosures.lotId,
      holdingId: schema.holdingLots.holdingId,
      holdingNameCt: schema.portfolioHoldings.nameCt,
      holdingSymbolCt: schema.portfolioHoldings.symbolCt,
      accountId: schema.holdingLots.accountId,
      accountNameCt: schema.accounts.nameCt,
      qtyClosed: schema.holdingLotClosures.qtyClosed,
      proceedsPerShare: schema.holdingLotClosures.proceedsPerShare,
      costPerShare: schema.holdingLotClosures.costPerShare,
      realizedGain: schema.holdingLotClosures.realizedGain,
      currency: schema.holdingLotClosures.currency,
      openDate: schema.holdingLots.openDate,
      daysHeld: schema.holdingLotClosures.daysHeld,
      closeKind: schema.holdingLotClosures.closeKind,
      source: schema.holdingLotClosures.source,
    })
    .from(schema.holdingLotClosures)
    .innerJoin(
      schema.holdingLots,
      eq(schema.holdingLots.id, schema.holdingLotClosures.lotId),
    )
    .innerJoin(
      schema.portfolioHoldings,
      eq(schema.portfolioHoldings.id, schema.holdingLots.holdingId),
    )
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.holdingLots.accountId),
    )
    .where(and(...preds))
    .orderBy(desc(schema.holdingLotClosures.closeDate));

  const out: RealizedGainRow[] = rows.map((r) => {
    const days = Number(r.daysHeld);
    return {
      closureId: r.closureId,
      closeDate: r.closeDate,
      closeTxId: r.closeTxId,
      lotId: r.lotId,
      holdingId: r.holdingId,
      holdingName: decryptName(r.holdingNameCt, dek, null),
      accountId: r.accountId,
      accountName: decryptName(r.accountNameCt, dek, null),
      qtyClosed: Number(r.qtyClosed),
      proceedsPerShare: Number(r.proceedsPerShare),
      costPerShare: Number(r.costPerShare),
      realizedGain: Number(r.realizedGain),
      currency: r.currency,
      openDate: r.openDate,
      daysHeld: days,
      term: days <= TERM_BOUNDARY_DAYS ? "short" : "long",
      closeKind: r.closeKind as "sell" | "transfer_out",
      source: r.source,
    };
  });

  const totals = {
    realizedGain: 0,
    qtyClosed: 0,
    rowCount: out.length,
    byCurrency: {} as Record<string, { realizedGain: number; qtyClosed: number }>,
  };
  for (const r of out) {
    totals.realizedGain += r.realizedGain;
    totals.qtyClosed += r.qtyClosed;
    const cell = totals.byCurrency[r.currency] ?? { realizedGain: 0, qtyClosed: 0 };
    cell.realizedGain += r.realizedGain;
    cell.qtyClosed += r.qtyClosed;
    totals.byCurrency[r.currency] = cell;
  }

  return {
    rows: out,
    totals,
    filter: {
      from: from ?? "",
      to: to ?? "",
      taxYear: filter.taxYear ?? 0,
      holdingId: filter.holdingId ?? 0,
      accountId: filter.accountId ?? 0,
      term,
    },
  };
}

/**
 * CSV serialization for the dashboard's export button. Stdio MCP variant
 * uses the same renderer but `holdingName` / `accountName` will be null,
 * so it writes the ids instead.
 */
export function realizedGainsToCsv(
  result: RealizedGainsResult,
  opts: { useIds?: boolean } = {},
): string {
  const header = [
    "close_date",
    "open_date",
    "days_held",
    "term",
    opts.useIds ? "holding_id" : "holding",
    opts.useIds ? "account_id" : "account",
    "qty_closed",
    "cost_per_share",
    "proceeds_per_share",
    "realized_gain",
    "currency",
    "close_kind",
    "source",
  ].join(",");
  const body = result.rows.map((r) => {
    const cells = [
      r.closeDate,
      r.openDate,
      String(r.daysHeld),
      r.term,
      opts.useIds ? String(r.holdingId) : csvEscape(r.holdingName ?? `#${r.holdingId}`),
      opts.useIds ? String(r.accountId) : csvEscape(r.accountName ?? `#${r.accountId}`),
      r.qtyClosed.toString(),
      r.costPerShare.toString(),
      r.proceedsPerShare.toString(),
      r.realizedGain.toString(),
      r.currency,
      r.closeKind,
      r.source,
    ];
    return cells.join(",");
  });
  return [header, ...body].join("\n");
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

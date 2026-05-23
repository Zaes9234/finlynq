/**
 * Dividend income query — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Reads `transactions` where `category_id` matches the user's Dividends
 * category (resolved via the issue #84 HMAC `name_lookup` helper).
 * Includes BOTH cash dividends (qty=0) and reinvested dividends
 * (qty>0) — the former is direct income, the latter increases the
 * holding's share count and ALSO counts as income for tax purposes.
 * Withholding tax / negative-correction entries (qty=0, amt<0) are
 * surfaced as separate rows rather than netted (issue #84 explicit choice).
 *
 * Group-by modes for the dashboard:
 *   'quarter'   — one summary per (year, Qx)
 *   'year'      — one summary per year
 *   'holding'   — one summary per (holding, account)
 *   undefined   — return raw rows
 */

import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";

export interface DividendIncomeFilter {
  from?: string;     // YYYY-MM-DD
  to?: string;       // YYYY-MM-DD
  taxYear?: number;
  holdingId?: number;
  accountId?: number;
  groupBy?: "quarter" | "year" | "holding";
}

export interface DividendRow {
  txId: number;
  date: string;
  amount: number;            // entered_amount where present, else amount
  currency: string;
  isReinvested: boolean;     // qty > 0
  isWithholding: boolean;    // amount < 0 (withholding tax, correction)
  holdingId: number | null;
  holdingName: string | null;
  accountId: number | null;
  accountName: string | null;
  payee: string | null;      // decrypted
}

export interface DividendGroupRow {
  bucket: string;            // 'YYYY-Qn' | 'YYYY' | 'holding:<id>'
  label: string;             // user-friendly bucket label
  amount: number;
  currency: string;          // mixed-currency portfolios fold into multiple group rows
  rowCount: number;
  reinvestedCount: number;
  withholdingCount: number;
}

export interface DividendIncomeResult {
  rows?: DividendRow[];      // populated when groupBy is undefined
  groups?: DividendGroupRow[]; // populated when groupBy is set
  totals: {
    amount: number;
    rowCount: number;
    byCurrency: Record<string, number>;
  };
  filter: Required<DividendIncomeFilter>;
}

export async function listDividendIncome(
  userId: string,
  dek: Buffer | null,
  filter: DividendIncomeFilter = {},
): Promise<DividendIncomeResult> {
  let from = filter.from;
  let to = filter.to;
  if (filter.taxYear != null) {
    from = from ?? `${filter.taxYear}-01-01`;
    to = to ?? `${filter.taxYear}-12-31`;
  }

  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );

  const empty: DividendIncomeResult = {
    rows: filter.groupBy ? undefined : [],
    groups: filter.groupBy ? [] : undefined,
    totals: { amount: 0, rowCount: 0, byCurrency: {} },
    filter: {
      from: from ?? "",
      to: to ?? "",
      taxYear: filter.taxYear ?? 0,
      holdingId: filter.holdingId ?? 0,
      accountId: filter.accountId ?? 0,
      groupBy: filter.groupBy ?? "year",
    },
  };

  if (dividendsCategoryId == null) {
    // No Dividends category configured → no dividend income. Stdio
    // (no DEK) lands here too, matching the issue #84 graceful-degrade
    // contract: returns 0 rather than throwing.
    return empty;
  }

  const preds = [
    eq(schema.transactions.userId, userId),
    eq(schema.transactions.categoryId, dividendsCategoryId),
    isNotNull(schema.transactions.portfolioHoldingId),
  ];
  if (from) preds.push(gte(schema.transactions.date, from));
  if (to) preds.push(lte(schema.transactions.date, to));
  if (filter.holdingId != null) {
    preds.push(eq(schema.transactions.portfolioHoldingId, filter.holdingId));
  }
  if (filter.accountId != null) {
    preds.push(eq(schema.transactions.accountId, filter.accountId));
  }

  const rows = await db
    .select({
      txId: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      enteredAmount: schema.transactions.enteredAmount,
      currency: schema.transactions.currency,
      enteredCurrency: schema.transactions.enteredCurrency,
      quantity: schema.transactions.quantity,
      payeeCt: schema.transactions.payee,
      holdingId: schema.transactions.portfolioHoldingId,
      accountId: schema.transactions.accountId,
      holdingNameCt: schema.portfolioHoldings.nameCt,
      accountNameCt: schema.accounts.nameCt,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.portfolioHoldings,
      eq(schema.portfolioHoldings.id, schema.transactions.portfolioHoldingId),
    )
    .leftJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.transactions.accountId),
    )
    .where(and(...preds));

  const dividendRows: DividendRow[] = rows.map((r) => {
    const amount = Number(r.enteredAmount ?? r.amount ?? 0);
    const ccy = (r.enteredCurrency ?? r.currency ?? "USD") as string;
    const qty = Number(r.quantity ?? 0);
    const payeePlain = r.payeeCt
      ? dek
        ? tryDecryptField(dek, String(r.payeeCt)) ?? null
        : null
      : null;
    return {
      txId: r.txId,
      date: r.date,
      amount,
      currency: ccy,
      isReinvested: qty > 0,
      isWithholding: amount < 0,
      holdingId: r.holdingId ?? null,
      holdingName: decryptName(r.holdingNameCt, dek, null),
      accountId: r.accountId ?? null,
      accountName: decryptName(r.accountNameCt, dek, null),
      payee: payeePlain,
    };
  });

  const totals = {
    amount: 0,
    rowCount: dividendRows.length,
    byCurrency: {} as Record<string, number>,
  };
  for (const r of dividendRows) {
    totals.amount += r.amount;
    totals.byCurrency[r.currency] = (totals.byCurrency[r.currency] ?? 0) + r.amount;
  }

  if (!filter.groupBy) {
    return {
      rows: dividendRows,
      totals,
      filter: {
        from: from ?? "",
        to: to ?? "",
        taxYear: filter.taxYear ?? 0,
        holdingId: filter.holdingId ?? 0,
        accountId: filter.accountId ?? 0,
        groupBy: "year",
      },
    };
  }

  // Group-by aggregation.
  const groupMap = new Map<string, DividendGroupRow>();
  for (const r of dividendRows) {
    let bucket: string;
    let label: string;
    if (filter.groupBy === "quarter") {
      const [y, m] = r.date.split("-").map((s) => parseInt(s, 10));
      const q = Math.floor((m - 1) / 3) + 1;
      bucket = `${y}-Q${q}-${r.currency}`;
      label = `${y} Q${q}`;
    } else if (filter.groupBy === "year") {
      const y = r.date.slice(0, 4);
      bucket = `${y}-${r.currency}`;
      label = y;
    } else {
      bucket = `holding:${r.holdingId}-${r.accountId}-${r.currency}`;
      label = r.holdingName ?? `holding #${r.holdingId}`;
    }
    const cell = groupMap.get(bucket) ?? {
      bucket,
      label,
      amount: 0,
      currency: r.currency,
      rowCount: 0,
      reinvestedCount: 0,
      withholdingCount: 0,
    };
    cell.amount += r.amount;
    cell.rowCount += 1;
    if (r.isReinvested) cell.reinvestedCount += 1;
    if (r.isWithholding) cell.withholdingCount += 1;
    groupMap.set(bucket, cell);
  }

  // Stable sort: quarter / year by label DESC, holding by amount DESC.
  const groups = [...groupMap.values()];
  if (filter.groupBy === "holding") {
    groups.sort((a, b) => b.amount - a.amount);
  } else {
    groups.sort((a, b) => b.label.localeCompare(a.label));
  }

  return {
    groups,
    totals,
    filter: {
      from: from ?? "",
      to: to ?? "",
      taxYear: filter.taxYear ?? 0,
      holdingId: filter.holdingId ?? 0,
      accountId: filter.accountId ?? 0,
      groupBy: filter.groupBy,
    },
  };
}

/**
 * Adopt this signature on the MCP HTTP `get_dividend_income` tool so the
 * helper above is the single source of truth across REST + MCP.
 */
export function dividendsToCsv(result: DividendIncomeResult): string {
  if (result.rows) {
    const header = [
      "date",
      "amount",
      "currency",
      "is_reinvested",
      "is_withholding",
      "holding",
      "account",
      "payee",
    ].join(",");
    const body = result.rows.map((r) =>
      [
        r.date,
        r.amount.toString(),
        r.currency,
        String(r.isReinvested),
        String(r.isWithholding),
        csvEscape(r.holdingName ?? `#${r.holdingId ?? 0}`),
        csvEscape(r.accountName ?? `#${r.accountId ?? 0}`),
        csvEscape(r.payee ?? ""),
      ].join(","),
    );
    return [header, ...body].join("\n");
  }
  const header = [
    "bucket",
    "label",
    "amount",
    "currency",
    "row_count",
    "reinvested_count",
    "withholding_count",
  ].join(",");
  const body = (result.groups ?? []).map((g) =>
    [
      g.bucket,
      csvEscape(g.label),
      g.amount.toString(),
      g.currency,
      String(g.rowCount),
      String(g.reinvestedCount),
      String(g.withholdingCount),
    ].join(","),
  );
  return [header, ...body].join("\n");
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// decryptField unused but re-export to satisfy "complete decrypt path" intent
// in case a future caller wants payee plaintext with hard-fail.
export { decryptField };

/**
 * Admin price/FX cache inspector API.
 *
 * GET /api/admin/price-cache?table=price|fx&...filters
 *   Operator-only, read-only view of the two server-side market-data caches:
 *     - `price_cache`  (stock / ETF / crypto daily closes; symbol, date, price,
 *                       currency, previous_close, fetched_at)
 *     - `fx_rates`     (USD-anchored FX rate cache; currency, date, rate_to_usd,
 *                       source, fetched_at)
 *
 * Both tables are global (no user_id) and can be large (price_cache is tens of
 * thousands of rows), so this is server-filtered + paginated. Each returned row
 * carries a derived `stale` flag computed from the SAME pure
 * `isPriceCacheRowStale` the read path uses (FINLYNQ-204): a TODAY-dated row
 * older than the 30-min TTL is stale; any historical (date != today) row is
 * immutable and never stale.
 *
 * DELETE removes cache rows (one by id, or all matching a filter) — used to
 * clear garbage rows (e.g. currency-code symbols mis-served into price_cache).
 * Deleting is safe: real prices self-heal on next read; garbage stays gone.
 *
 * Hand-rolls `requireAdmin` (NOT apiHandler) + the managed-mode postgres-dialect
 * guard, mirroring the other /api/admin/* routes. No DEK needed — both caches
 * are plaintext, user-independent market data.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, gte, ilike, lt, lte, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { db, schema, getDialect } from "@/db";
import { requireAdmin } from "@/lib/auth/require-admin";
import { isPriceCacheRowStale, PRICE_CACHE_TODAY_TTL_MS } from "@/lib/price-service";
import { todayISO } from "@/lib/utils/date";
import { normalizeDbRows } from "@/lib/db-utils";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw == null ? def : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Whitelisted sort columns per table (key from the client → real Drizzle column).
// Anything else falls back to fetched_at so the param can never inject SQL.
const PRICE_SORT: Record<string, AnyColumn> = {
  symbol: schema.priceCache.symbol,
  date: schema.priceCache.date,
  price: schema.priceCache.price,
  currency: schema.priceCache.currency,
  previousClose: schema.priceCache.previousClose,
  fetchedAt: schema.priceCache.fetchedAt,
};
const FX_SORT: Record<string, AnyColumn> = {
  currency: schema.fxRates.currency,
  date: schema.fxRates.date,
  rateToUsd: schema.fxRates.rateToUsd,
  source: schema.fxRates.source,
  fetchedAt: schema.fxRates.fetchedAt,
};

/**
 * Build the WHERE conditions for a table from the request filter params. Shared
 * by GET (list) and DELETE (bulk) so they target EXACTLY the same rows — a bulk
 * delete clears precisely what the admin sees filtered.
 */
function buildConds(
  table: "price" | "fx",
  p: URLSearchParams,
  today: string,
  staleThreshold: Date,
): SQL[] {
  const search = (p.get("search") ?? "").trim();
  const dateExact = (p.get("date") ?? "").trim();
  const dateFrom = (p.get("dateFrom") ?? "").trim();
  const dateTo = (p.get("dateTo") ?? "").trim();
  const todayOnly = p.get("todayOnly") === "1";
  const staleOnly = p.get("staleOnly") === "1";
  const conds: SQL[] = [];
  if (table === "fx") {
    if (search) conds.push(ilike(schema.fxRates.currency, `%${search}%`));
    if (dateExact) conds.push(eq(schema.fxRates.date, dateExact));
    if (dateFrom) conds.push(gte(schema.fxRates.date, dateFrom));
    if (dateTo) conds.push(lte(schema.fxRates.date, dateTo));
    if (todayOnly) conds.push(eq(schema.fxRates.date, today));
    if (staleOnly) {
      conds.push(eq(schema.fxRates.date, today));
      conds.push(lt(schema.fxRates.fetchedAt, staleThreshold));
    }
  } else {
    if (search) conds.push(ilike(schema.priceCache.symbol, `%${search}%`));
    if (dateExact) conds.push(eq(schema.priceCache.date, dateExact));
    if (dateFrom) conds.push(gte(schema.priceCache.date, dateFrom));
    if (dateTo) conds.push(lte(schema.priceCache.date, dateTo));
    if (todayOnly) conds.push(eq(schema.priceCache.date, today));
    if (staleOnly) {
      conds.push(eq(schema.priceCache.date, today));
      conds.push(lt(schema.priceCache.fetchedAt, staleThreshold));
    }
  }
  return conds;
}

/** True if ANY narrowing filter is present. Bulk DELETE requires this so an
 *  empty-filter call can never wipe the whole cache. */
function hasAnyFilter(p: URLSearchParams): boolean {
  return Boolean(
    (p.get("search") ?? "").trim() ||
      (p.get("date") ?? "").trim() ||
      (p.get("dateFrom") ?? "").trim() ||
      (p.get("dateTo") ?? "").trim() ||
      p.get("todayOnly") === "1" ||
      p.get("staleOnly") === "1",
  );
}

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }

  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const p = request.nextUrl.searchParams;
  const table = p.get("table") === "fx" ? "fx" : "price";
  const sortKey = p.get("sort") ?? "fetchedAt";
  const sortDir = p.get("dir") === "asc" ? "asc" : "desc";
  const limit = clampInt(p.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(p.get("offset"), 0, 0, 5_000_000);

  const today = todayISO();
  // Rows last refreshed before this instant are past the today-row TTL.
  const staleThreshold = new Date(Date.now() - PRICE_CACHE_TODAY_TTL_MS);

  try {
    if (table === "fx") {
      const conds = buildConds("fx", p, today, staleThreshold);
      const where = conds.length ? and(...conds) : undefined;

      const orderCol = FX_SORT[sortKey] ?? schema.fxRates.fetchedAt;
      const order = sortDir === "asc" ? asc(orderCol) : desc(orderCol);

      const [rows, countRows, summaryRes] = await Promise.all([
        db.select().from(schema.fxRates).where(where).orderBy(order).limit(limit).offset(offset),
        db.select({ c: sql<number>`count(*)::int` }).from(schema.fxRates).where(where),
        db.execute(sql`
          SELECT count(*)::int AS total_rows,
                 count(DISTINCT currency)::int AS distinct_keys,
                 min(date) AS first_date,
                 max(date) AS last_date,
                 count(*) FILTER (WHERE date = ${today})::int AS today_rows,
                 count(*) FILTER (WHERE date = ${today} AND fetched_at < now() - (${PRICE_CACHE_TODAY_TTL_MS} || ' milliseconds')::interval)::int AS stale_today_rows
          FROM fx_rates
        `),
      ]);

      const s = normalizeDbRows(summaryRes)[0] ?? {};
      return NextResponse.json({
        table,
        today,
        total: countRows[0]?.c ?? 0,
        limit,
        offset,
        rows: rows.map((r) => ({
          id: r.id,
          currency: r.currency,
          date: r.date,
          rateToUsd: r.rateToUsd,
          source: r.source,
          fetchedAt: r.fetchedAt instanceof Date ? r.fetchedAt.toISOString() : String(r.fetchedAt),
          stale: isPriceCacheRowStale(r.date, r.fetchedAt, today),
        })),
        summary: {
          totalRows: Number(s.total_rows ?? 0),
          distinctKeys: Number(s.distinct_keys ?? 0),
          firstDate: s.first_date ?? null,
          lastDate: s.last_date ?? null,
          todayRows: Number(s.today_rows ?? 0),
          staleTodayRows: Number(s.stale_today_rows ?? 0),
        },
      });
    }

    // ── price_cache ──
    const conds = buildConds("price", p, today, staleThreshold);
    const where = conds.length ? and(...conds) : undefined;

    const orderCol = PRICE_SORT[sortKey] ?? schema.priceCache.fetchedAt;
    const order = sortDir === "asc" ? asc(orderCol) : desc(orderCol);

    const [rows, countRows, summaryRes] = await Promise.all([
      db.select().from(schema.priceCache).where(where).orderBy(order).limit(limit).offset(offset),
      db.select({ c: sql<number>`count(*)::int` }).from(schema.priceCache).where(where),
      db.execute(sql`
        SELECT count(*)::int AS total_rows,
               count(DISTINCT symbol)::int AS distinct_keys,
               min(date) AS first_date,
               max(date) AS last_date,
               count(*) FILTER (WHERE date = ${today})::int AS today_rows,
               count(*) FILTER (WHERE date = ${today} AND fetched_at < now() - (${PRICE_CACHE_TODAY_TTL_MS} || ' milliseconds')::interval)::int AS stale_today_rows
        FROM price_cache
      `),
    ]);

    const s = normalizeDbRows(summaryRes)[0] ?? {};
    return NextResponse.json({
      table,
      today,
      total: countRows[0]?.c ?? 0,
      limit,
      offset,
      rows: rows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        date: r.date,
        price: r.price,
        currency: r.currency,
        previousClose: r.previousClose,
        fetchedAt: r.fetchedAt instanceof Date ? r.fetchedAt.toISOString() : String(r.fetchedAt),
        stale: isPriceCacheRowStale(r.date, r.fetchedAt, today),
      })),
      summary: {
        totalRows: Number(s.total_rows ?? 0),
        distinctKeys: Number(s.distinct_keys ?? 0),
        firstDate: s.first_date ?? null,
        lastDate: s.last_date ?? null,
        todayRows: Number(s.today_rows ?? 0),
        staleTodayRows: Number(s.stale_today_rows ?? 0),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load cache";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/price-cache?table=price|fx
 *   ?id=N            → delete ONE cache row by id.
 *   ?all=1&<filters> → delete EVERY row matching the SAME filters as GET.
 *                      Requires at least one filter (refuses to wipe the whole
 *                      cache) — used to clear garbage rows such as currency-code
 *                      symbols (XAU/CAD/USD) Yahoo mis-served into price_cache.
 *
 * Safe by design: a deleted REAL price row is simply re-fetched on next read
 * (the cache self-heals); a deleted garbage row stays gone because the valuation
 * path never fetches currency-code symbols as prices (isCurrencyCodeSymbol).
 */
export async function DELETE(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }

  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const p = request.nextUrl.searchParams;
  const table = p.get("table") === "fx" ? "fx" : "price";

  try {
    // ── Single-row delete by id ──
    const idRaw = p.get("id");
    if (idRaw != null) {
      const id = parseInt(idRaw, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return NextResponse.json({ error: "Invalid id" }, { status: 400 });
      }
      const deleted =
        table === "fx"
          ? await db.delete(schema.fxRates).where(eq(schema.fxRates.id, id)).returning({ id: schema.fxRates.id })
          : await db.delete(schema.priceCache).where(eq(schema.priceCache.id, id)).returning({ id: schema.priceCache.id });
      return NextResponse.json({ deleted: deleted.length });
    }

    // ── Bulk delete by filter (requires a filter — never the whole table) ──
    if (p.get("all") === "1") {
      if (!hasAnyFilter(p)) {
        return NextResponse.json(
          { error: "Refusing to delete the entire cache — narrow with a filter first." },
          { status: 400 },
        );
      }
      const today = todayISO();
      const staleThreshold = new Date(Date.now() - PRICE_CACHE_TODAY_TTL_MS);
      const conds = buildConds(table, p, today, staleThreshold);
      const where = and(...conds);
      const deleted =
        table === "fx"
          ? await db.delete(schema.fxRates).where(where).returning({ id: schema.fxRates.id })
          : await db.delete(schema.priceCache).where(where).returning({ id: schema.priceCache.id });
      return NextResponse.json({ deleted: deleted.length });
    }

    return NextResponse.json({ error: "Provide ?id=N or ?all=1 with a filter." }, { status: 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete cache rows";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

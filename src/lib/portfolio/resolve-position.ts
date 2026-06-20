/**
 * FINLYNQ-208 — find-or-create a portfolio position / cash sleeve from a server
 * lib (no HTTP round-trip).
 *
 * The investment reconciliation executor needs to provision the non-cash
 * position the captured ticker resolves to AND the per-currency cash sleeve a
 * trade debits/credits, before calling the operations.ts helpers (which throw
 * `CashSleeveNotFoundError` / `HoldingNotFoundError` if those rows are absent).
 *
 * Both helpers honor the load-bearing portfolio invariants:
 *   - `resolveOrCreateSecurity` dual-writes `security_id` (securities-dual-write).
 *   - Every `portfolio_holdings` INSERT dual-writes a `holding_accounts` row in
 *     the same flow (on pairing failure the orphan holding is deleted).
 *   - Cash sleeves are `is_cash=true`, one per (user, account, currency)
 *     (partial unique index); a 23505 race re-selects the winner.
 *
 * This is the canonical extraction of POST /api/portfolio/holdings/cash-sleeve
 * (cash sleeve) + the MCP `add_portfolio_holding` body (non-cash position), so
 * the route + the executor share one chokepoint.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";
import { resolveOrCreateSecurity } from "@/lib/securities/resolve";

export interface ResolvedHolding {
  id: number;
  currency: string;
  /** True when this call created the row (vs. found an existing one). */
  created: boolean;
}

function is23505(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === "23505" || msg.toLowerCase().includes("unique");
}

async function pairHoldingAccount(
  userId: string,
  accountId: number,
  holdingId: number,
): Promise<void> {
  try {
    await db
      .insert(schema.holdingAccounts)
      .values({
        holdingId,
        accountId,
        userId,
        qty: 0,
        costBasis: 0,
        isPrimary: true,
      })
      .onConflictDoNothing();
  } catch (pairingErr) {
    // Roll back the orphan holding so we never leave an aggregator-invisible
    // position (CLAUDE.md "every portfolio_holdings INSERT dual-writes a
    // holding_accounts row").
    await db
      .delete(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.id, holdingId),
          eq(schema.portfolioHoldings.userId, userId),
        ),
      );
    throw pairingErr;
  }
}

/**
 * Find — or create — the explicit per-(user,account,currency) cash sleeve.
 * Idempotent on the partial unique index; a concurrent create re-selects.
 */
export async function resolveOrCreateCashSleeve(
  userId: string,
  dek: Buffer,
  accountId: number,
  currency: string,
): Promise<ResolvedHolding> {
  const ccy = currency.toUpperCase();

  const findExisting = async (): Promise<number | null> => {
    const row = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          eq(schema.portfolioHoldings.accountId, accountId),
          eq(schema.portfolioHoldings.currency, ccy),
          eq(schema.portfolioHoldings.isCash, true),
        ),
      )
      .limit(1);
    return row[0]?.id ?? null;
  };

  const existing = await findExisting();
  if (existing != null) return { id: existing, currency: ccy, created: false };

  const name = `Cash ${ccy}`;
  const enc = buildNameFields(dek, { name });
  const securityId = await resolveOrCreateSecurity(userId, dek, {
    symbol: null,
    name,
    isCryptoFlag: false,
    isCash: true,
    currency: ccy,
  });

  try {
    const inserted = await db
      .insert(schema.portfolioHoldings)
      .values({
        userId,
        accountId,
        currency: ccy,
        isCrypto: 0,
        isCash: true,
        securityId,
        note: "",
        ...enc,
      })
      .returning({ id: schema.portfolioHoldings.id });
    const id = inserted[0]?.id;
    if (id == null) throw new Error("cash sleeve insert returned no id");
    await pairHoldingAccount(userId, accountId, id);
    return { id, currency: ccy, created: true };
  } catch (err) {
    if (is23505(err)) {
      const winner = await findExisting();
      if (winner != null) return { id: winner, currency: ccy, created: false };
    }
    throw err;
  }
}

export interface ResolvePositionSpec {
  ticker: string | null;
  name: string | null;
  currency: string;
  isCrypto?: boolean;
}

export type ResolvePositionResult =
  | (ResolvedHolding & { ok: true })
  | { ok: false; code: "no_identity" };

/**
 * Find — or create — the non-cash position for a captured ticker / security
 * name inside an investment account. Dedupe is by `security_id` (the canonical
 * within-account identity); a fresh position dual-writes security_id +
 * holding_accounts. Returns `no_identity` when neither a ticker nor a name is
 * available to resolve a security.
 */
export async function resolveOrCreateInvestmentPosition(
  userId: string,
  dek: Buffer,
  accountId: number,
  spec: ResolvePositionSpec,
): Promise<ResolvePositionResult> {
  const ticker = (spec.ticker ?? "").trim() || null;
  const name = (spec.name ?? "").trim() || null;
  if (!ticker && !name) return { ok: false, code: "no_identity" };

  const ccy = spec.currency.toUpperCase();
  const isCrypto = spec.isCrypto === true;
  const displayName = name ?? ticker!;

  const securityId = await resolveOrCreateSecurity(userId, dek, {
    symbol: ticker,
    name: displayName,
    isCryptoFlag: isCrypto,
    isCash: false,
    currency: ccy,
  });

  // 1. Existing non-cash position in this account for the same security.
  if (securityId != null) {
    const existing = await db
      .select({
        id: schema.portfolioHoldings.id,
        currency: schema.portfolioHoldings.currency,
      })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          eq(schema.portfolioHoldings.accountId, accountId),
          eq(schema.portfolioHoldings.securityId, securityId),
          eq(schema.portfolioHoldings.isCash, false),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { ok: true, id: existing[0].id, currency: existing[0].currency, created: false };
    }
  }

  // 2. Create. Encrypt name + symbol; dual-write security_id + holding_accounts.
  const enc = buildNameFields(dek, { name: displayName, symbol: ticker ?? "" });
  try {
    const inserted = await db
      .insert(schema.portfolioHoldings)
      .values({
        userId,
        accountId,
        currency: ccy,
        isCrypto: isCrypto ? 1 : 0,
        isCash: false,
        securityId,
        note: "",
        ...enc,
      })
      .returning({
        id: schema.portfolioHoldings.id,
        currency: schema.portfolioHoldings.currency,
      });
    const row = inserted[0];
    if (!row) throw new Error("position insert returned no id");
    await pairHoldingAccount(userId, accountId, row.id);
    return { ok: true, id: row.id, currency: row.currency, created: true };
  } catch (err) {
    // name_lookup collision (user, account, name_lookup) — re-select the winner.
    if (is23505(err) && enc.nameLookup) {
      const winner = await db
        .select({
          id: schema.portfolioHoldings.id,
          currency: schema.portfolioHoldings.currency,
        })
        .from(schema.portfolioHoldings)
        .where(
          and(
            eq(schema.portfolioHoldings.userId, userId),
            eq(schema.portfolioHoldings.accountId, accountId),
            eq(schema.portfolioHoldings.nameLookup, enc.nameLookup as string),
          ),
        )
        .limit(1);
      if (winner[0]) {
        return { ok: true, id: winner[0].id, currency: winner[0].currency, created: false };
      }
    }
    throw err;
  }
}

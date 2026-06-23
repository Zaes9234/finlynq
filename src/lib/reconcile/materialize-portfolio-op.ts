/**
 * materializeBankRowAsPortfolioOp — turn a matched investment bank row into a
 * real lot-aware portfolio operation (FINLYNQ-208).
 *
 * This is the sanctioned chokepoint that lifts the investment-account guard the
 * cash writer (`materializeBankRowAsTransaction`) keeps refusing. It is DRIVEN
 * by a user-authored `record_investment_op` rule action — the op type + which
 * row variables feed qty/total/price are the USER's choice, never inferred — so
 * the system only executes what the user's rule says.
 *
 * Flow:
 *   1. Load + ownership-check the bank row; tier-aware decrypt of the captured
 *      ticker / security name / payee.
 *   2. Re-assert the action's semantic validity (validateInvestmentOpAction).
 *   3. Resolve numeric params from the action's bindings (pure resolver).
 *   4. Resolve / create the non-cash position (from the row's ticker or an
 *      explicit holdingId) + the cash sleeve — both dual-write security_id +
 *      holding_accounts.
 *   5. Call the canonical operations.ts helper (sign-correct legs, FIFO lots —
 *      lot selection is ALWAYS automatic, never rule-specified).
 *   6. Stamp bank-ledger lineage on the leg that sits on the bank row's account
 *      via `linkTransactionToBank` ('primary', source='reconcile_link').
 *
 * Load-bearing invariants honored — see CLAUDE.md "Portfolio / aggregation" +
 * "MCP investment writes":
 *   - Portfolio-op rows originate ONLY from operations.ts (this never INSERTs a
 *     buy/sell/*_cash_leg/portfolio_income row itself).
 *   - `is_investment ⇒ portfolio_holdings` — the guard lifts ONLY because this
 *     path resolves/creates the position + sleeve before the write.
 *   - `link_id` / `trade_link_id` are server-generated inside operations.ts.
 *   - Dividend → category literal "Dividends" + related_holding = paying
 *     security (FINLYNQ-173).
 *   - `invalidateUser` runs (inside `linkTransactionToBank`); snapshots marked
 *     dirty so net-worth history rebuilds.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import {
  validateInvestmentOpAction,
  type RecordInvestmentOpAction,
} from "@/lib/rules/schema";
import { resolveTrade, resolveCashAmount } from "@/lib/rules/investment-op-binding";
import {
  resolveOrCreateCashSleeve,
  resolveOrCreateInvestmentPosition,
} from "@/lib/portfolio/resolve-position";
import { resolveOrCreateInvestmentIncomeCategory } from "@/lib/investment-income-category";
import { linkTransactionToBank } from "./links";
import {
  recordBuy,
  recordSell,
  recordPortfolioIncomeOrExpense,
  recordReinvestedIncomeInShares,
  recordBrokerageDeposit,
  recordBrokerageWithdrawal,
  CashSleeveNotFoundError,
  CurrencyMismatchError,
  HoldingNotFoundError,
} from "@/lib/portfolio/operations";

export type MaterializePortfolioOpFailCode =
  | "bank_not_found"
  | "account_not_found"
  | "not_investment_account"
  | "counterparty_not_found"
  | "counterparty_is_investment"
  | "invalid_action"
  | "position_unresolved"
  | "holding_not_found"
  | "price_underivable"
  | "currency_mismatch"
  | "op_failed";

export type MaterializePortfolioOpResult =
  | {
      ok: true;
      op: RecordInvestmentOpAction["op"];
      /** All transaction ids the op wrote (both legs for buy/sell/deposit/etc). */
      transactionIds: number[];
      /** The leg the bank row was linked to ('primary'). */
      linkedTransactionId: number;
    }
  | { ok: false; code: MaterializePortfolioOpFailCode; message: string };

export interface MaterializeBankRowAsPortfolioOpInput {
  userId: string;
  dek: Buffer;
  bankTransactionId: string;
  action: RecordInvestmentOpAction;
  /** FINLYNQ-208 — pure modifiers from a multi-action rule (rename_payee /
   *  set_tags) that ride along onto the recorded op's rows. When unset, the
   *  op uses the bank row's own payee. */
  overrides?: { payee?: string | null; tags?: string | null };
}

interface BankRow {
  id: string;
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  quantity: number | null;
  ticker: string | null;
  securityName: string | null;
  payee: string | null;
  encryptionTier: string | null;
}

const fail = (
  code: MaterializePortfolioOpFailCode,
  message: string,
): MaterializePortfolioOpResult => ({ ok: false, code, message });

export async function materializeBankRowAsPortfolioOp(
  input: MaterializeBankRowAsPortfolioOpInput,
): Promise<MaterializePortfolioOpResult> {
  const { userId, dek, action } = input;

  // 0. Re-assert action validity (the route validates too; defense in depth).
  const invalid = validateInvestmentOpAction(action);
  if (invalid) {
    return fail("invalid_action", `Investment-op action is incomplete: ${invalid}.`);
  }

  // 1. Load + ownership-check the bank row.
  const rows = await db
    .select({
      id: schema.bankTransactions.id,
      accountId: schema.bankTransactions.accountId,
      date: schema.bankTransactions.date,
      amount: schema.bankTransactions.amount,
      currency: schema.bankTransactions.currency,
      quantity: schema.bankTransactions.quantity,
      ticker: schema.bankTransactions.ticker,
      securityName: schema.bankTransactions.securityName,
      payee: schema.bankTransactions.payee,
      encryptionTier: schema.bankTransactions.encryptionTier,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.id, input.bankTransactionId),
        eq(schema.bankTransactions.userId, userId),
      ),
    )
    .limit(1);
  const bank = rows[0] as BankRow | undefined;
  if (!bank) return fail("bank_not_found", "Not found");

  const tickerPlain = decodeBankString(bank.encryptionTier, dek, bank.ticker);
  const securityNamePlain = decodeBankString(bank.encryptionTier, dek, bank.securityName);
  const payeeFromRow = decodeBankString(bank.encryptionTier, dek, bank.payee) ?? undefined;
  // FINLYNQ-208 — a multi-action rule's rename_payee / set_tags ride along.
  const payeePlain = input.overrides?.payee ?? payeeFromRow;
  const tags = input.overrides?.tags ?? undefined;

  // 2. Resolve + ownership-check the investment account.
  const invAcct = await db
    .select({
      id: schema.accounts.id,
      isInvestment: schema.accounts.isInvestment,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, action.investmentAccountId),
        eq(schema.accounts.userId, userId),
      ),
    )
    .limit(1);
  if (!invAcct[0]) return fail("account_not_found", "Investment account not found");
  if (!invAcct[0].isInvestment) {
    return fail(
      "not_investment_account",
      "Configured investment account is not an investment account.",
    );
  }

  const rowVars = {
    amount: bank.amount,
    quantity: bank.quantity,
    price: null as number | null,
  };

  try {
    switch (action.op) {
      case "buy":
      case "sell":
        return await runTrade(
          { userId, dek, action, bank, tickerPlain, securityNamePlain, payeePlain, tags },
          rowVars,
        );
      case "dividend":
      case "interest":
      case "fee":
        return await runHoldingCash(
          { userId, dek, action, bank, tickerPlain, securityNamePlain, payeePlain, tags },
          rowVars,
        );
      case "deposit":
      case "withdrawal":
        return await runDepositWithdrawal(
          { userId, dek, action, bank, payeePlain, tags },
          rowVars,
        );
      default: {
        const _exhaustive: never = action.op;
        void _exhaustive;
        return fail("invalid_action", "Unknown investment op.");
      }
    }
  } catch (err) {
    return mapOpError(err);
  } finally {
    // Net-worth investment snapshots changed; mark dirty (self-heals the chart).
    await markSnapshotsDirty(userId, bank.date);
    invalidateUser(userId);
  }
}

// ─── buy / sell ──────────────────────────────────────────────────────────────

interface OpCtx {
  userId: string;
  dek: Buffer;
  action: RecordInvestmentOpAction;
  bank: BankRow;
  tickerPlain: string | null;
  securityNamePlain: string | null;
  payeePlain?: string;
  /** Tags from a multi-action rule's set_tags (FINLYNQ-208). */
  tags?: string;
}

async function runTrade(
  ctx: OpCtx,
  rowVars: { amount: number | null; quantity: number | null; price: number | null },
): Promise<MaterializePortfolioOpResult> {
  const { userId, dek, action, bank } = ctx;

  // Resolve the position (explicit holdingId, or from the captured ticker/name).
  let holdingId: number;
  let holdingCurrency: string;
  if (action.holdingId != null) {
    const h = await fetchNonCashHolding(userId, action.holdingId);
    if (!h) return fail("holding_not_found", "Configured holding not found.");
    holdingId = h.id;
    holdingCurrency = h.currency;
  } else if (action.useRowTicker) {
    const pos = await resolveOrCreateInvestmentPosition(userId, dek, action.investmentAccountId, {
      ticker: ctx.tickerPlain,
      name: ctx.securityNamePlain,
      currency: bank.currency,
    });
    if (!pos.ok) {
      return fail(
        "position_unresolved",
        "This row has no ticker / security name to resolve a holding. Pick an explicit holding in the rule.",
      );
    }
    holdingId = pos.id;
    holdingCurrency = pos.currency;
  } else {
    return fail("position_unresolved", "No holding configured for this trade rule.");
  }

  const trade = resolveTrade(action, rowVars);
  if (!trade.ok) return fail("price_underivable", `Could not derive the trade amounts: ${trade.code}.`);

  // Ensure the matching cash sleeve exists, then pass it explicitly so the
  // helper never trips CashSleeveNotFoundError.
  const sleeve = await resolveOrCreateCashSleeve(userId, dek, action.investmentAccountId, holdingCurrency);

  if (action.op === "buy") {
    const r = await recordBuy({
      userId,
      dek,
      accountId: action.investmentAccountId,
      holdingId,
      qty: trade.qty,
      totalCost: trade.total,
      date: bank.date,
      payee: ctx.payeePlain,
      tags: ctx.tags,
      cashSleeveHoldingId: sleeve.id,
      source: "reconcile_link",
    });
    const linkedTransactionId = r.stockLegTxId;
    await stampLineage(userId, linkedTransactionId, bank.id);
    return { ok: true, op: "buy", transactionIds: [r.stockLegTxId, r.cashLegTxId], linkedTransactionId };
  }

  const r = await recordSell({
    userId,
    dek,
    accountId: action.investmentAccountId,
    holdingId,
    qty: trade.qty,
    totalProceeds: trade.total,
    date: bank.date,
    payee: ctx.payeePlain,
    tags: ctx.tags,
    cashSleeveHoldingId: sleeve.id,
    source: "reconcile_link",
    // Lot selection is ALWAYS automatic FIFO (default) — never rule-specified.
  });
  const linkedTransactionId = r.stockLegTxId;
  await stampLineage(userId, linkedTransactionId, bank.id);
  return { ok: true, op: "sell", transactionIds: [r.stockLegTxId, r.cashLegTxId], linkedTransactionId };
}

// ─── dividend / interest / fee ───────────────────────────────────────────────

async function runHoldingCash(
  ctx: OpCtx,
  rowVars: { amount: number | null; quantity: number | null; price: number | null },
): Promise<MaterializePortfolioOpResult> {
  const { userId, dek, action, bank } = ctx;

  // FINLYNQ — income received AS SHARES (single-leg DRIP). Only dividend /
  // interest may settle into shares; the executor records ONE row on the
  // resolved position and opens a lot at value/qty (no cash sleeve touched).
  if (action.settleAs === "shares" && (action.op === "dividend" || action.op === "interest")) {
    return await runIncomeInShares(ctx, rowVars);
  }

  const cash = resolveCashAmount(action, rowVars);
  if (!cash.ok) return fail("price_underivable", `Could not derive the cash amount: ${cash.code}.`);

  // Optional holding attribution (the paying security for a dividend).
  let relatedHoldingId: number | null = null;
  if (action.holdingId != null) {
    const h = await fetchNonCashHolding(userId, action.holdingId);
    if (!h) return fail("holding_not_found", "Configured holding not found.");
    relatedHoldingId = h.id;
  } else if (action.useRowTicker) {
    const pos = await resolveOrCreateInvestmentPosition(userId, dek, action.investmentAccountId, {
      ticker: ctx.tickerPlain,
      name: ctx.securityNamePlain,
      currency: bank.currency,
    });
    // For interest/fee a missing security is fine (account-level cash item);
    // for a dividend we still proceed (attribution just stays null).
    if (pos.ok) relatedHoldingId = pos.id;
  }

  // runHoldingCash is only reached for these three ops (dispatched by the
  // switch in materializeBankRowAsPortfolioOp).
  const kind = action.op as "dividend" | "interest" | "fee";
  // An explicit rule category wins; otherwise resolve the canonical income
  // category by op kind (Dividends / Interest / Investment Fees).
  const categoryId =
    action.categoryId ??
    (await resolveOrCreateInvestmentIncomeCategory(db, userId, dek, kind));

  // dividend / interest are income (+); fee is an expense (−).
  const signed = kind === "fee" ? -cash.amount : cash.amount;

  // The income/expense helper requires the cash sleeve to already exist.
  await resolveOrCreateCashSleeve(userId, dek, action.investmentAccountId, bank.currency);

  const r = await recordPortfolioIncomeOrExpense({
    userId,
    dek,
    accountId: action.investmentAccountId,
    currency: bank.currency,
    amount: signed,
    relatedHoldingId,
    categoryId,
    date: bank.date,
    payee: ctx.payeePlain,
    tags: ctx.tags,
    source: "reconcile_link",
  });
  await stampLineage(userId, r.txId, bank.id);
  return { ok: true, op: kind, transactionIds: [r.txId], linkedTransactionId: r.txId };
}

// ─── dividend / interest settled AS SHARES (DRIP) ─────────────────────────────

async function runIncomeInShares(
  ctx: OpCtx,
  rowVars: { amount: number | null; quantity: number | null; price: number | null },
): Promise<MaterializePortfolioOpResult> {
  const { userId, dek, action, bank } = ctx;

  // Resolve the REQUIRED destination position — the reinvested shares land
  // here (unlike a cash dividend, where the holding is optional attribution).
  let holdingId: number;
  if (action.holdingId != null) {
    const h = await fetchNonCashHolding(userId, action.holdingId);
    if (!h) return fail("holding_not_found", "Configured holding not found.");
    holdingId = h.id;
  } else if (action.useRowTicker) {
    const pos = await resolveOrCreateInvestmentPosition(userId, dek, action.investmentAccountId, {
      ticker: ctx.tickerPlain,
      name: ctx.securityNamePlain,
      currency: bank.currency,
    });
    if (!pos.ok) {
      return fail(
        "position_unresolved",
        "This row has no ticker / security name to resolve a holding for the reinvested shares. Pick an explicit holding in the rule.",
      );
    }
    holdingId = pos.id;
  } else {
    return fail("position_unresolved", "No holding configured for the reinvested shares.");
  }

  // Derive shares (qty) + dollar value (total) from the bindings — any two of
  // {qty, total, price}, same derivation as a trade.
  const trade = resolveTrade(action, rowVars);
  if (!trade.ok) {
    return fail("price_underivable", `Could not derive the shares / value: ${trade.code}.`);
  }

  const kind = action.op as "dividend" | "interest";
  // An explicit rule category wins; otherwise resolve the canonical income
  // category by op kind (Dividends / Interest).
  const categoryId =
    action.categoryId ??
    (await resolveOrCreateInvestmentIncomeCategory(db, userId, dek, kind));

  const r = await recordReinvestedIncomeInShares({
    userId,
    dek,
    accountId: action.investmentAccountId,
    holdingId,
    qty: trade.qty,
    amount: trade.total,
    categoryId,
    date: bank.date,
    payee: ctx.payeePlain,
    tags: ctx.tags,
    source: "reconcile_link",
  });
  await stampLineage(userId, r.txId, bank.id);
  return { ok: true, op: kind, transactionIds: [r.txId], linkedTransactionId: r.txId };
}

// ─── deposit / withdrawal ────────────────────────────────────────────────────

async function runDepositWithdrawal(
  ctx: Pick<OpCtx, "userId" | "dek" | "action" | "bank" | "payeePlain" | "tags">,
  rowVars: { amount: number | null; quantity: number | null; price: number | null },
): Promise<MaterializePortfolioOpResult> {
  const { userId, dek, action, bank } = ctx;
  const counterpartyId = action.counterpartyAccountId!; // validated non-null

  const counterparty = await db
    .select({ id: schema.accounts.id, isInvestment: schema.accounts.isInvestment })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, counterpartyId), eq(schema.accounts.userId, userId)))
    .limit(1);
  if (!counterparty[0]) return fail("counterparty_not_found", "Counterparty account not found.");
  if (counterparty[0].isInvestment) {
    return fail(
      "counterparty_is_investment",
      "Deposit/withdrawal counterparty must be a non-investment (bank) account.",
    );
  }

  const cash = resolveCashAmount(action, rowVars);
  if (!cash.ok) return fail("price_underivable", `Could not derive the amount: ${cash.code}.`);

  // The brokerage cash sleeve (investment side) must exist; create + pass it.
  const sleeve = await resolveOrCreateCashSleeve(userId, dek, action.investmentAccountId, bank.currency);

  if (action.op === "deposit") {
    const r = await recordBrokerageDeposit({
      userId,
      dek,
      sourceAccountId: counterpartyId,
      destAccountId: action.investmentAccountId,
      destCashSleeveHoldingId: sleeve.id,
      amount: cash.amount,
      date: bank.date,
      payee: ctx.payeePlain,
      tags: ctx.tags,
      source: "reconcile_link",
    });
    const linkedTransactionId =
      bank.accountId === action.investmentAccountId ? r.destTxId : r.sourceTxId;
    await stampLineage(userId, linkedTransactionId, bank.id);
    return { ok: true, op: "deposit", transactionIds: [r.sourceTxId, r.destTxId], linkedTransactionId };
  }

  const r = await recordBrokerageWithdrawal({
    userId,
    dek,
    sourceAccountId: action.investmentAccountId,
    sourceCashSleeveHoldingId: sleeve.id,
    destAccountId: counterpartyId,
    amount: cash.amount,
    date: bank.date,
    payee: ctx.payeePlain,
    tags: ctx.tags,
    source: "reconcile_link",
  });
  const linkedTransactionId =
    bank.accountId === action.investmentAccountId ? r.sourceTxId : r.destTxId;
  await stampLineage(userId, linkedTransactionId, bank.id);
  return { ok: true, op: "withdrawal", transactionIds: [r.sourceTxId, r.destTxId], linkedTransactionId };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchNonCashHolding(
  userId: string,
  holdingId: number,
): Promise<{ id: number; currency: string } | null> {
  const row = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
      isCash: schema.portfolioHoldings.isCash,
    })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.id, holdingId),
        eq(schema.portfolioHoldings.userId, userId),
      ),
    )
    .limit(1);
  const r = row[0];
  if (!r || r.isCash) return null;
  return { id: r.id, currency: r.currency };
}

async function stampLineage(
  userId: string,
  transactionId: number,
  bankTransactionId: string,
): Promise<void> {
  await linkTransactionToBank({
    userId,
    transactionId,
    bankTransactionId,
    linkType: "primary",
    source: "reconcile_link",
  });
}

function mapOpError(err: unknown): MaterializePortfolioOpResult {
  if (err instanceof CurrencyMismatchError) return fail("currency_mismatch", err.message);
  if (err instanceof CashSleeveNotFoundError) return fail("op_failed", err.message);
  if (err instanceof HoldingNotFoundError) return fail("holding_not_found", err.message);
  const message = err instanceof Error ? err.message : String(err);
  return fail("op_failed", message);
}

/**
 * Tier-aware decrypt for an encrypted-in-place text column on
 * `bank_transactions` (payee / ticker / security_name). Mirrors
 * `bank-ledger-pool.ts decryptBankField` — null on auth-tag failure / no DEK,
 * never raw ciphertext.
 */
function decodeBankString(
  tier: string | null,
  dek: Buffer,
  value: string | null,
): string | null {
  if (value == null || value === "") return null;
  if ((tier ?? "user") === "user") {
    return tryDecryptField(dek, value, "bank_transactions");
  }
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}

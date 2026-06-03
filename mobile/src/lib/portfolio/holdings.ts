// Pure portfolio selectors — replicate the web op-forms' client-side account /
// holding / cash-sleeve detection so the mobile OperationFormScreen can gate
// fields + the cash-sleeve prerequisite without a server round-trip. JSX-free
// and unit-testable.
import type {
  AccountBalance,
  PortfolioHoldingRow,
  EnrichedHolding,
} from "../../../../shared/types";

const METALS = new Set(["XAU", "XAG", "XPT", "XPD"]);

/**
 * Canonical key for an enriched per-account holding — mirrors the web
 * /api/portfolio/overview `canonicalKey()` so the overview list can pool the
 * per-account rows into the same `byHolding` rows the server returns, and the
 * holding-detail screen can recover a byHolding row's member accounts.
 */
export function canonicalKeyOf(h: EnrichedHolding): string {
  const sym = (h.symbol ?? "").toUpperCase();
  if (h.assetType === "crypto" && sym) return `crypto:${sym}`;
  if ((h.assetType === "stock" || h.assetType === "etf") && sym) return `eq:${sym}`;
  if (h.assetType === "cash") {
    if (sym) return METALS.has(sym) ? `metal:${sym}` : `cash:${sym}`;
    return `cash:${(h.currency ?? "").toUpperCase()}`;
  }
  return `custom:${(h.name ?? "?").trim().toLowerCase()}`;
}

/** Investment accounts (the only ones that can hold portfolio operations). */
export function investmentAccounts(balances: AccountBalance[]): AccountBalance[] {
  return balances.filter((b) => b.isInvestment === true);
}

/** Non-investment accounts — the bank side of a Brokerage Deposit/Withdrawal. */
export function nonInvestmentAccounts(balances: AccountBalance[]): AccountBalance[] {
  return balances.filter((b) => b.isInvestment !== true);
}

/** Non-cash holdings in an account (the "holding to buy/sell" picker source). */
export function accountHoldings(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined
): PortfolioHoldingRow[] {
  if (accountId == null) return [];
  return holdings.filter((h) => h.accountId === accountId && !h.isCash);
}

/** Cash sleeves (is_cash=true) provisioned in an account. */
export function cashSleeves(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined
): PortfolioHoldingRow[] {
  if (accountId == null) return [];
  return holdings.filter((h) => h.accountId === accountId && h.isCash === true);
}

/** Find the cash sleeve for (account, currency); null if not yet provisioned. */
export function findCashSleeve(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined,
  currency: string | null | undefined
): PortfolioHoldingRow | null {
  if (accountId == null || !currency) return null;
  const ccy = currency.toUpperCase();
  return (
    holdings.find(
      (h) =>
        h.accountId === accountId &&
        h.isCash === true &&
        (h.currency ?? "").toUpperCase() === ccy
    ) ?? null
  );
}

/** Distinct sleeve currencies in an account (powers FX From/To currency pickers). */
export function sleeveCurrencies(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined
): string[] {
  const seen = new Set<string>();
  for (const h of cashSleeves(holdings, accountId)) {
    const c = (h.currency ?? "").toUpperCase();
    if (c) seen.add(c);
  }
  return Array.from(seen).sort();
}

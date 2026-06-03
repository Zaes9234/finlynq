import {
  investmentAccounts,
  nonInvestmentAccounts,
  accountHoldings,
  cashSleeves,
  findCashSleeve,
  sleeveCurrencies,
  canonicalKeyOf,
} from "../lib/portfolio/holdings";
import type { AccountBalance, PortfolioHoldingRow, EnrichedHolding } from "../../../shared/types";

function acc(p: Partial<AccountBalance> & { accountId: number }): AccountBalance {
  return {
    accountName: `Acct ${p.accountId}`,
    accountType: "A",
    accountGroup: "Investments",
    currency: "CAD",
    balance: 0,
    convertedBalance: 0,
    displayCurrency: "CAD",
    ...p,
  };
}

function hold(p: Partial<PortfolioHoldingRow> & { id: number }): PortfolioHoldingRow {
  return {
    accountId: 1,
    name: `H${p.id}`,
    symbol: null,
    currency: "USD",
    isCrypto: 0,
    isCash: false,
    note: "",
    currentShares: 0,
    accountName: "Acct",
    ...p,
  };
}

function enriched(p: Partial<EnrichedHolding>): EnrichedHolding {
  return {
    id: 1,
    accountId: 1,
    accountName: "Acct",
    name: "Name",
    symbol: null,
    currency: "USD",
    assetType: "stock",
    price: null,
    change: null,
    changePct: null,
    quoteCurrency: null,
    marketCap: null,
    image: null,
    quantity: null,
    avgCostPerShare: null,
    totalCostBasis: null,
    lifetimeCostBasis: null,
    marketValue: null,
    marketValueDisplay: null,
    unrealizedGain: null,
    unrealizedGainPct: null,
    unrealizedGainDisplay: null,
    realizedGain: null,
    dividendsReceived: null,
    totalReturn: null,
    totalReturnDisplay: null,
    totalReturnPct: null,
    firstPurchaseDate: null,
    daysHeld: null,
    pctOfPortfolio: null,
    ...p,
  };
}

const accounts: AccountBalance[] = [
  acc({ accountId: 1, isInvestment: true }),
  acc({ accountId: 2, isInvestment: false }),
  acc({ accountId: 3, isInvestment: true }),
];

const holdings: PortfolioHoldingRow[] = [
  hold({ id: 10, accountId: 1, symbol: "NVDA", currency: "USD" }),
  hold({ id: 11, accountId: 1, isCash: true, currency: "USD" }),
  hold({ id: 12, accountId: 1, isCash: true, currency: "CAD" }),
  hold({ id: 13, accountId: 3, symbol: "VFV", currency: "CAD" }),
];

describe("account selectors", () => {
  it("splits investment vs non-investment accounts", () => {
    expect(investmentAccounts(accounts).map((a) => a.accountId)).toEqual([1, 3]);
    expect(nonInvestmentAccounts(accounts).map((a) => a.accountId)).toEqual([2]);
  });
});

describe("holding selectors", () => {
  it("accountHoldings excludes cash sleeves + scopes by account", () => {
    expect(accountHoldings(holdings, 1).map((h) => h.id)).toEqual([10]);
    expect(accountHoldings(holdings, null)).toEqual([]);
  });

  it("cashSleeves returns only is_cash rows for the account", () => {
    expect(cashSleeves(holdings, 1).map((h) => h.id)).toEqual([11, 12]);
  });

  it("findCashSleeve matches currency case-insensitively", () => {
    expect(findCashSleeve(holdings, 1, "usd")?.id).toBe(11);
    expect(findCashSleeve(holdings, 1, "EUR")).toBeNull();
    expect(findCashSleeve(holdings, 99, "USD")).toBeNull();
  });

  it("sleeveCurrencies returns distinct sorted currencies", () => {
    expect(sleeveCurrencies(holdings, 1)).toEqual(["CAD", "USD"]);
    expect(sleeveCurrencies(holdings, 3)).toEqual([]);
  });
});

describe("canonicalKeyOf", () => {
  it("keys equities by uppercased symbol", () => {
    expect(canonicalKeyOf(enriched({ assetType: "stock", symbol: "nvda" }))).toBe("eq:NVDA");
    expect(canonicalKeyOf(enriched({ assetType: "etf", symbol: "vfv" }))).toBe("eq:VFV");
  });
  it("keys crypto distinctly", () => {
    expect(canonicalKeyOf(enriched({ assetType: "crypto", symbol: "btc" }))).toBe("crypto:BTC");
  });
  it("keys cash by symbol/currency, metals separately", () => {
    expect(canonicalKeyOf(enriched({ assetType: "cash", symbol: "USD" }))).toBe("cash:USD");
    expect(canonicalKeyOf(enriched({ assetType: "cash", symbol: null, currency: "cad" }))).toBe("cash:CAD");
    expect(canonicalKeyOf(enriched({ assetType: "cash", symbol: "XAU" }))).toBe("metal:XAU");
  });
  it("falls back to a lowercased name key", () => {
    expect(canonicalKeyOf(enriched({ assetType: "stock", symbol: null, name: "My Thing" }))).toBe(
      "custom:my thing"
    );
  });
});

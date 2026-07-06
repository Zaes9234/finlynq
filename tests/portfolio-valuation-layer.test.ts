/**
 * FINLYNQ-268 Phase 0 — shared valuation layer (`src/lib/portfolio/valuation.ts`).
 *
 * Pure(-ish) unit tests: mock the composed pricing paths
 * (`getHoldingsValueByHolding`, `aggregateHoldings`, `@/db`) and assert
 * `valuePortfolio` returns the right value + basis + asOf + warnings for each of
 * the four bases, the DEK-null → active_cost fallback + warning, the
 * all-unpriced → active_cost fallback, and the `weightBasis` guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// getHoldingsValueByHolding — return per-holding market value + costBasis + isCash.
type HV = { holdingId: number; accountId: number; name: string | null; symbol: string | null; isCash: boolean; value: number; costBasis: number; currency: string };
let holdingRows: HV[] = [];
const getHoldingsValueByHolding = vi.fn(async () => holdingRows);
vi.mock("../src/lib/holdings-value", () => ({
  getHoldingsValueByHolding: (...a: unknown[]) => getHoldingsValueByHolding(...(a as [])),
}));

// aggregateHoldings — lifetime buy_amount per holding.
let aggRows: Array<Record<string, unknown>> = [];
const aggregateHoldings = vi.fn(async () => aggRows);
vi.mock("../src/lib/portfolio/aggregate-holdings", () => ({
  aggregateHoldings: (...a: unknown[]) => aggregateHoldings(...(a as [])),
}));

// @/db — only db.execute is used (ledger branch).
let ledgerRows: Array<Record<string, unknown>> = [];
vi.mock("../src/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: ledgerRows })) },
  schema: {},
}));

import { valuePortfolio, weightBasis, type PortfolioValuation } from "../src/lib/portfolio/valuation";

const DEK = randomBytes(32);
const today = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  holdingRows = [];
  aggRows = [];
  ledgerRows = [];
  getHoldingsValueByHolding.mockClear();
  aggregateHoldings.mockClear();
});

describe("valuePortfolio — market basis", () => {
  it("prices at market with a DEK and stamps asOf = today", async () => {
    holdingRows = [
      { holdingId: 1, accountId: 10, name: "VOO", symbol: "VOO", isCash: false, value: 1000, costBasis: 700, currency: "USD" },
      { holdingId: 2, accountId: 10, name: "Cash USD", symbol: null, isCash: true, value: 250, costBasis: 250, currency: "USD" },
    ];
    const v = await valuePortfolio("u", DEK, { basis: "market" });
    expect(v.basis).toBe("market");
    expect(v.requestedBasis).toBe("market");
    expect(v.asOf).toBe(today);
    expect(v.warnings).toBeUndefined();
    expect(v.byHolding.map((h) => h.value)).toEqual([1000, 250]);
    expect(v.byHolding[1].isCash).toBe(true);
  });

  it("DEK-null → active_cost fallback + warning; NEVER prices", async () => {
    holdingRows = [
      { holdingId: 1, accountId: 10, name: null, symbol: null, isCash: false, value: 0, costBasis: 700, currency: "USD" },
    ];
    const v = await valuePortfolio("u", null, { basis: "market" });
    expect(v.basis).toBe("active_cost");
    expect(v.requestedBasis).toBe("market");
    expect(v.asOf).toBeUndefined();
    expect(v.warnings?.[0]).toMatch(/market unavailable/i);
    // active_cost uses costBasis, not value
    expect(v.byHolding[0].value).toBe(700);
  });

  it("all-unpriced (every value 0) with a DEK → active_cost fallback + warning", async () => {
    holdingRows = [
      { holdingId: 1, accountId: 10, name: "X", symbol: "X", isCash: false, value: 0, costBasis: 500, currency: "USD" },
    ];
    const v = await valuePortfolio("u", DEK, { basis: "market" });
    expect(v.basis).toBe("active_cost");
    expect(v.warnings?.[0]).toMatch(/market unavailable/i);
    expect(v.byHolding[0].value).toBe(500);
  });
});

describe("valuePortfolio — active_cost basis", () => {
  it("uses costBasis, always available, no asOf/warning", async () => {
    holdingRows = [
      { holdingId: 1, accountId: 10, name: "X", symbol: "X", isCash: false, value: 1000, costBasis: 640, currency: "USD" },
    ];
    const v = await valuePortfolio("u", DEK, { basis: "active_cost" });
    expect(v.basis).toBe("active_cost");
    expect(v.asOf).toBeUndefined();
    expect(v.warnings).toBeUndefined();
    expect(v.byHolding[0].value).toBe(640);
  });
});

describe("valuePortfolio — lifetime_cost basis", () => {
  it("uses aggregateHoldings().buy_amount", async () => {
    aggRows = [
      { holding_id: 1, name: "VOO", buy_amount: 3200, currency: "USD" },
      { holding_id: null, name: "orphan", buy_amount: 99, currency: "USD" },
    ];
    const v = await valuePortfolio("u", DEK, { basis: "lifetime_cost" });
    expect(v.basis).toBe("lifetime_cost");
    expect(v.asOf).toBeUndefined();
    expect(v.byHolding).toHaveLength(1); // null holding_id dropped
    expect(v.byHolding[0].value).toBe(3200);
  });
});

describe("valuePortfolio — ledger basis", () => {
  it("uses SUM(transactions.amount) net contribution per holding", async () => {
    ledgerRows = [
      { holding_id: 1, account_id: 10, currency: "USD", net: -1500 },
      { holding_id: 2, account_id: 10, currency: "USD", net: 300 },
    ];
    const v = await valuePortfolio("u", DEK, { basis: "ledger" });
    expect(v.basis).toBe("ledger");
    expect(v.asOf).toBeUndefined();
    expect(v.byHolding.map((h) => h.value)).toEqual([-1500, 300]);
  });
});

describe("weightBasis guard (tc-2)", () => {
  it("returns 'market' for a market valuation", () => {
    expect(weightBasis({ basis: "market" } as PortfolioValuation)).toBe("market");
  });
  it("returns 'active_cost' for an active_cost valuation", () => {
    expect(weightBasis({ basis: "active_cost" } as PortfolioValuation)).toBe("active_cost");
  });
  it("THROWS (dev) when handed a lifetime_cost valuation", () => {
    expect(() => weightBasis({ basis: "lifetime_cost" } as PortfolioValuation)).toThrow(/never lifetime_cost/i);
  });
  it("THROWS (dev) when handed a ledger valuation", () => {
    expect(() => weightBasis({ basis: "ledger" } as PortfolioValuation)).toThrow();
  });
});

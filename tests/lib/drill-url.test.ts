/**
 * Unit tests for `buildTxDrillUrl` (FINLYNQ-130).
 *
 * Drill-through links across the app (dashboard tiles, budget rows, reports
 * category rows, portfolio holdings) build their `/transactions?...` href
 * through this single helper. These tests pin the exact URL shape the
 * transactions page reads back via `urlParams.get(...)`.
 */
import { describe, it, expect } from "vitest";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";

describe("buildTxDrillUrl (FINLYNQ-130)", () => {
  it("returns /transactions with no trailing ? when no filters are set", () => {
    expect(buildTxDrillUrl({})).toBe("/transactions");
  });

  it("appends only non-empty filter values, no dangling empty keys", () => {
    expect(buildTxDrillUrl({ categoryId: "5", startDate: "2026-01-01" })).toBe(
      "/transactions?categoryId=5&startDate=2026-01-01",
    );
  });

  it("skips empty-string and undefined values", () => {
    expect(
      buildTxDrillUrl({ categoryId: "5", startDate: "", endDate: undefined, accountId: "" }),
    ).toBe("/transactions?categoryId=5");
  });

  it("emits keys in the caller's insertion order", () => {
    expect(
      buildTxDrillUrl({ endDate: "2026-01-31", startDate: "2026-01-01" }),
    ).toBe("/transactions?endDate=2026-01-31&startDate=2026-01-01");
  });

  it("ignores keys that are not recognised TxFilters params", () => {
    // @ts-expect-error — exercise the runtime allow-list guard
    expect(buildTxDrillUrl({ categoryId: "5", bogus: "x" })).toBe(
      "/transactions?categoryId=5",
    );
  });

  it("URL-encodes values that need it (e.g. portfolioHolding with spaces)", () => {
    expect(buildTxDrillUrl({ portfolioHolding: "Apple Inc" })).toBe(
      "/transactions?portfolioHolding=Apple+Inc",
    );
  });

  // FINLYNQ-177 — first-class single-transaction id deep link. The new `id`
  // key must be in ALLOWED_KEYS so every "go to this one transaction" link
  // (audit Edit affordance, the 5 portfolio-form dependent-row links, the
  // delete-dialog dependent-row links) builds its href through this helper.
  it("emits the single-transaction id key (FINLYNQ-177)", () => {
    expect(buildTxDrillUrl({ id: "42" })).toBe("/transactions?id=42");
  });

  it("emits id first, before other recognised filters", () => {
    expect(buildTxDrillUrl({ id: "42", categoryId: "5" })).toBe(
      "/transactions?id=42&categoryId=5",
    );
  });
});

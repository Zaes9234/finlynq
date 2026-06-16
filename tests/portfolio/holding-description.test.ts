import { describe, it, expect } from "vitest";
import { holdingDescription } from "@/app/(app)/portfolio/_components/holding-description";

describe("holdingDescription (FINLYNQ-174)", () => {
  it("prefers the quote long-name when it is distinct from the symbol", () => {
    expect(
      holdingDescription({ quoteName: "Apple Inc.", name: "AAPL", symbol: "AAPL" }),
    ).toBe("Apple Inc.");
  });

  it("falls back to the stored name when there is no quote name", () => {
    expect(
      holdingDescription({ quoteName: null, name: "My Custom Fund", symbol: null }),
    ).toBe("My Custom Fund");
  });

  it("returns null when the quote name merely echoes the ticker code", () => {
    // The price cache returns symbol-as-name on a warm-cache hit.
    expect(
      holdingDescription({ quoteName: "TPU.TO", name: "TPU.TO", symbol: "TPU.TO" }),
    ).toBeNull();
  });

  it("ignores case + whitespace when comparing to the symbol", () => {
    expect(
      holdingDescription({ quoteName: "  aapl  ", name: null, symbol: "AAPL" }),
    ).toBeNull();
  });

  it("returns null for a cash sleeve (name mirrors the currency symbol)", () => {
    expect(
      holdingDescription({ quoteName: null, name: "USD", symbol: "USD" }),
    ).toBeNull();
  });

  it("returns null for a metal sleeve with no quote description", () => {
    expect(
      holdingDescription({ quoteName: null, name: "XAU", symbol: "XAU" }),
    ).toBeNull();
  });

  it("defends against all-null inputs without throwing", () => {
    expect(
      holdingDescription({ quoteName: null, name: null, symbol: null }),
    ).toBeNull();
    expect(holdingDescription({})).toBeNull();
  });

  it("uses the stored name when it differs from the symbol and there is no quote name", () => {
    expect(
      holdingDescription({ quoteName: null, name: "Vanguard S&P 500", symbol: "VOO" }),
    ).toBe("Vanguard S&P 500");
  });

  it("prefers a real quote name over a stored name that mirrors the symbol", () => {
    expect(
      holdingDescription({ quoteName: "Tesla, Inc.", name: "TSLA", symbol: "TSLA" }),
    ).toBe("Tesla, Inc.");
  });
});

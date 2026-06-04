import { describe, it, expect } from "vitest";
import { splitCryptoCacheHits, bucketDailyCryptoPrices } from "@/lib/crypto-service";

// Helper: midday-UTC epoch ms for a YYYY-MM-DD date (so bucketing lands on the
// intended calendar day regardless of the runner's local timezone — the impl
// keys on the UTC date string).
const at = (date: string, hour = 12) => Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);

// Fix #1B (crypto-price-caching plan) — cache-first valuation for crypto.
// `splitCryptoCacheHits` is the pure core that decides which requested coins
// come from today's price_cache (hits) vs need a live CoinGecko fetch (misses).
// The DB read + live fetch around it are thin orchestration; this is where the
// dedup / upper-casing / cache-key-format logic that could silently re-fetch or
// mis-key lives, so it's the part worth pinning down.
describe("splitCryptoCacheHits", () => {
  it("routes cached coins to hits and uncached coins to misses", () => {
    const { hits, misses } = splitCryptoCacheHits(
      [
        { coinId: "bitcoin", symbol: "BTC" },
        { coinId: "ethereum", symbol: "ETH" },
      ],
      new Set(["CRYPTO:BTC"]),
    );
    expect(hits).toEqual([{ coinId: "bitcoin", symbol: "BTC" }]);
    expect(misses).toEqual([{ coinId: "ethereum", symbol: "ETH" }]);
  });

  it("normalizes symbols to upper-case before matching the CRYPTO: cache key", () => {
    // Caller passes a lower-case symbol; cache key is always upper-cased
    // (cacheCryptoPrice stores CRYPTO:<UPPER>). A hit must still resolve.
    const { hits, misses } = splitCryptoCacheHits(
      [{ coinId: "solana", symbol: "sol" }],
      new Set(["CRYPTO:SOL"]),
    );
    expect(hits).toEqual([{ coinId: "solana", symbol: "SOL" }]);
    expect(misses).toEqual([]);
  });

  it("de-dupes by coinId, keeping the first symbol seen", () => {
    // Two holdings of the same coin (e.g. BTC in two accounts) collapse to one
    // lookup so we never fetch/return the same coin twice.
    const { hits, misses } = splitCryptoCacheHits(
      [
        { coinId: "bitcoin", symbol: "BTC" },
        { coinId: "bitcoin", symbol: "BTC" },
      ],
      new Set<string>(),
    );
    expect(hits).toEqual([]);
    expect(misses).toEqual([{ coinId: "bitcoin", symbol: "BTC" }]);
  });

  it("skips entries with an empty coinId or symbol", () => {
    const { hits, misses } = splitCryptoCacheHits(
      [
        { coinId: "", symbol: "BTC" },
        { coinId: "ethereum", symbol: "" },
        { coinId: "cardano", symbol: "ADA" },
      ],
      new Set<string>(),
    );
    expect(hits).toEqual([]);
    expect(misses).toEqual([{ coinId: "cardano", symbol: "ADA" }]);
  });

  it("returns empty hits and misses for no input", () => {
    expect(splitCryptoCacheHits([], new Set<string>())).toEqual({ hits: [], misses: [] });
  });
});

// Fix #2 (historical crypto pricing) — bucketDailyCryptoPrices collapses
// CoinGecko's market_chart [ms, price] series into one price per past calendar
// day. This is the load-bearing parse step: it decides which days get cached and
// crucially never writes "today" (the live spot path owns today's row).
describe("bucketDailyCryptoPrices", () => {
  const TODAY = "2026-06-02";

  it("keeps the LAST price seen for each day (≈ that day's close)", () => {
    const out = bucketDailyCryptoPrices(
      [
        [at("2026-05-30", 9), 100],
        [at("2026-05-30", 15), 110], // later same-day point wins
        [at("2026-05-31", 12), 120],
      ],
      TODAY,
    );
    expect(out.get("2026-05-30")).toBe(110);
    expect(out.get("2026-05-31")).toBe(120);
    expect(out.size).toBe(2);
  });

  it("skips today and any future date (live path owns today)", () => {
    const out = bucketDailyCryptoPrices(
      [
        [at("2026-06-01", 12), 200],
        [at(TODAY, 1), 210], // today — excluded
        [at("2026-06-03", 12), 220], // future — excluded
      ],
      TODAY,
    );
    expect(out.has(TODAY)).toBe(false);
    expect(out.has("2026-06-03")).toBe(false);
    expect(out.get("2026-06-01")).toBe(200);
    expect(out.size).toBe(1);
  });

  it("skips malformed points without throwing", () => {
    const out = bucketDailyCryptoPrices(
      [
        [at("2026-05-29", 12), 90],
        // @ts-expect-error -- exercise defensive guards against bad shapes
        [null, 5],
        // @ts-expect-error -- exercise defensive guards against bad shapes
        ["x", "y"],
        // @ts-expect-error -- exercise defensive guards against bad shapes
        undefined,
      ],
      TODAY,
    );
    expect(out.get("2026-05-29")).toBe(90);
    expect(out.size).toBe(1);
  });

  it("returns an empty map for no prices", () => {
    expect(bucketDailyCryptoPrices([], TODAY).size).toBe(0);
  });
});

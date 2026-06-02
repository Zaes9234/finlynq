import { describe, it, expect } from "vitest";
import { splitCryptoCacheHits } from "@/lib/crypto-service";

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

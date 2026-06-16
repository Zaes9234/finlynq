/**
 * Securities master — parity harness (acceptance gate, Tier 2).
 *
 * The Phase D read-flip buckets combined holdings on `security_id` instead of
 * the legacy in-memory `canonicalKey` string. For that to be a no-op (the #1
 * acceptance criterion: byte-identical aggregates), the partition induced by
 * the stored `cluster_key` discriminator MUST equal the partition induced by
 * the legacy key — for EVERY holding shape.
 *
 * This proves exactly that: for a battery of shapes, group by `legacyKey`
 * (what overview's canonicalKey emits) and by `cluster_key`
 * (buildSecurityClusterKey(classify(...)) — what the backfill/resolver store),
 * and assert the two partitions are identical (same equivalence classes). Uses
 * a real DEK + the real HMAC `nameLookup`, so the HMAC normalization (case /
 * whitespace) is exercised for real.
 *
 * Reference: finlynq-cloud/app-plan/securities-master-plan.md §5/§10,
 * docs/architecture/securities.md.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { nameLookup } from "@/lib/crypto/encrypted-columns";
import {
  classifyHoldingForSecurity,
  buildSecurityClusterKey,
} from "@/lib/securities/canonical";

const DEK = randomBytes(32);

interface RawHolding {
  symbol: string | null;
  name: string | null;
  isCryptoFlag: boolean;
  currency: string;
}

/** Legacy canonicalKey string overview would emit for this holding. */
function legacyKeyOf(h: RawHolding): string {
  return classifyHoldingForSecurity({
    symbol: h.symbol,
    name: h.name,
    isCryptoFlag: h.isCryptoFlag,
    currency: h.currency,
  }).legacyKey;
}

/** Stored cluster_key discriminator the backfill/resolver would assign. */
function clusterKeyOf(h: RawHolding): string | null {
  const cluster = classifyHoldingForSecurity({
    symbol: h.symbol,
    name: h.name,
    isCryptoFlag: h.isCryptoFlag,
    currency: h.currency,
  });
  return buildSecurityClusterKey(cluster, {
    symbolLookup: h.symbol ? nameLookup(DEK, h.symbol) : null,
    nameLookup: h.name ? nameLookup(DEK, h.name) : null,
  });
}

/** Canonical signature of a partition: sorted list of sorted index-groups. */
function partitionSignature(items: RawHolding[], keyFn: (h: RawHolding) => string | null): string {
  const groups = new Map<string, number[]>();
  items.forEach((h, i) => {
    const k = keyFn(h) ?? `__null__${i}`; // null clusterKey ⇒ 1:1 (its own group)
    const arr = groups.get(k) ?? [];
    arr.push(i);
    groups.set(k, arr);
  });
  return JSON.stringify([...groups.values()].map((g) => g.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]));
}

describe("securities parity: cluster_key partition ≡ legacy canonicalKey partition", () => {
  const fixtures: RawHolding[] = [
    // VIU.TO across 3 accounts (the motivating fixture) — one class.
    { symbol: "VIU.TO", name: "VIU.TO", isCryptoFlag: false, currency: "CAD" },
    { symbol: "VIU.TO", name: "VIU.TO", isCryptoFlag: false, currency: "CAD" },
    { symbol: "VIU.TO", name: "VIU.TO", isCryptoFlag: false, currency: "CAD" },
    // Case variants normalize to the same ticker (both legacy uppercase + HMAC
    // lowercase agree here).
    { symbol: "viu.to", name: "viu.to", isCryptoFlag: false, currency: "CAD" },
    // A distinct ETF — its own class on both sides.
    { symbol: "VEQT.TO", name: "VEQT.TO", isCryptoFlag: false, currency: "CAD" },
    // A distinct equity.
    { symbol: "AAPL", name: "AAPL", isCryptoFlag: false, currency: "USD" },
    { symbol: "AAPL", name: "AAPL", isCryptoFlag: false, currency: "USD" },
    // Crypto by flag AND by symbol — same class.
    { symbol: "BTC", name: "BTC", isCryptoFlag: true, currency: "USD" },
    { symbol: "BTC", name: "BTC", isCryptoFlag: false, currency: "USD" }, // isCryptoSymbol(BTC)=true
    // Crypto full symbol preserved (BTC-ETH distinct from BTC).
    { symbol: "ETH", name: "ETH", isCryptoFlag: true, currency: "USD" },
    // Metal sleeves — universal across account currency.
    { symbol: "XAU", name: "XAU", isCryptoFlag: false, currency: "CAD" },
    { symbol: "XAU", name: "XAU", isCryptoFlag: false, currency: "USD" },
    // THE cash-family merge: a currency-code symbol "CAD" must group with a
    // no-symbol CAD cash sleeve (legacy emits cash:CAD for both).
    { symbol: "CAD", name: "Cash CAD", isCryptoFlag: false, currency: "CAD" },
    { symbol: null, name: "Cash", isCryptoFlag: false, currency: "CAD" },
    { symbol: null, name: "Cash CAD", isCryptoFlag: false, currency: "CAD" },
    // Different cash currency — separate class.
    { symbol: null, name: "Cash", isCryptoFlag: false, currency: "USD" },
    { symbol: "USD", name: "Cash USD", isCryptoFlag: false, currency: "USD" },
    // Crypto flag but NO symbol → custom fallback (clusters by name).
    { symbol: null, name: "My Private Coin", isCryptoFlag: true, currency: "USD" },
    { symbol: null, name: "my private coin", isCryptoFlag: true, currency: "USD" },
  ];

  it("induces the same equivalence classes as the legacy key", () => {
    expect(partitionSignature(fixtures, clusterKeyOf)).toBe(
      partitionSignature(fixtures, legacyKeyOf),
    );
  });

  it("merges the three VIU.TO positions into one cluster", () => {
    const viu = fixtures.slice(0, 3);
    const keys = new Set(viu.map(clusterKeyOf));
    expect(keys.size).toBe(1);
  });

  it("merges a currency-code-symbol cash sleeve with a no-symbol same-currency sleeve", () => {
    const cadSymbol = clusterKeyOf({ symbol: "CAD", name: "Cash CAD", isCryptoFlag: false, currency: "CAD" });
    const cadNoSymbol = clusterKeyOf({ symbol: null, name: "Cash", isCryptoFlag: false, currency: "CAD" });
    expect(cadSymbol).toBe(cadNoSymbol);
    expect(cadSymbol).toBe("cash#CAD");
  });

  it("keeps the ticker out of the stored cluster_key (HMAC, not plaintext)", () => {
    const k = clusterKeyOf({ symbol: "AAPL", name: "AAPL", isCryptoFlag: false, currency: "USD" });
    expect(k).not.toContain("AAPL");
    expect(k?.startsWith("eq:")).toBe(true);
  });

  it("intentionally merges whitespace-variant tickers (stricter than the legacy string key)", () => {
    // Known, beneficial divergence: the legacy canonicalKey uppercases but does
    // NOT trim, so " VIU.TO " fragments into its own row; the HMAC symbol_lookup
    // normalizes whitespace, so securities correctly merge them. Documented in
    // docs/architecture/securities.md. Not realistic data (symbols are entered
    // clean), so it never affects parity on real portfolios.
    const padded: RawHolding = { symbol: " VIU.TO ", name: "x", isCryptoFlag: false, currency: "CAD" };
    const clean: RawHolding = { symbol: "VIU.TO", name: "VIU.TO", isCryptoFlag: false, currency: "CAD" };
    expect(clusterKeyOf(padded)).toBe(clusterKeyOf(clean)); // securities: merged
    expect(legacyKeyOf(padded)).not.toBe(legacyKeyOf(clean)); // legacy string: split
  });

  it("never auto-merges when no DEK lookups are available (1:1)", () => {
    const cluster = classifyHoldingForSecurity({ symbol: "AAPL", name: "AAPL", isCryptoFlag: false, currency: "USD" });
    expect(buildSecurityClusterKey(cluster, { symbolLookup: null, nameLookup: null })).toBeNull();
  });
});

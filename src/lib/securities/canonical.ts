/**
 * Securities master — canonical clustering (single source of truth).
 *
 * This module owns the rule that decides "which security does a position
 * belong to". It is a verbatim port of the legacy in-memory `canonicalKey`
 * in /api/portfolio/overview (the string the All-Holdings table groups on),
 * extracted so the read aggregators, the write-side find-or-create resolver,
 * and the login-time backfill all compute the SAME partition by construction.
 * If this function and overview's grouping ever diverged, the parity gate
 * (scripts/verify-securities-parity.ts) would catch it.
 *
 * Two outputs per holding:
 *   - `legacyKey`  — the exact canonicalKey string ("eq:VIU.TO", "cash:CAD",
 *     "crypto:BTC", …). Used by the read-flip fallback and the parity harness.
 *   - cluster shape (`kind` + `symbolUpper` / `currencyCode` / display name) —
 *     the inputs the DEK-bearing caller turns into a privacy-preserving
 *     `cluster_key` discriminator via {@link buildSecurityClusterKey}.
 *
 * Pure + DEK-free: callers compute the HMAC `symbol_lookup` / `name_lookup`
 * (which need the DEK) and pass them to `buildSecurityClusterKey`.
 * → plan/architecture/securities.md
 */

import { isCryptoSymbol, isCurrencyCodeSymbol, isMetalCurrency } from "@/lib/fx/supported-currencies";

/** The legacy assetType union as derived in overview/route.ts (line ~519). */
export type CanonicalAssetType = "etf" | "stock" | "crypto" | "cash";

/** Cluster bucket. `eq` covers stock + etf (the legacy key does not split
 *  them); `metal` is XAU/XAG/XPT/XPD cash sleeves; `custom` is the symbol-less
 *  non-cash fallback. */
export type SecurityClusterKind = "crypto" | "eq" | "metal" | "cash" | "custom";

/** Display asset_type stored on the `securities` row (cosmetic). */
const KIND_TO_ASSET_TYPE: Record<SecurityClusterKind, string> = {
  crypto: "crypto",
  eq: "stock",
  metal: "metal",
  cash: "cash",
  custom: "custom",
};

export interface SecurityCluster {
  kind: SecurityClusterKind;
  /** Exact legacy canonicalKey string (for read-flip fallback + parity). */
  legacyKey: string;
  /** Uppercased ticker, for crypto/eq/metal clusters. null otherwise. */
  symbolUpper: string | null;
  /** Currency code, for the cash bucket (`cash:<CCY>`). null otherwise. */
  currencyCode: string | null;
  /** Human display name the legacy key carried ("VIU.TO", "Cash CAD", …). */
  displayName: string;
  /** Cosmetic asset_type for the securities row. */
  assetType: string;
}

/**
 * The verbatim canonicalKey branch logic, taking the ALREADY-derived
 * `assetType` (so overview can delegate to it without changing its own
 * assetType derivation). etf and stock both map to the `eq:` bucket.
 */
export function clusterFromAssetType(h: {
  assetType: CanonicalAssetType;
  symbol: string | null;
  currency: string;
  name: string | null;
}): SecurityCluster {
  if (h.assetType === "crypto" && h.symbol) {
    const sym = h.symbol.toUpperCase();
    return { kind: "crypto", legacyKey: `crypto:${sym}`, symbolUpper: sym, currencyCode: null, displayName: sym, assetType: KIND_TO_ASSET_TYPE.crypto };
  }
  if (h.assetType === "stock" || h.assetType === "etf") {
    if (h.symbol) {
      const sym = h.symbol.toUpperCase();
      return { kind: "eq", legacyKey: `eq:${sym}`, symbolUpper: sym, currencyCode: null, displayName: sym, assetType: KIND_TO_ASSET_TYPE.eq };
    }
  }
  if (h.assetType === "cash") {
    if (h.symbol) {
      const symU = h.symbol.toUpperCase();
      if (isMetalCurrency(symU)) {
        return { kind: "metal", legacyKey: `metal:${symU}`, symbolUpper: symU, currencyCode: null, displayName: symU, assetType: KIND_TO_ASSET_TYPE.metal };
      }
      return { kind: "cash", legacyKey: `cash:${symU}`, symbolUpper: null, currencyCode: symU, displayName: `Cash ${symU}`, assetType: KIND_TO_ASSET_TYPE.cash };
    }
    const cur = h.currency.toUpperCase();
    return { kind: "cash", legacyKey: `cash:${cur}`, symbolUpper: null, currencyCode: cur, displayName: `Cash ${cur}`, assetType: KIND_TO_ASSET_TYPE.cash };
  }
  const nm = (h.name || "?").trim();
  return { kind: "custom", legacyKey: `custom:${nm.toLowerCase()}`, symbolUpper: null, currencyCode: null, displayName: h.name || "?", assetType: KIND_TO_ASSET_TYPE.custom };
}

/**
 * Derive the cluster straight from a position's raw (decrypted) identity +
 * flags, computing the assetType the SAME way overview does (minus the
 * etf-vs-stock split, which the cluster key ignores). Used by the resolver +
 * backfill, which have raw fields, not a pre-derived assetType.
 *
 * `extraCurrencyCodes` mirrors overview's per-user `active_currencies` setting
 * (those codes count as cash symbols) — pass it for exact parity.
 */
export function classifyHoldingForSecurity(input: {
  symbol: string | null;
  name: string | null;
  isCryptoFlag: boolean;
  currency: string;
  extraCurrencyCodes?: readonly string[];
}): SecurityCluster {
  const { symbol, name, isCryptoFlag, currency, extraCurrencyCodes } = input;
  const isCrypto = isCryptoFlag || (symbol ? isCryptoSymbol(symbol) : false);
  const symIsCash = symbol ? isCurrencyCodeSymbol(symbol, extraCurrencyCodes) : false;
  let assetType: CanonicalAssetType;
  if (isCrypto) assetType = "crypto";
  else if (!symbol || symIsCash) assetType = "cash";
  else assetType = "stock"; // stock|etf — same eq: bucket
  return clusterFromAssetType({ assetType, symbol, currency, name });
}

/**
 * Build the stored, privacy-preserving `cluster_key` discriminator from a
 * cluster + the DEK-derived lookups the caller computed:
 *   - crypto / eq / metal → `<kind>:<symbol_lookup>`   (HMAC — hides the ticker)
 *   - cash                → `cash#<CCY>`               (plaintext currency, non-sensitive)
 *   - custom              → `custom:<name_lookup>`     (HMAC — hides the name)
 *
 * Returns null when the required lookup is unavailable (no DEK), signalling the
 * caller to fall back to a 1:1 per-position key (never auto-merge).
 */
export function buildSecurityClusterKey(
  cluster: SecurityCluster,
  lookups: { symbolLookup: string | null; nameLookup: string | null },
): string | null {
  switch (cluster.kind) {
    case "crypto":
    case "eq":
    case "metal":
      return lookups.symbolLookup ? `${cluster.kind}:${lookups.symbolLookup}` : null;
    case "cash":
      return cluster.currencyCode ? `cash#${cluster.currencyCode}` : null;
    case "custom":
      return lookups.nameLookup ? `custom:${lookups.nameLookup}` : null;
  }
}

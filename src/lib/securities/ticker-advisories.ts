/**
 * Known per-ticker pricing advisories — tickers whose live/historical price
 * data is missing or unreliable from our market-data providers (Yahoo /
 * CoinGecko), paired with the recommended fix.
 *
 * Pure + data-only (no imports), so it can be used from a client component or a
 * server route alike. The registry is intentionally small + hand-curated: a
 * symbol lands here only when we've confirmed the provider can't price it and
 * there's a concrete alternative ticker for the SAME asset.
 *
 * Seeded with POL (Polygon): the network migrated MATIC → POL 1:1 (Sept 2024),
 * but Yahoo carries the price history only under the old `MATIC` ticker —
 * `POL-USD` returns no closes — so a holding tracked as POL can't be priced
 * historically (the snapshot rebuild keeps retrying and failing). The fix is to
 * track it as MATIC, which both CoinGecko and Yahoo fully support.
 */

export interface TickerAdvisory {
  /** The affected ticker (always compared uppercased). */
  symbol: string;
  /** Recommended replacement ticker for the same asset, if any. */
  suggestedSymbol?: string;
  /** One-line, user-facing explanation + the suggested action. */
  message: string;
}

const ADVISORIES: Record<string, TickerAdvisory> = {
  POL: {
    symbol: "POL",
    suggestedSymbol: "MATIC",
    message:
      "Polygon renamed MATIC to POL, but price history is only available under the MATIC ticker — POL prices may be missing or stale. Change this holding's ticker to MATIC (same asset, 1:1) for full pricing.",
  },
};

/** Returns the advisory for a ticker, or null if the ticker is fully supported. */
export function getTickerAdvisory(symbol: string | null | undefined): TickerAdvisory | null {
  if (!symbol) return null;
  return ADVISORIES[symbol.trim().toUpperCase()] ?? null;
}

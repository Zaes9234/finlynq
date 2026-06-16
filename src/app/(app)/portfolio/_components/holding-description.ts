/**
 * Pure resolver for a holding's human-readable description (FINLYNQ-174).
 *
 * The All-Holdings table shows the ticker code (symbol) plus a short
 * description. The descriptive long-name comes from the quote layer
 * (Yahoo `meta.shortName`, surfaced as `quoteName` on the overview payload);
 * the user-stored `name` is the fallback. For most equity rows the stored
 * `name` equals the ticker code, so a description that re-reads `name` would
 * be a no-op — hence the "distinct from the symbol" rule below.
 *
 * Null-defense invariant (CLAUDE.md "String methods on decrypted-name fields
 * must defend against null"): `name` is a decrypted-name field and may be
 * null when the DEK is unavailable. Every input is treated as nullable and
 * this function NEVER throws — it degrades to `null` (the caller renders `--`).
 *
 * Returns:
 *   - a trimmed description string distinct from the ticker code, OR
 *   - `null` when no meaningful description exists (cash sleeves, metals,
 *     custom holdings, or a stored name that just mirrors the symbol).
 */
export function holdingDescription(input: {
  quoteName?: string | null;
  name?: string | null;
  symbol?: string | null;
}): string | null {
  const sym = (input.symbol ?? "").trim().toUpperCase();
  const isMeaningful = (candidate: string | null | undefined): string | null => {
    const trimmed = (candidate ?? "").trim();
    if (!trimmed) return null;
    // A description that just echoes the ticker code adds no information.
    if (sym && trimmed.toUpperCase() === sym) return null;
    return trimmed;
  };
  // Prefer the quote-layer long name; fall back to the user-stored name.
  return isMeaningful(input.quoteName) ?? isMeaningful(input.name);
}

/**
 * Shared SWR configuration + key convention (FINLYNQ-115).
 *
 * Adopting SWR behind the FINLYNQ-111 transactions data hooks introduced a
 * client-side cache + request dedup + stale-while-revalidate. To make sure the
 * request *volume* does NOT get noisier than the pre-115 hand-rolled hooks (test
 * plan tc-2), we deliberately TURN OFF the network-revalidation triggers that
 * SWR enables by default but the old hooks never did:
 *
 *   - `revalidateOnFocus`     → false. The pre-115 hooks fetched on mount + on
 *                               dep change only; they did NOT refetch when the
 *                               window regained focus. Leaving SWR's default
 *                               (`true`) on would add a refetch every tab-switch.
 *   - `revalidateOnReconnect` → false. Same rationale — no network-reconnect
 *                               refetch existed before.
 *   - `revalidateIfStale`     → true (SWR default, kept). On nav-away-and-back
 *                               SWR serves the cached value immediately then
 *                               revalidates once in the background — this is the
 *                               *win* of the item (no full-screen reload flash),
 *                               and it's one request, same as a fresh mount.
 *   - `dedupingInterval`      → 2000ms (SWR default, made explicit). De-dups the
 *                               uncoordinated parallel fetches the old hooks fired
 *                               (e.g. /api/accounts requested by useLookups + any
 *                               other consumer in the same 2s window collapses to
 *                               one request) — strictly fewer requests, never more.
 *   - `shouldRetryOnError`    → false. The pre-115 hooks did NOT retry a failed
 *                               GET (they fell back to a default once). SWR's
 *                               default retries up to 5× with backoff — leaving it
 *                               on would make a failing endpoint noisier than today.
 *
 * These options are passed PER-HOOK (not via a global `<SWRConfig>` provider) so
 * the blast radius of FINLYNQ-115 stays scoped to the transactions hooks — the
 * shared `(app)` layout is untouched and other screens keep their bespoke
 * triplets until FINLYNQ-118 migrates them. New screens that adopt SWR should
 * spread {@link swrListOptions} so the request-volume tuning stays uniform.
 */

import type { SWRConfiguration } from "swr";

/**
 * Behaviour-preserving SWR options for read-list endpoints. Mirrors the
 * pre-115 hooks' "fetch on mount + on dep change, never on focus/reconnect"
 * contract while adding cache + dedup + background revalidation.
 */
export const swrListOptions: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: true,
  shouldRetryOnError: false,
  dedupingInterval: 2000,
  keepPreviousData: true,
};

/**
 * SWR cache-key convention (FINLYNQ-115).
 *
 * Keys are the **request URL string** the fetcher will hit — deterministic,
 * human-readable in the SWR devtools cache, and naturally unique per
 * filter/sort/page combination. For the transactions list the query string is
 * produced by the pure, unit-tested `buildTransactionQuery(...)`
 * (`@/lib/transactions/build-query`), so the cache key changes exactly when the
 * effective request changes — which is precisely when the pre-115 `loadTxns`
 * `useCallback` was re-created and re-fired. The lookups + pref GETs use their
 * static endpoint path as the key.
 *
 * Use {@link swrKey} for the static-path keys so the convention is one call
 * site, and build the transactions-list key as
 * `` `/api/transactions?${buildTransactionQuery(...)}` ``.
 */
export function swrKey(path: string): string {
  return path;
}

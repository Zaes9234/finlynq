# `src/lib/swr` — shared SWR fetcher + key convention (FINLYNQ-115)

This module is the single, documented data-fetching convention for the Finlynq
web app, adopted **behind the FINLYNQ-111 transactions data hooks** (the seam).
It introduces `swr` for client-side caching, request dedup, and
stale-while-revalidate without changing any hook's public signature — so the
components consuming `useTransactions` / `useLookups` / `useTxColumnPrefs` /
`useTxSortPref` / `useTxFilterPrefs` are unchanged.

## Scope

- **In scope (shipped):** `src/app/(app)/transactions/_hooks/*`.
- **NOT in scope:** the portfolio + import/pending god-components and their
  hooks — those stay bespoke until **FINLYNQ-118** migrates them onto this same
  convention. This is intentionally **not** a repo-wide sweep; do not convert
  other screens ad-hoc — extend the migration through FINLYNQ-118 so the app
  doesn't end up half on SWR and half on hand-rolled `fetch/setState/finally`.

## The convention

### 1. Fetcher — REST returns BARE JSON

The Finlynq REST API returns the response body verbatim; the `{ success, data }`
envelope is **MCP-only**. Two fetchers cover the two pre-115 error behaviours:

| Fetcher | On `!res.ok` | Use for |
| --- | --- | --- |
| `jsonFetcher<T>(url)` | **throws** `FetchError` (populates SWR `error`) | endpoints whose old hook did an unconditional `r.json()` — e.g. the transactions list |
| `softJsonFetcher<T>(fallback)` | resolves `fallback` (never throws) | lookups + per-user-pref GETs whose old hook did `r.ok ? r.json() : <default>` / `.catch(() => <default>)` |

Paginated endpoints (the transactions list returns `{ data, total }`, issue #59)
are read by the hook off the returned object — the fetcher does not unwrap.

### 2. Key = the request URL string

SWR cache keys are the **URL the fetcher hits**:

- Static endpoints use their path via `swrKey("/api/accounts")`.
- The transactions list uses the pure, unit-tested
  `buildTransactionQuery(filters, sort, colFilters, accounts, { page, limit })`
  (`@/lib/transactions/build-query`) as the query string:
  `` `/api/transactions?${buildTransactionQuery(...)}` ``.
  The key changes exactly when the effective request changes — which is exactly
  when the pre-115 `loadTxns` `useCallback` was re-created and re-fired.

### 3. Options — `swrListOptions` (request volume preserved)

Spread `swrListOptions` into every `useSWR` call so the request *pattern* stays
no noisier than the pre-115 hooks (tc-2):

- `revalidateOnFocus: false` + `revalidateOnReconnect: false` — the old hooks
  never refetched on window focus / network reconnect, so neither do we.
- `revalidateIfStale: true` + `keepPreviousData: true` — nav-away-and-back serves
  the cached value instantly then revalidates once in the background (the win),
  with no full-screen reload flash.
- `dedupingInterval: 2000` — collapses the uncoordinated parallel fetches the old
  hooks fired (strictly fewer requests, never more).

Options are passed **per hook**, not via a global `<SWRConfig>` provider, so the
blast radius stays scoped to the transactions hooks (the shared `(app)` layout
is untouched).

### 4. Manual refetch = `mutate`

Where a pre-115 hook exposed an imperative refetch (e.g. `loadTxns`, called after
a create/edit/delete), the SWR rewrite returns the same-named function backed by
SWR's bound `mutate()` — same call sites, same "refetch now" semantics.

## Adding a new screen

1. Pick `jsonFetcher` or `softJsonFetcher(fallback)` to match the desired
   error-vs-default behaviour.
2. Build the key as the request URL (use `swrKey(path)` for static paths).
3. `useSWR(key, fetcher, swrListOptions)`.
4. Expose `mutate` (renamed to the screen's refetch verb) if callers need an
   imperative refetch.

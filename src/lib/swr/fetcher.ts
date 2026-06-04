/**
 * Shared SWR fetcher (FINLYNQ-115).
 *
 * The Finlynq REST API returns **bare JSON** — the `{ success, data }`
 * envelope is MCP-only (see CLAUDE.md "MCP — Canonical envelope" + the mobile
 * client note). So this fetcher returns the parsed body verbatim; callers that
 * read a paginated `{ data, total }` shape (e.g. the transactions list, issue
 * #59) read those keys off the returned object themselves — exactly as the
 * hand-rolled `fetch().then(r => r.json())` did before this item.
 *
 * Cookies (the session) ride along automatically since these are same-origin
 * GETs; no extra `credentials` flag is needed.
 *
 * On a non-2xx response we throw an {@link FetchError} carrying the status so
 * `useSWR`'s `error` channel is populated (SWR treats a thrown fetcher as an
 * error and keeps the last good `data`). The pre-115 hooks variously did
 * `r.ok ? r.json() : []` (lookups/prefs — soft-fail to a default) vs. an
 * unconditional `r.json()` (the list). To preserve those exact behaviours the
 * call sites pass the matching fetcher: {@link jsonFetcher} (throw on !ok, used
 * by the list) or {@link softJsonFetcher} (return the supplied fallback on !ok,
 * used by the lookups + pref GETs).
 */

export class FetchError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FetchError";
    this.status = status;
  }
}

/**
 * Strict fetcher: throws {@link FetchError} on a non-2xx response, otherwise
 * resolves the parsed (bare) JSON body. Use for endpoints whose pre-115 hook
 * did an unconditional `.then(r => r.json())` (the transactions list).
 */
export async function jsonFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new FetchError(`Request failed: ${res.status} ${url}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Soft fetcher factory: resolves the supplied `fallback` on a non-2xx response
 * (or a parse/network error) instead of throwing — mirrors the pre-115
 * `r.ok ? r.json() : <default>` / `.catch(() => <default>)` pattern used by the
 * lookups + per-user-pref GETs, which must never surface an error to the user
 * (they silently fall back to defaults).
 */
export function softJsonFetcher<T>(fallback: T) {
  return async (url: string): Promise<T> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return fallback;
      return (await res.json()) as T;
    } catch {
      return fallback;
    }
  };
}

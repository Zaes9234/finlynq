/**
 * IndexNow submission — instantly notify Bing, Yandex, Seznam, and Naver when
 * public content changes. (Google does NOT participate in IndexNow; it keeps
 * discovering finlynq.com via the sitemap in `sitemap.ts`.)
 *
 * Two moving parts:
 *   1. An ownership key file served at `${SITE_URL}/${INDEXNOW_KEY}.txt` (the
 *      committed static file `public/${INDEXNOW_KEY}.txt`, whose body is the
 *      key verbatim). The search engine fetches it to prove we own the host.
 *   2. `submitToIndexNow(urls)` — POSTs the changed URLs to the shared
 *      IndexNow endpoint. One request fans out to every participating engine.
 *
 * The URL source-of-truth is the same slug lists that feed `sitemap.ts`
 * (`src/lib/seo/site.ts` + glossary + releases), so the crawl surface never
 * drifts between the sitemap and the IndexNow ping.
 *
 * This module NEVER submits on import — call `submitToIndexNow` deliberately
 * (the deploy/announce path or `scripts/indexnow-submit.ts`).
 */

import { SITE_URL, STATIC_ROUTES, VS_SLUGS, BLOG_SLUGS } from "@/lib/seo/site";
import { GLOSSARY_SLUGS } from "@/lib/seo/glossary";
import { RELEASE_SLUGS } from "@/lib/seo/releases";

/**
 * The IndexNow ownership key. Env-overridable so an AGPL self-hoster can point
 * it at their own generated key (they must also host `${key}.txt` at their
 * root — see the README note in `public/`). The default is finlynq.com's key,
 * and its verbatim value lives in `public/${INDEXNOW_KEY}.txt`.
 *
 * IMPORTANT: if you change this constant, rename the matching file in
 * `public/` — the served file's NAME and BODY must both equal the key, or
 * IndexNow rejects every submission with a key-verification failure.
 */
export const INDEXNOW_KEY =
  process.env.INDEXNOW_KEY ?? "0f9c4a7e8b2d4f16a9c3e5d7b1082f4c";

/** Absolute URL of the hosted key file, passed as `keyLocation`. */
export function indexNowKeyLocation(): string {
  return `${SITE_URL}/${INDEXNOW_KEY}.txt`;
}

/** The shared IndexNow endpoint (Bing hub; fans out to all participants). */
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * Whether submissions should actually go out. Guarded so a self-hosted or
 * dev instance doesn't ping the live index with the managed key:
 *   - the canonical managed host (finlynq.com) is always enabled, or
 *   - a self-hoster who set their own `INDEXNOW_KEY` env opts in explicitly.
 */
export function indexNowEnabled(): boolean {
  const host = safeHost(SITE_URL);
  if (host === "finlynq.com") return true;
  return !!process.env.INDEXNOW_KEY;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Every public, crawlable absolute URL — the full IndexNow submission set.
 * Sourced from the SAME slug lists as `sitemap.ts` so the two never diverge.
 */
export function allPublicUrls(): string[] {
  const paths: string[] = [
    ...STATIC_ROUTES.map((r) => r.path),
    ...VS_SLUGS.map((s) => `/vs/${s}`),
    ...BLOG_SLUGS.map((s) => `/blog/${s}`),
    ...GLOSSARY_SLUGS.map((s) => `/glossary/${s}`),
    ...RELEASE_SLUGS.map((s) => `/releases/${s}`),
  ];
  return paths.map((p) => `${SITE_URL}${p}`);
}

export type IndexNowResult =
  | { ok: true; status: number; submitted: number }
  | { ok: false; status: number | null; submitted: 0; reason: string };

/**
 * Submit a batch of URLs to IndexNow. Best-effort and never throws — a search
 * ping must never break a deploy or a release. Every URL must be on the
 * `SITE_URL` host (IndexNow rejects cross-host lists); off-host URLs are
 * dropped with a warning rather than failing the whole batch.
 *
 * Returns a small result object describing what happened. Pass `dryRun` to
 * validate + log without sending (used by the CLI's `--dry-run`).
 */
export async function submitToIndexNow(
  urls: string[],
  opts: { dryRun?: boolean; log?: (msg: string) => void } = {}
): Promise<IndexNowResult> {
  const log = opts.log ?? (() => {});
  const host = safeHost(SITE_URL);

  if (!host) {
    return { ok: false, status: null, submitted: 0, reason: "invalid SITE_URL" };
  }
  if (!indexNowEnabled()) {
    return {
      ok: false,
      status: null,
      submitted: 0,
      reason: `IndexNow disabled for host ${host} (set INDEXNOW_KEY to opt in)`,
    };
  }

  // Dedupe + keep only same-host URLs.
  const seen = new Set<string>();
  const urlList: string[] = [];
  for (const u of urls) {
    if (safeHost(u) !== host) {
      log(`skip (off-host): ${u}`);
      continue;
    }
    if (seen.has(u)) continue;
    seen.add(u);
    urlList.push(u);
  }

  if (urlList.length === 0) {
    return { ok: false, status: null, submitted: 0, reason: "no submittable URLs" };
  }

  // IndexNow caps a single request at 10,000 URLs — far above our surface.
  if (urlList.length > 10000) urlList.length = 10000;

  const payload = {
    host,
    key: INDEXNOW_KEY,
    keyLocation: indexNowKeyLocation(),
    urlList,
  };

  if (opts.dryRun) {
    log(`[dry-run] would POST ${urlList.length} URLs to ${INDEXNOW_ENDPOINT}`);
    for (const u of urlList) log(`  ${u}`);
    return { ok: true, status: 0, submitted: urlList.length };
  }

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    // IndexNow returns 200 (accepted) or 202 (accepted, pending validation).
    if (res.status === 200 || res.status === 202) {
      return { ok: true, status: res.status, submitted: urlList.length };
    }
    return {
      ok: false,
      status: res.status,
      submitted: 0,
      reason: `IndexNow returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      submitted: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

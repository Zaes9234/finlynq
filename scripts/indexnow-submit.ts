/**
 * IndexNow submission CLI.
 *
 * Notifies Bing / Yandex / Seznam / Naver that finlynq.com content changed.
 * (Google ignores IndexNow and keeps using the sitemap.)
 *
 * Usage:
 *   npx tsx scripts/indexnow-submit.ts                 # submit ALL public URLs
 *   npx tsx scripts/indexnow-submit.ts <url> [<url>..] # submit only these URLs
 *   npx tsx scripts/indexnow-submit.ts --dry-run [...] # validate + print, no send
 *
 * Intended callers:
 *   - a deploy step after content ships (submit the full public set — ~30 URLs,
 *     well under IndexNow's rate limits), or
 *   - the announce/release flow, passing ONLY the changed URLs (most surgical:
 *     the release delta already knows which pages moved).
 *
 * URLs passed as args must be on the SITE_URL host; off-host URLs are dropped.
 * Bare paths ("/releases", "/blog/foo") are resolved against SITE_URL.
 */

import { SITE_URL } from "../src/lib/seo/site";
import {
  allPublicUrls,
  submitToIndexNow,
  indexNowEnabled,
  indexNowKeyLocation,
} from "../src/lib/seo/indexnow";

function toAbsolute(arg: string): string {
  if (arg.startsWith("http://") || arg.startsWith("https://")) return arg;
  return `${SITE_URL}${arg.startsWith("/") ? arg : `/${arg}`}`;
}

async function main() {
  const raw = process.argv.slice(2);
  const dryRun = raw.includes("--dry-run");
  const urlArgs = raw.filter((a) => a !== "--dry-run");

  const urls = urlArgs.length > 0 ? urlArgs.map(toAbsolute) : allPublicUrls();

  console.log(`IndexNow submission for ${SITE_URL}`);
  console.log(`  key file: ${indexNowKeyLocation()}`);
  console.log(`  enabled:  ${indexNowEnabled()}`);
  console.log(`  URLs:     ${urls.length}${dryRun ? " (dry-run)" : ""}`);

  const result = await submitToIndexNow(urls, {
    dryRun,
    log: (m) => console.log(`  ${m}`),
  });

  if (result.ok) {
    console.log(
      `OK — ${result.submitted} URL(s) ${dryRun ? "validated" : `accepted (HTTP ${result.status})`}.`
    );
    process.exit(0);
  }

  console.error(`FAILED — ${result.reason}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("indexnow-submit crashed:", err);
  process.exit(1);
});

/**
 * Securities master — read-flip feature flag (Tier 2, 2026-06-16).
 *
 * The Phase D read-flip (aggregating by `security_id` instead of the in-memory
 * `canonicalKey` string) is gated so it can ship dark and flip on only after
 * the parity harness is green. Two layers, OR'd:
 *
 *   1. Global env switch `SECURITIES_READ_ENABLED` (truthy = "1"/"true"/"yes").
 *      Set per-environment (off in prod until prod parity is re-verified).
 *   2. Per-user opt-in via the `settings` key `securities_read_enabled` = "1".
 *      Lets us flip it for a single account (e.g. the demo user on dev) WITHOUT
 *      touching server config — fully reversible by deleting the settings row.
 *
 * Default OFF. When OFF every aggregator keeps the legacy string-match path, so
 * the column/table can exist (Phase A/B/C) with zero behavior change until we
 * deliberately flip. → plan/architecture/securities.md
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";

export const SECURITIES_READ_SETTING_KEY = "securities_read_enabled";

/** Truthy-string test shared by the env + settings layers. */
function isTruthy(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** Global env switch. Read at request time (server-side), so a systemd/.env
 *  change takes effect on the next request without a rebuild. */
export function securitiesReadEnabledGlobally(): boolean {
  return isTruthy(process.env.SECURITIES_READ_ENABLED);
}

/**
 * Resolve the effective read-flip state for a user: global env OR per-user
 * settings opt-in. One cheap indexed settings lookup (skipped when the global
 * switch is already on).
 */
export async function securitiesReadEnabledForUser(userId: string): Promise<boolean> {
  if (securitiesReadEnabledGlobally()) return true;
  // A flag-read failure (uninitialized adapter in tests, transient DB hiccup)
  // MUST degrade to the safe default OFF (legacy string-match path) — never
  // break an aggregator that merely consults the flag.
  try {
    const row = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, SECURITIES_READ_SETTING_KEY),
          eq(schema.settings.userId, userId),
        ),
      )
      .get();
    return isTruthy(row?.value);
  } catch {
    return false;
  }
}

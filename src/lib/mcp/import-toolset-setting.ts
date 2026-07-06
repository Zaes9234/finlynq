/**
 * Connection-level MCP import-toolset opt-in (FINLYNQ-263 phase 5).
 *
 * The import-pipeline toolset (the 25 statement-import + bank-reconcile tools)
 * is HIDDEN from the default MCP session (owner decision #6 — most sessions
 * never touch it). Two ways to opt in (owner decision #2 — (a)+(b) hybrid):
 *   (a) an OAuth token carrying the `mcp:import` scope — durable per-grant;
 *   (b) THIS connection-level setting — a per-user boolean that opts EVERY
 *       transport in (OAuth, Bearer `pf_` key, stdio, session cookie), for
 *       callers that can't carry a scope claim.
 *
 * Stored under the `mcp_import_toolset_enabled` key in the `settings` key/value
 * table — NO migration (mirrors `reconcile_hidden_accounts` /
 * `email_retention_days`). Default OFF (unset ⇒ import-pipeline hidden).
 *
 * Read on each MCP request; a single indexed lookup keyed on
 * `(key, user_id)`. Never throws — a malformed/absent value degrades to OFF.
 */
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";

export const MCP_IMPORT_TOOLSET_KEY = "mcp_import_toolset_enabled";

/** Parse the stored value into a boolean. Never throws; unset/garbage ⇒ false. */
export function parseImportToolsetEnabled(value: string | null | undefined): boolean {
  if (!value) return false;
  return value === "1" || value === "true";
}

/** Read the per-user import-toolset opt-in. False when unset. */
export async function getImportToolsetEnabled(userId: string): Promise<boolean> {
  try {
    const row = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(
        and(
          eq(schema.settings.key, MCP_IMPORT_TOOLSET_KEY),
          eq(schema.settings.userId, userId),
        ),
      )
      .get();
    return parseImportToolsetEnabled(row?.value);
  } catch {
    // A settings read must never break the MCP request path — degrade to OFF.
    return false;
  }
}

/** Persist the per-user import-toolset opt-in. */
export async function setImportToolsetEnabled(
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  const value = enabled ? "1" : "0";
  await db
    .insert(schema.settings)
    .values({ key: MCP_IMPORT_TOOLSET_KEY, userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });
  return enabled;
}

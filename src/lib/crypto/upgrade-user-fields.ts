/**
 * Login-time user-field encryption upgrade (2026-06-01).
 *
 * The backstop for the plaintext-gap closure plan. Encryption-at-source covers
 * normal logged-in REST + MCP-HTTP writes, but legacy rows, stdio-written rows,
 * and email-import rows can still land plaintext. This sweep runs on EVERY login
 * (fire-and-forget) and converts any remaining plaintext free-text columns +
 * transaction-rule sensitive fields to `v1:` ciphertext under the user's DEK.
 *
 * It auto-fixes the 72/144 legacy plaintext payees that triggered the original
 * mobile cold-DEK symptom (payees stayed readable because they were plaintext).
 *
 * Idempotent + concurrency-safe:
 *   - Each column SELECT filters `NOT LIKE 'v1:%'` so already-encrypted rows are
 *     never scanned.
 *   - Each UPDATE re-asserts `NOT LIKE 'v1:%'` (double-encryption guard) so a
 *     concurrent login that already flipped the row makes this one a no-op.
 *   - A clean steady-state run scans 0 rows and upgrades 0.
 *
 * NEVER touched:
 *   - `import_hash` (hashed over plaintext payee at ingest — load-bearing).
 *   - Stream D `name_lookup` HMAC siblings (not in the registry).
 *   - Already-`v1:` values (the guards above).
 *
 * Failure handling: per-row + per-table try/catch. A column whose table doesn't
 * exist on this deployment (legacy raw tables) is skipped. Never throws into the
 * caller — fire-and-forget, mirrors `enqueueUpgradeStagingEncryption`.
 *
 * See plan/encryption-plaintext-gaps.md Phase 5.
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { encryptField, isEncrypted } from "@/lib/crypto/envelope";
import { encryptRuleFields, ruleHasPlaintext } from "@/lib/rules/crypto";
import {
  USER_ENCRYPTED_COLUMNS,
  type UserEncryptedColumn,
} from "./user-encrypted-registry";

/** Per-table/run cap so a huge legacy account doesn't block a login indefinitely.
 *  The next login picks up where this one left off (the NOT LIKE filter advances). */
const MAX_PER_TABLE = 500;

export interface UpgradeUserFieldsResult {
  scanned: number;
  upgraded: number;
  failed: number;
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const r = (res as { rows?: unknown } | null)?.rows;
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}

/**
 * Per-table user-ownership predicate for the sweep's SELECT + UPDATE.
 *
 * Default: a direct `user_id = $1` column. Tables registered with a
 * `userScope` (e.g. `transaction_splits`, which has no `user_id` of its own)
 * scope transitively through the parent FK so the sweep only ever re-encrypts
 * a row under its owning user's DEK. Without this, the direct `user_id`
 * predicate raises SQLSTATE 42703 and the whole table is silently skipped.
 */
function userScopeCondition(entry: UserEncryptedColumn, userId: string): SQL {
  if (entry.userScope) {
    const fkId = sql.identifier(entry.userScope.fkColumn);
    const parentId = sql.identifier(entry.userScope.parentTable);
    return sql`${fkId} IN (SELECT id FROM ${parentId} WHERE user_id = ${userId})`;
  }
  return sql`user_id = ${userId}`;
}

/**
 * Fire-and-forget wrapper. Schedules the upgrade on the next microtask so the
 * login response returns immediately. Any error is logged and swallowed.
 */
export function enqueueUpgradeUserFieldEncryption(userId: string, dek: Buffer): void {
  queueMicrotask(() => {
    upgradeUserFieldEncryption(userId, dek).catch((err) => {
      console.warn("[upgrade-user-fields] failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/**
 * Awaitable form for tests. Production callers should use the enqueue wrapper.
 */
export async function upgradeUserFieldEncryption(
  userId: string,
  dek: Buffer,
): Promise<UpgradeUserFieldsResult> {
  let scanned = 0;
  let upgraded = 0;
  let failed = 0;

  // ─── Envelope note/payee/tags columns ────────────────────────────────────
  for (const entry of USER_ENCRYPTED_COLUMNS) {
    const { table, column } = entry;
    const tableId = sql.identifier(table);
    const colId = sql.identifier(column);
    const userScope = userScopeCondition(entry, userId);

    let rows: Array<Record<string, unknown>>;
    try {
      const res = await db.execute(sql`
        SELECT id, ${colId} AS val
        FROM ${tableId}
        WHERE ${userScope}
          AND ${colId} IS NOT NULL
          AND ${colId} <> ''
          AND ${colId} NOT LIKE 'v1:%'
        LIMIT ${MAX_PER_TABLE}
      `);
      rows = rowsOf(res);
    } catch (err) {
      // Table may not exist on this deployment (legacy raw tables) — skip.
      console.warn("[upgrade-user-fields] scan skipped", {
        table,
        column,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    scanned += rows.length;
    for (const row of rows) {
      const plain = row.val;
      // Double-encryption guard + type guard. The SELECT already excludes
      // v1:/empty rows, but re-check defensively before encrypting.
      if (typeof plain !== "string" || plain === "" || isEncrypted(plain)) continue;
      try {
        const ct = encryptField(dek, plain);
        await db.execute(sql`
          UPDATE ${tableId}
          SET ${colId} = ${ct}
          WHERE id = ${row.id}
            AND ${userScope}
            AND ${colId} NOT LIKE 'v1:%'
        `);
        upgraded++;
      } catch (err) {
        failed++;
        console.warn("[upgrade-user-fields] row failed", {
          table,
          column,
          id: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ─── Transaction rules (name + condition values + rename/tags) ────────────
  try {
    const res = await db.execute(sql`
      SELECT id, name, conditions, actions
      FROM transaction_rules
      WHERE user_id = ${userId}
      LIMIT ${MAX_PER_TABLE}
    `);
    const ruleRows = rowsOf(res);
    for (const r of ruleRows) {
      const ruleFields = {
        name: typeof r.name === "string" ? r.name : null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conditions: (r.conditions ?? { all: [] }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actions: (Array.isArray(r.actions) ? r.actions : []) as any,
      };
      // Only count + upgrade rules that actually carry plaintext, so a
      // steady-state run reports upgraded=0.
      if (!ruleHasPlaintext(ruleFields)) continue;
      scanned++;
      try {
        const enc = encryptRuleFields(dek, ruleFields);
        await db.execute(sql`
          UPDATE transaction_rules
          SET name = ${enc.name ?? r.name},
              conditions = ${JSON.stringify(enc.conditions)}::jsonb,
              actions = ${JSON.stringify(enc.actions)}::jsonb
          WHERE id = ${r.id} AND user_id = ${userId}
        `);
        upgraded++;
      } catch (err) {
        failed++;
        console.warn("[upgrade-user-fields] rule failed", {
          id: r.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    console.warn("[upgrade-user-fields] rules scan skipped", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return { scanned, upgraded, failed };
}

/**
 * Account-group customization helpers (FINLYNQ-179).
 *
 * `accounts.group` is a free-text column — the backend has always been
 * flexible; the historical constraint was purely a hard-coded UI dropdown.
 * This module is the single source of truth for:
 *
 *   1. The seeded default group names per account type (A=Asset, L=Liability).
 *      The create/edit combobox suggests these UNION the user's own existing
 *      groups (live-derived, no migration).
 *   2. The per-user group display ORDER, persisted under the `account_group_order`
 *      key in the `settings` key/value table — NO migration (mirrors the
 *      `reconcile_hidden_accounts` / `email_retention_days` precedent).
 *   3. The owner-scoped bulk rename / merge-into-Other operations, which are a
 *      plain `UPDATE accounts SET "group"=? WHERE "group"=? AND user_id=?`
 *      (the `group` column is plaintext, not DEK-encrypted — no crypto needed).
 *
 * Groups stay scoped per account type. The pure cores never throw — a
 * malformed stored order degrades to "no custom order" (alphabetical/default
 * fallback) rather than breaking the accounts page.
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";

export const ACCOUNT_GROUP_ORDER_KEY = "account_group_order";

/** The group bucket every account falls back to when it has no group. */
export const OTHER_GROUP = "Other";

export type AccountGroupType = "A" | "L";

/**
 * Seeded default group names per account type. The create/edit combobox starts
 * from these; the user can pick any of them OR type a brand-new custom name.
 * Single source of truth — the accounts page imports this rather than carrying
 * its own copy.
 */
export const ACCOUNT_GROUP_DEFAULTS: Record<AccountGroupType, string[]> = {
  A: ["Cash", "Checking", "Savings", "Investment", "Property", OTHER_GROUP],
  L: ["Credit Card", "Loan", "Mortgage", OTHER_GROUP],
};

/** A per-type ordered list of group names. */
export type AccountGroupOrder = Record<AccountGroupType, string[]>;

export const EMPTY_GROUP_ORDER: AccountGroupOrder = { A: [], L: [] };

function normalizeGroupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** De-dupe a list of group names preserving first-seen order (case-sensitive,
 *  but case-insensitively de-duped so "Cash" and "cash" don't both appear). */
export function dedupeGroups(names: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeGroupName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Parse the stored `account_group_order` value into a per-type order map.
 * Never throws — a malformed/legacy value degrades to the empty order so the
 * accounts page just falls back to alphabetical/default ordering.
 */
export function parseGroupOrder(value: string | null | undefined): AccountGroupOrder {
  if (!value) return { A: [], L: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { A: [], L: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { A: [], L: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const forType = (t: AccountGroupType): string[] => {
    const arr = obj[t];
    if (!Array.isArray(arr)) return [];
    return dedupeGroups(arr.map((v) => (typeof v === "string" ? v : "")));
  };
  return { A: forType("A"), L: forType("L") };
}

/**
 * Suggestion list for the create/edit combobox for a given account type:
 * the seeded defaults UNION the user's existing group names for that type,
 * de-duped (defaults lead). Pure.
 */
export function groupSuggestions(
  type: string,
  existingGroups: ReadonlyArray<string>,
): string[] {
  const defaults = ACCOUNT_GROUP_DEFAULTS[type as AccountGroupType] ?? [OTHER_GROUP];
  return dedupeGroups([...defaults, ...existingGroups]);
}

/**
 * Order a set of group names by the user's saved order. Names present in the
 * saved order lead (in saved sequence); the rest follow by the fallback
 * comparator (default: locale-aware alpha). "Other" is always sunk to the end
 * regardless of where it sits. Pure.
 */
export function orderGroups(
  groups: ReadonlyArray<string>,
  savedOrder: ReadonlyArray<string>,
  fallbackCompare: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): string[] {
  const present = dedupeGroups(groups);
  const orderIndex = new Map<string, number>();
  dedupeGroups(savedOrder).forEach((g, i) => orderIndex.set(g.toLowerCase(), i));

  const rank = (g: string): number => {
    if (g.toLowerCase() === OTHER_GROUP.toLowerCase()) return Number.MAX_SAFE_INTEGER;
    const idx = orderIndex.get(g.toLowerCase());
    return idx === undefined ? Number.MAX_SAFE_INTEGER - 1 : idx;
  };

  return present.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return fallbackCompare(a, b);
  });
}

/** Read the per-user saved group order. Empty when unset. */
export async function getAccountGroupOrder(userId: string): Promise<AccountGroupOrder> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, ACCOUNT_GROUP_ORDER_KEY),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  return parseGroupOrder(row?.value);
}

/** Persist the per-user saved group order (normalized). */
export async function setAccountGroupOrder(
  userId: string,
  order: AccountGroupOrder,
): Promise<AccountGroupOrder> {
  const normalized: AccountGroupOrder = {
    A: dedupeGroups(order.A ?? []),
    L: dedupeGroups(order.L ?? []),
  };
  const value = JSON.stringify(normalized);
  await db
    .insert(schema.settings)
    .values({ key: ACCOUNT_GROUP_ORDER_KEY, userId, value })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });
  return normalized;
}

/**
 * Owner-scoped bulk rename of an account group. Moves every account in `from`
 * (case-insensitive match, optionally scoped to an account `type`) into `to`.
 * Returns the number of rows touched. Touches ONLY the calling user's rows.
 *
 * When `to` is "Other" this doubles as a merge-into-Other.
 */
export async function renameAccountGroup(
  userId: string,
  from: string,
  to: string,
  type?: AccountGroupType,
): Promise<number> {
  const fromName = normalizeGroupName(from);
  const toName = normalizeGroupName(to);
  if (!fromName || !toName) return 0;
  if (fromName.toLowerCase() === toName.toLowerCase()) return 0;

  const conditions = [
    eq(schema.accounts.userId, userId),
    // Case-insensitive match so "savings" renames "Savings" too.
    sql`lower(${schema.accounts.group}) = lower(${fromName})`,
  ];
  if (type) conditions.push(eq(schema.accounts.type, type));

  // Await the builder directly (don't call .run()) and read the driver's
  // rowCount for a portable touched-count — mirrors email-import/cleanup.ts.
  const result = await db
    .update(schema.accounts)
    .set({ group: toName })
    .where(and(...conditions));
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

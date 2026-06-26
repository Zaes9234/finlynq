/**
 * Phase 5 — login-time user-field encryption sweep tests.
 *
 * Drives `upgradeUserFieldEncryption` against a small in-memory store. The DB
 * layer is mocked: `db.execute(sql`...`)` is interpreted by reconstructing the
 * tagged-template query (identifiers + positional params) and applying it to
 * the store. Asserts plaintext → v1: conversion, the already-encrypted /
 * other-user / import_hash invariants, idempotency, and the double-encrypt guard.
 *
 * See plan/encryption-plaintext-gaps.md Phase 5.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TEST_DEK } from "./helpers/api-test-utils";
import { decryptField, encryptField, isEncrypted } from "@/lib/crypto/envelope";
import { decryptRuleFields } from "@/lib/rules/crypto";
import { USER_ENCRYPTED_COLUMNS } from "@/lib/crypto/user-encrypted-registry";

// ─── In-memory store + DB mock (hoisted so vi.mock factories can use them) ───
// `user_id` is optional: tables scoped transitively through a parent FK (e.g.
// transaction_splits → transactions.user_id) carry no user_id of their own.
const { store, execute } = vi.hoisted(() => {
  const store: Record<string, Array<Record<string, unknown> & { id: number; user_id?: string }>> = {};

  // Recursively flatten nested sql fragments — `${userScopeCondition(...)}` is a
  // nested `{ __sql, strings, values }` embedded in the outer template, exactly
  // like real drizzle. Identifiers inline as quoted names; everything else
  // becomes a positional param in order of appearance.
  const reconstruct = (q: { strings: string[]; values: unknown[] }): { text: string; params: unknown[] } => {
    let text = "";
    const params: unknown[] = [];
    const walk = (node: { strings: string[]; values: unknown[] }) => {
      for (let i = 0; i < node.strings.length; i++) {
        text += node.strings[i];
        if (i < node.values.length) {
          const v = node.values[i] as { __ident?: string; __sql?: boolean; strings?: string[]; values?: unknown[] } | unknown;
          if (v && typeof v === "object" && "__ident" in (v as object)) {
            text += `"${(v as { __ident: string }).__ident}"`;
          } else if (v && typeof v === "object" && "__sql" in (v as object)) {
            walk(v as { strings: string[]; values: unknown[] });
          } else {
            params.push(v);
            text += `$${params.length}`;
          }
        }
      }
    };
    walk(q);
    return { text, params };
  };

  // Resolve a row's owning user. Direct `user_id = $N` predicate → the row's
  // own user_id. A parent-scoped predicate
  // `"<fk>" IN (SELECT id FROM "<parent>" WHERE user_id = $N)` → resolve through
  // the parent table. Mirrors `userScopeCondition` in the production sweep.
  const ownsRow = (
    text: string,
    row: Record<string, unknown>,
    userId: string,
  ): boolean => {
    const join = text.match(/"(\w+)" IN \(SELECT id FROM "(\w+)" WHERE user_id/);
    if (join) {
      const [, fkCol, parentTable] = join;
      return (store[parentTable] ?? []).some(
        (p) => p.id === row[fkCol] && p.user_id === userId,
      );
    }
    return row.user_id === userId;
  };

  const execute = vi.fn(async (q: { strings: string[]; values: unknown[] }) => {
    const { text, params } = reconstruct(q);
    const trimmed = text.trim();

    // Rules SELECT (literal table name, no quotes).
    if (/FROM transaction_rules/.test(text) && trimmed.startsWith("SELECT")) {
      const userId = params[0] as string;
      const limit = (params[1] as number) ?? 500;
      const rows = (store.transaction_rules ?? [])
        .filter((r) => r.user_id === userId)
        .slice(0, limit)
        .map((r) => ({ id: r.id, name: r.name, conditions: r.conditions, actions: r.actions }));
      return { rows };
    }
    // Rules UPDATE.
    if (/UPDATE transaction_rules/.test(text)) {
      const [name, condsJson, actionsJson, id, userId] = params as [string, string, string, number, string];
      const row = (store.transaction_rules ?? []).find((r) => r.id === id && r.user_id === userId);
      if (row) {
        row.name = name;
        row.conditions = JSON.parse(condsJson);
        row.actions = JSON.parse(actionsJson);
      }
      return { rowCount: row ? 1 : 0 };
    }
    // Column sweep SELECT.
    if (trimmed.startsWith("SELECT id,")) {
      const col = text.match(/SELECT id, "(\w+)" AS val/)![1];
      // The first `FROM "<table>"` is the swept table (a parent-scoped predicate
      // adds a second `FROM "<parent>"` inside the subquery — ignore it).
      const table = text.match(/FROM "(\w+)"/)![1];
      const userId = params[0] as string;
      const limit = (params[1] as number) ?? 500;
      const rows = (store[table] ?? [])
        .filter((r) => ownsRow(text, r, userId) && r[col] != null && r[col] !== "" && !String(r[col]).startsWith("v1:"))
        .slice(0, limit)
        .map((r) => ({ id: r.id, val: r[col] }));
      return { rows };
    }
    // Column sweep UPDATE.
    if (trimmed.startsWith("UPDATE")) {
      const table = text.match(/UPDATE "(\w+)"/)![1];
      const col = text.match(/SET "(\w+)" =/)![1];
      const [ct, id, userId] = params as [string, number, string];
      const row = (store[table] ?? []).find((r) => r.id === id && ownsRow(text, r, userId));
      if (row && !String(row[col] ?? "").startsWith("v1:")) row[col] = ct;
      return { rowCount: row ? 1 : 0 };
    }
    return { rows: [] };
  });

  return { store, execute };
});

// ─── drizzle-orm mock: sql tag + sql.identifier ─────────────────────────────
vi.mock("drizzle-orm", () => {
  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sql: true,
    strings: Array.from(strings),
    values,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sqlTag as any).identifier = (name: string) => ({ __ident: name });
  return { sql: sqlTag };
});

vi.mock("@/db", () => ({ db: { execute } }));

import { upgradeUserFieldEncryption } from "@/lib/crypto/upgrade-user-fields";

const USER_A = "user-a";
const USER_B = "user-b";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(store)) delete store[k];
  store.transactions = [
    { id: 1, user_id: USER_A, payee: "Walmart", note: "lunch", tags: "", import_hash: "h1" },
    { id: 2, user_id: USER_A, payee: encryptField(TEST_DEK, "AlreadyEncrypted"), note: "", tags: "", import_hash: "h2" },
    { id: 3, user_id: USER_B, payee: "OtherUserPayee", note: "", tags: "", import_hash: "h3" },
  ];
  store.goals = [{ id: 10, user_id: USER_A, note: "secret goal" }];
  // transaction_splits has NO user_id — ownership is via transaction_id →
  // transactions.user_id. tx 1 = USER_A, tx 3 = USER_B (seeded above).
  store.transaction_splits = [
    { id: 200, transaction_id: 1, note: "split note A", description: "split desc A", tags: "tagA" },
    { id: 201, transaction_id: 3, note: "split note B", description: "split desc B", tags: "tagB" },
  ];
  store.transaction_rules = [
    {
      id: 100,
      user_id: USER_A,
      name: "Coffee rule",
      conditions: { all: [{ field: "payee", op: "contains", value: "Starbucks" }] },
      actions: [{ kind: "set_category", categoryId: 1 }],
    },
  ];
});

describe("upgradeUserFieldEncryption", () => {
  it("encrypts plaintext payee + note + rule fields for the target user", async () => {
    const result = await upgradeUserFieldEncryption(USER_A, TEST_DEK);
    expect(result.failed).toBe(0);
    expect(result.upgraded).toBeGreaterThanOrEqual(4); // payee + note + goal note + rule

    const walmart = store.transactions.find((r) => r.id === 1)!;
    expect(isEncrypted(walmart.payee as string)).toBe(true);
    expect(decryptField(TEST_DEK, walmart.payee as string)).toBe("Walmart");
    expect(isEncrypted(walmart.note as string)).toBe(true);
    expect(decryptField(TEST_DEK, walmart.note as string)).toBe("lunch");
    // import_hash MUST be preserved (load-bearing).
    expect(walmart.import_hash).toBe("h1");

    const goal = store.goals.find((r) => r.id === 10)!;
    expect(isEncrypted(goal.note as string)).toBe(true);
    expect(decryptField(TEST_DEK, goal.note as string)).toBe("secret goal");

    const rule = store.transaction_rules.find((r) => r.id === 100)!;
    const dec = decryptRuleFields(TEST_DEK, {
      name: rule.name as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conditions: rule.conditions as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions: rule.actions as any,
    });
    expect(isEncrypted(rule.name as string)).toBe(true);
    expect(dec.name).toBe("Coffee rule");
    expect((dec.conditions!.all[0] as { value: string }).value).toBe("Starbucks");
  });

  it("leaves already-encrypted rows untouched (no double-encrypt)", async () => {
    const before = store.transactions.find((r) => r.id === 2)!.payee as string;
    await upgradeUserFieldEncryption(USER_A, TEST_DEK);
    const after = store.transactions.find((r) => r.id === 2)!.payee as string;
    expect(after).toBe(before);
    // One decrypt recovers plaintext (not inner ciphertext).
    expect(decryptField(TEST_DEK, after)).toBe("AlreadyEncrypted");
  });

  it("does not touch other users' rows", async () => {
    await upgradeUserFieldEncryption(USER_A, TEST_DEK);
    const other = store.transactions.find((r) => r.id === 3)!;
    expect(other.payee).toBe("OtherUserPayee");
    expect(isEncrypted(other.payee as string)).toBe(false);
  });

  it("is idempotent — a second run scans + upgrades nothing", async () => {
    const first = await upgradeUserFieldEncryption(USER_A, TEST_DEK);
    expect(first.upgraded).toBeGreaterThan(0);
    const second = await upgradeUserFieldEncryption(USER_A, TEST_DEK);
    expect(second.scanned).toBe(0);
    expect(second.upgraded).toBe(0);
  });

  // Regression: transaction_splits has no user_id column, so the legacy direct
  // `WHERE user_id = $1` raised SQLSTATE 42703 and the whole table was silently
  // skipped (errors swallowed). The registry now scopes splits via the parent
  // transaction; the sweep must encrypt the owner's splits and only the owner's.
  it("encrypts transaction_splits scoped through the parent transaction", async () => {
    await upgradeUserFieldEncryption(USER_A, TEST_DEK);

    // USER_A's split (parent tx 1) — every encrypted column re-stored as v1:.
    const splitA = store.transaction_splits.find((r) => r.id === 200)!;
    expect(isEncrypted(splitA.note as string)).toBe(true);
    expect(decryptField(TEST_DEK, splitA.note as string)).toBe("split note A");
    expect(isEncrypted(splitA.description as string)).toBe(true);
    expect(decryptField(TEST_DEK, splitA.description as string)).toBe("split desc A");
    expect(isEncrypted(splitA.tags as string)).toBe(true);
    expect(decryptField(TEST_DEK, splitA.tags as string)).toBe("tagA");

    // USER_B's split (parent tx 3) — untouched plaintext.
    const splitB = store.transaction_splits.find((r) => r.id === 201)!;
    expect(splitB.note).toBe("split note B");
    expect(isEncrypted(splitB.note as string)).toBe(false);
  });

  it("does not throw / skip on a no-user_id table (no 42703)", async () => {
    const result = await upgradeUserFieldEncryption(USER_A, TEST_DEK);
    // 3 split columns × 1 owned row = 3 upgrades, all succeeded (none failed by
    // the swallowed 42703 path).
    expect(result.failed).toBe(0);
    expect(result.upgraded).toBeGreaterThanOrEqual(3 + 4); // splits + tx/goal/rule
  });
});

// ─── Registry ⇄ schema consistency (the regression guard) ───────────────────
// Reads the real schema-pg.ts so a future registered table that lacks a
// `user_id` column WITHOUT a `userScope` override (the exact shape of this bug)
// fails here instead of silently 42703-ing the sweep at runtime.
describe("USER_ENCRYPTED_COLUMNS registry is consistent with the schema", () => {
  const schemaSrc = readFileSync(
    fileURLToPath(new URL("../src/db/schema-pg.ts", import.meta.url)),
    "utf8",
  );

  /** Extract a single `export const x = pgTable("<name>", { ... })` definition
   *  (bounded by the next top-level `export`, so multi-arg index defs don't
   *  confuse it) and report whether it declares a `user_id` column. */
  const tableHasUserId = (table: string): boolean => {
    const start = schemaSrc.search(
      new RegExp(`pgTable\\(\\s*"${table}"\\s*,\\s*\\{`),
    );
    expect(start, `pgTable("${table}") not found in schema-pg.ts`).toBeGreaterThanOrEqual(0);
    const nextExport = schemaSrc.indexOf("\nexport ", start + 1);
    const body = schemaSrc.slice(start, nextExport === -1 ? schemaSrc.length : nextExport);
    return /"user_id"/.test(body);
  };

  it("every entry without userScope targets a table that has a user_id column", () => {
    for (const entry of USER_ENCRYPTED_COLUMNS) {
      if (entry.userScope) continue;
      expect(
        tableHasUserId(entry.table),
        `Registry entry ${entry.table}.${entry.column} has no userScope but ${entry.table} has no user_id column — the sweep will 42703. Add a userScope override.`,
      ).toBe(true);
    }
  });

  it("every userScope points at a real parent table that has a user_id column", () => {
    for (const entry of USER_ENCRYPTED_COLUMNS) {
      if (!entry.userScope) continue;
      // The scoped table itself must genuinely lack user_id (else the override
      // is unnecessary and misleading).
      expect(
        tableHasUserId(entry.table),
        `${entry.table} has a user_id column — drop the userScope override`,
      ).toBe(false);
      // The parent must carry user_id for the IN-subquery to resolve.
      expect(
        tableHasUserId(entry.userScope.parentTable),
        `userScope.parentTable ${entry.userScope.parentTable} has no user_id column`,
      ).toBe(true);
    }
  });
});

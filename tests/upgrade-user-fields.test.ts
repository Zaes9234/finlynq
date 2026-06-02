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
import { TEST_DEK } from "./helpers/api-test-utils";
import { decryptField, encryptField, isEncrypted } from "@/lib/crypto/envelope";
import { decryptRuleFields } from "@/lib/rules/crypto";

// ─── In-memory store + DB mock (hoisted so vi.mock factories can use them) ───
type Row = Record<string, unknown> & { id: number; user_id: string };

const { store, execute } = vi.hoisted(() => {
  const store: Record<string, Array<Record<string, unknown> & { id: number; user_id: string }>> = {};

  const reconstruct = (q: { strings: string[]; values: unknown[] }): { text: string; params: unknown[] } => {
    let text = "";
    const params: unknown[] = [];
    for (let i = 0; i < q.strings.length; i++) {
      text += q.strings[i];
      if (i < q.values.length) {
        const v = q.values[i] as { __ident?: string } | unknown;
        if (v && typeof v === "object" && "__ident" in (v as object)) {
          text += `"${(v as { __ident: string }).__ident}"`;
        } else {
          params.push(v);
          text += `$${params.length}`;
        }
      }
    }
    return { text, params };
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
      const table = text.match(/FROM "(\w+)"/)![1];
      const userId = params[0] as string;
      const limit = (params[1] as number) ?? 500;
      const rows = (store[table] ?? [])
        .filter((r) => r.user_id === userId && r[col] != null && r[col] !== "" && !String(r[col]).startsWith("v1:"))
        .slice(0, limit)
        .map((r) => ({ id: r.id, val: r[col] }));
      return { rows };
    }
    // Column sweep UPDATE.
    if (trimmed.startsWith("UPDATE")) {
      const table = text.match(/UPDATE "(\w+)"/)![1];
      const col = text.match(/SET "(\w+)" =/)![1];
      const [ct, id, userId] = params as [string, number, string];
      const row = (store[table] ?? []).find((r) => r.id === id && r.user_id === userId);
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
});

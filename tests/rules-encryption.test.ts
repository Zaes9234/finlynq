/**
 * Phase 3 + Phase 4 — transaction-rule encryption tests.
 *
 * Phase 3: rule write encrypts sensitive free-text; rule read decrypts.
 * Phase 4: an encrypted rule, once decrypted, still matches the same txn the
 *   plaintext rule matched (the matcher is untouched); a wrong-DEK decrypt
 *   yields a non-matching needle rather than a crash.
 *
 * See plan/encryption-plaintext-gaps.md Phases 3 + 4.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { randomBytes } from "crypto";
import { TEST_DEK, mockAuthContext, createMockRequest, parseResponse } from "./helpers/api-test-utils";
import { encryptRuleFields, decryptRuleFields } from "@/lib/rules/crypto";
import { applyRules, type TransactionRule } from "@/lib/auto-categorize";
import { isEncrypted } from "@/lib/crypto/envelope";
import type { ConditionGroup, Action } from "@/lib/rules/schema";

// ─── Configurable DB mock ──────────────────────────────────────────────────
let selectQueue: unknown[][] = [];
let getResult: unknown = { id: 1 };
const valuesSpy = vi.fn();

const chain: Record<string, unknown> = {};
for (const m of ["select", "from", "where", "orderBy", "leftJoin", "limit", "offset", "insert", "update", "delete", "returning", "groupBy", "set"]) {
  chain[m] = vi.fn(() => chain);
}
chain.values = vi.fn((arg: unknown) => { valuesSpy(arg); return chain; });
chain.all = vi.fn(() => (selectQueue.length ? selectQueue.shift() : []));
chain.get = vi.fn(() => getResult);
chain.run = vi.fn();
(chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
  resolve(selectQueue.length ? selectQueue.shift() : []);

vi.mock("@/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => chain[prop as string] }),
  schema: new Proxy({}, {
    get: () => new Proxy({}, { get: (_t2, col) => ({ name: String(col), userId: "userId", id: "id", nameCt: "nameCt" }) }),
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(), sql: vi.fn(), inArray: vi.fn(),
}));

vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => {}),
  OwnershipError: class OwnershipError extends Error {},
}));

import { requireAuth } from "@/lib/auth/require-auth";
import { GET as rulesGET, POST as rulesPOST } from "@/app/api/rules/route";

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  getResult = { id: 1 };
  (requireAuth as Mock).mockResolvedValue({ authenticated: true, context: mockAuthContext() });
});

describe("Phase 3 — rule write/display encryption", () => {
  it("POST encrypts name + payee value + rename_payee.to before insert", async () => {
    const req = createMockRequest("http://localhost:3000/api/rules", {
      method: "POST",
      body: {
        name: "Coffee rule",
        conditions: { all: [{ field: "payee", op: "contains", value: "Starbucks" }] },
        actions: [{ kind: "rename_payee", to: "Coffee" }, { kind: "set_category", categoryId: 1 }],
      },
    });
    const res = await rulesPOST(req);
    expect(res.status).toBe(201);
    const written = valuesSpy.mock.calls[0][0] as {
      name: string;
      conditions: { all: Array<{ value: string }> };
      actions: Array<{ kind: string; to?: string; categoryId?: number }>;
    };
    expect(written.name).toMatch(/^v1:/);
    expect(written.conditions.all[0].value).toMatch(/^v1:/);
    const rename = written.actions.find((a) => a.kind === "rename_payee")!;
    expect(rename.to).toMatch(/^v1:/);
    // FK id untouched.
    const setCat = written.actions.find((a) => a.kind === "set_category")!;
    expect(setCat.categoryId).toBe(1);
  });

  it("POST leaves a currency condition value untouched", async () => {
    const req = createMockRequest("http://localhost:3000/api/rules", {
      method: "POST",
      body: {
        name: "USD rule",
        conditions: { all: [{ field: "currency", op: "is", value: "USD" }] },
        actions: [{ kind: "set_category", categoryId: 1 }],
      },
    });
    const res = await rulesPOST(req);
    expect(res.status).toBe(201);
    const written = valuesSpy.mock.calls[0][0] as { conditions: { all: Array<{ value: string }> } };
    expect(written.conditions.all[0].value).toBe("USD"); // NOT encrypted
  });

  it("GET decrypts name + payee value + rename_payee.to for display", async () => {
    const enc = encryptRuleFields(TEST_DEK, {
      name: "Coffee rule",
      conditions: { all: [{ field: "payee", op: "contains", value: "Starbucks" }] },
      actions: [{ kind: "rename_payee", to: "Coffee" }, { kind: "set_category", categoryId: 1 }],
    });
    // First .all() → raw rules; second .all() → categories name batch.
    selectQueue = [
      [{ id: 1, name: enc.name, conditions: enc.conditions, actions: enc.actions, isActive: true, priority: 0, createdAt: "2026-06-01", updatedAt: null }],
      [],
    ];
    const req = createMockRequest("http://localhost:3000/api/rules");
    const res = await rulesGET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const rules = data as Array<{ name: string; conditions: { all: Array<{ value: string }> }; actions: Array<{ kind: string; to?: string }> }>;
    expect(rules[0].name).toBe("Coffee rule");
    expect(rules[0].conditions.all[0].value).toBe("Starbucks");
    expect((rules[0].actions.find((a) => a.kind === "rename_payee"))!.to).toBe("Coffee");
  });
});

describe("Phase 4 — encrypted rule still matches once decrypted", () => {
  const plaintextRule: TransactionRule = {
    id: 1,
    name: "Coffee rule",
    conditions: { all: [{ field: "payee", op: "contains", value: "Starbucks" }] } as ConditionGroup,
    actions: [{ kind: "set_category", categoryId: 7 }] as Action[],
    isActive: true,
    priority: 0,
  };
  const txn = { payee: "STARBUCKS #1234", amount: -5.5, accountId: 1, date: "2026-06-01" };

  it("matches the same txn after encrypt → decrypt round-trip", () => {
    // Baseline: plaintext rule matches.
    expect(applyRules(txn, [plaintextRule])?.rule.id).toBe(1);

    // Encrypt then decrypt with the same DEK → still matches.
    const enc = encryptRuleFields(TEST_DEK, plaintextRule) as TransactionRule;
    expect(isEncrypted((enc.conditions.all[0] as { value: string }).value)).toBe(true);
    const dec = decryptRuleFields(TEST_DEK, enc) as TransactionRule;
    expect(applyRules(txn, [dec])?.rule.id).toBe(1);
  });

  it("a wrong-DEK decrypt yields a non-matching needle (no crash)", () => {
    const enc = encryptRuleFields(TEST_DEK, plaintextRule) as TransactionRule;
    const wrongDek = randomBytes(32);
    // tryDecryptField returns null on auth-tag failure → `?? value` keeps the
    // ciphertext, which won't substring-match the plaintext payee.
    const dec = decryptRuleFields(wrongDek, enc) as TransactionRule;
    expect(applyRules(txn, [dec])).toBeNull();
  });
});

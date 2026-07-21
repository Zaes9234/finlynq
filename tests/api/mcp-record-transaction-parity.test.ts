/**
 * FINLYNQ-108 — MCP HTTP write tools route through the shared domain layer.
 *
 * `record_transaction` and `bulk_record_transactions` previously issued raw
 * `INSERT INTO transactions`. They now call the
 * same `createTransaction` helper the REST `POST /api/transactions` route uses,
 * so the audit trio (`source` / `created_at` / `updated_at`), sign-vs-category,
 * `invalidateUser`, and the investment-account FK guard are STRUCTURAL — defined
 * once in `queries.ts` — instead of re-asserted at every raw write site.
 *
 * This is the `code` row-parity case appended to the FINLYNQ-108 test plan
 * (companion to the primary `code` no-raw-insert case and the `mcp_agent`
 * on-dev row-parity case). It is mock-based (no real DB): we spy on
 * `createTransaction` and assert the refactored handler hands it a payload
 * that produces a row indistinguishable from a REST-created one —
 *   • `source` is set (here: 'mcp_http'),
 *   • the persisted `amount` is rounded to currency precision (issue #208),
 *   • payee/note/tags are ENCRYPTED before the helper sees them (`v1:` prefix),
 *   • the sign-vs-category advisory is respected (warning surfaced, row lands),
 * and that `invalidateUser` fires after the write (per-user MCP tx cache).
 *
 * Because in the live HTTP MCP context the `db` handle passed to
 * `registerPgTools` IS `@/db` (src/app/api/mcp/route.ts) — the very Drizzle
 * proxy `createTransaction` writes through — routing through the helper
 * produces the identical row. The mock pins the field-mapping contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// Stable env so the auth/encryption modules don't blow up at import time.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// ── Mocks ──────────────────────────────────────────────────────────────────
// Spy on the shared domain helper. We keep the REAL `deriveTxWriteWarnings`
// (the handler imports both from the same module) by spreading the actual
// module and overriding only `createTransaction`. The returned row mirrors the
// Drizzle row shape (camelCase) the helper produces.
const createTransactionSpy = vi.fn();
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    createTransaction: (...args: unknown[]) => createTransactionSpy(...args),
  };
});

// Non-investment account so the investment-FK guard + cash-sleeve path are
// skipped — we want the plain cash-row path that mirrors a REST POST.
// record_transaction calls `isInvestmentAccount` (per-row); bulk pre-fetches
// `getInvestmentAccountIds`. Both hit `@/db` (uninitialized in tests), so
// stub both to "no investment accounts".
vi.mock("@/lib/investment-account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/investment-account")>();
  return {
    ...actual,
    isInvestmentAccount: vi.fn(async () => false),
    getInvestmentAccountIds: vi.fn(async () => new Set<number>()),
  };
});

// Per-user MCP tx cache — assert invalidateUser fires after the write.
const invalidateUserSpy = vi.fn();
vi.mock("@/lib/mcp/user-tx-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/user-tx-cache")>();
  return { ...actual, invalidateUser: (...a: unknown[]) => invalidateUserSpy(...a) };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { encryptField, decryptField } from "../../src/lib/crypto/envelope";
import { roundMoney } from "../../src/lib/money";

const DEK = randomBytes(32);

/**
 * Fake DbLike for the resolution SELECTs the handler runs BEFORE the write:
 *   1. accounts lookup (id, currency, name_ct, alias_ct)
 *   2. categories list (id, name_ct) for fuzzy category resolution
 *   3. category detail (name_ct, type) for the sign-vs-category check
 * Routes by substring-matching the serialized SQL text. Everything else
 * returns an empty rowset.
 */
function makeResolverDb() {
  const acctNameCt = encryptField(DEK, "Everyday Chequing");
  const catNameCt = encryptField(DEK, "Groceries");
  const db = {
    execute: async (q: unknown) => {
      const text = serializeSqlTemplate(q);
      if (/FROM\s+accounts/i.test(text)) {
        return {
          rows: [{ id: 7, currency: "USD", name_ct: acctNameCt, alias_ct: null }],
          rowCount: 1,
        };
      }
      // `WHERE id = ` → the single-category detail read for sign-vs-category.
      if (/FROM\s+categories\b/i.test(text) && /WHERE\s+id\s*=/i.test(text)) {
        return { rows: [{ name_ct: catNameCt, type: "E" }], rowCount: 1 };
      }
      // The category-list read for fuzzy resolution.
      if (/FROM\s+categories\b/i.test(text)) {
        return { rows: [{ id: 12, name_ct: catNameCt }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const result = sqlObj.toQuery?.(dialect);
    if (result && typeof result.sql === "string") return result.sql;
  } catch {
    /* fall through */
  }
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) {
      out += (c as { value: string[] }).value.join("");
    } else if (typeof c === "string") {
      out += c;
    }
  }
  return out;
}

function bootstrap() {
  const db = makeResolverDb();
  const server = new McpServer({ name: "parity-test", version: "0.0.0" });
  registerPgTools(server, db, "user-1", DEK);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler?: (args: unknown, extra: unknown) => Promise<unknown> }
  >;
  return { tools };
}

// v4.1 clean break: the per-verb aliases (record_transaction,
// bulk_record_transactions) were removed; both fold into
// `manage_transactions(op:"record")` — the record op handles a single row AND
// the `transactions[]` array. Grab the union tool and wrap its handler to inject
// the `op` discriminator so each test's args stay identical. Returns undefined
// if the union tool isn't registered so the `toBeDefined()` registration
// assertion still means something.
const ALIAS_TO_CONSOLIDATED: Record<string, { tool: string; op: string }> = {
  record_transaction: { tool: "manage_transactions", op: "record" },
  bulk_record_transactions: { tool: "manage_transactions", op: "record" },
};

function getConsolidatedTool(
  tools: Record<string, { handler?: (args: unknown, extra: unknown) => Promise<unknown> }>,
  name: string,
): { handler: (args: unknown, extra: unknown) => Promise<unknown> } | undefined {
  const map = ALIAS_TO_CONSOLIDATED[name];
  if (!map) throw new Error(`no consolidated mapping for ${name}`);
  const tool = tools[map.tool];
  if (!tool?.handler) return undefined;
  const handler = tool.handler;
  return {
    handler: (args: unknown, extra: unknown) =>
      handler({ op: map.op, ...(args as Record<string, unknown>) }, extra),
  };
}

beforeEach(() => {
  createTransactionSpy.mockReset();
  invalidateUserSpy.mockReset();
  // Default: echo back a Drizzle-shaped row with the audit trio populated, as
  // the real helper would after the INSERT ... RETURNING.
  createTransactionSpy.mockImplementation(async (_userId: string, data: Record<string, unknown>) => ({
    id: 4242,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    source: data.source,
    tradeLinkId: data.tradeLinkId ?? null,
    ...data,
  }));
});

describe("FINLYNQ-108 — record_transaction routes through createTransaction", () => {
  it("hands createTransaction an encrypted, rounded, source-stamped payload (REST-parity)", async () => {
    const { tools } = bootstrap();
    const tool = getConsolidatedTool(tools, "record_transaction");
    expect(tool, "record_transaction is registered").toBeDefined();
    const cb = tool!.handler;

    const res = await cb(
      {
        amount: -12.345, // intentionally sub-cent to prove issue #208 rounding
        payee: "Whole Foods",
        account_id: 7,
        category: "Groceries",
        note: "weekly shop",
        tags: "food",
        date: "2026-06-03",
      },
      {},
    );

    // The write went through the shared helper exactly once — not a raw INSERT.
    expect(createTransactionSpy).toHaveBeenCalledTimes(1);
    const [userIdArg, data, dekArg] = createTransactionSpy.mock.calls[0];
    expect(userIdArg).toBe("user-1");
    expect(dekArg).toBe(DEK);

    // Audit-source attribution is structural (issue #28).
    expect(data.source).toBe("mcp_http");
    // Issue #208 — persisted amount rounded to USD cents before the helper
    // (the sub-cent input is rounded, not passed raw). Pin to the actual
    // `roundMoney` output so the test tracks the helper, not a hand-guess.
    expect(data.amount).toBe(roundMoney(-12.345, "USD"));
    expect(data.amount).not.toBe(-12.345);
    // Account / category FKs resolved.
    expect(data.accountId).toBe(7);
    expect(data.categoryId).toBe(12);
    expect(data.currency).toBe("USD");
    // Payee / note / tags are ENCRYPTED before the helper sees them — same as
    // the REST path's `encryptTxWrite` (Stream-D / plaintext-gap contract).
    expect(typeof data.payee).toBe("string");
    expect((data.payee as string).startsWith("v1:")).toBe(true);
    expect(decryptField(DEK, data.payee as string)).toBe("Whole Foods");
    expect((data.note as string).startsWith("v1:")).toBe(true);
    expect((data.tags as string).startsWith("v1:")).toBe(true);

    // Per-user MCP tx cache invalidated after the commit.
    expect(invalidateUserSpy).toHaveBeenCalledWith("user-1");

    // Response surfaces the audit trio from the returned row.
    const body = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(body.success).toBe(true);
    expect(body.data.transactionId).toBe(4242);
    expect(body.data.source).toBe("mcp_http");
    expect(body.data.updatedAt).toBeTruthy();
    expect(body.data.createdAt).toBeTruthy();
  });

  it("surfaces the sign-vs-category advisory but still writes the row (warn-but-allow)", async () => {
    const { tools } = bootstrap();
    const cb = getConsolidatedTool(tools, "record_transaction")!.handler;

    // Positive amount on an Expense ('E') category violates the sign rule →
    // advisory warning, but the row must still land (createTransaction called).
    const res = await cb(
      { amount: 50, payee: "Refund?", account_id: 7, category: "Groceries", date: "2026-06-03" },
      {},
    );

    expect(createTransactionSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.warnings)).toBe(true);
    // sign-vs-category advisory present in the warnings array.
    expect(body.data.warnings.some((w: string) => /income|expense|positive|negative|sign/i.test(w))).toBe(true);
  });

  it("does not call createTransaction on dryRun (no write)", async () => {
    const { tools } = bootstrap();
    const cb = getConsolidatedTool(tools, "record_transaction")!.handler;
    const res = await cb(
      { amount: -10, payee: "Preview", account_id: 7, category: "Groceries", dryRun: true, date: "2026-06-03" },
      {},
    );
    expect(createTransactionSpy).not.toHaveBeenCalled();
    expect(invalidateUserSpy).not.toHaveBeenCalled();
    const body = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(body.data.dryRun).toBe(true);
    expect(body.data.wouldBeId).toBeNull();
  });
});

describe("FINLYNQ-108 — bulk_record_transactions routes through createTransaction", () => {
  it("calls createTransaction once per row with source='mcp_http' + encrypted payee", async () => {
    const { tools } = bootstrap();
    const cb = getConsolidatedTool(tools, "bulk_record_transactions")!.handler;

    const res = await cb(
      {
        account_id: 7,
        transactions: [
          { amount: -5.5, payee: "Coffee", category: "Groceries" },
          { amount: -9.999, payee: "Lunch", category: "Groceries", date: "2026-06-03" },
        ],
      },
      {},
    );

    expect(createTransactionSpy).toHaveBeenCalledTimes(2);
    for (const call of createTransactionSpy.mock.calls) {
      const data = call[1] as Record<string, unknown>;
      expect(data.source).toBe("mcp_http");
      expect((data.payee as string).startsWith("v1:")).toBe(true);
    }
    // Second row's sub-cent amount rounded via the same helper.
    const secondData = createTransactionSpy.mock.calls[1][1] as Record<string, unknown>;
    expect(secondData.amount).toBe(roundMoney(-9.999, "USD"));

    expect(invalidateUserSpy).toHaveBeenCalledWith("user-1");
    const body = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(body.success).toBe(true);
    expect(body.data.imported).toBe(2);
  });
});

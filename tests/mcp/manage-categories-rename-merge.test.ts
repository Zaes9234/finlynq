/**
 * FINLYNQ-275 — manage_categories `rename` + `merge` ops.
 *
 * Two new ops on the consolidated `manage_categories` discriminated union:
 *   - `rename`  — pure metadata write (id fast-path over fuzzy name); a
 *                 duplicate name is refused with a clear error, not a DB 500.
 *   - `merge`   — TWO-STEP via withConfirmation: preview returns per-type
 *                 dependent counts + a token; commit atomically repoints EVERY
 *                 dependent (transactions / splits / subscriptions / budgets /
 *                 budget_templates / recurring / email rules / rule JSONB) into
 *                 the target, then deletes the source.
 *
 * Structure mirrors the FINLYNQ-260 readonly-contract pattern:
 *   - Registration/enumeration assertions run DB-FREE (always in CI).
 *   - Behavioural assertions run against a seeded `finlynq_test` Postgres and
 *     SKIP when no `*_test` DB is configured (DATABASE_URL not naming `_test`).
 *
 * Run: DATABASE_URL=postgres://…/finlynq_test npx vitest run \
 *        tests/mcp/manage-categories-rename-merge.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { CONSOLIDATED_JSON_SCHEMAS } from "../../mcp-server/tools/_consolidate";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  recordTransaction,
} from "../helpers/portfolio-fixtures";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type ToolResponse = { content: Array<{ type: string; text: string }> };
type Handler = (args: unknown, extra: unknown) => Promise<ToolResponse>;

/** Success responses carry a JSON `{ success, data }` envelope. */
function parse(res: ToolResponse): Record<string, unknown> {
  expect(Array.isArray(res.content)).toBe(true);
  expect(res.content[0]?.type).toBe("text");
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

/** err() returns plain text `Error: <msg>` (NOT JSON). Return the raw text. */
function errText(res: ToolResponse): string {
  return res.content[0]?.text ?? "";
}

// ─── DB-free: op enum advertises rename + merge ──────────────────────────────
describe("manage_categories ops (registration, no DB)", () => {
  it("registers the manage_categories tool with create/rename/merge/delete ops", () => {
    const server = new McpServer({ name: "mc-enum", version: "0.0.0" });
    registerPgTools(server, { execute: async () => ({ rows: [], rowCount: 0 }) }, "u", TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    expect(tools.manage_categories).toBeTruthy();
    // The advertised oneOf schema enumerates every op literal.
    const schema = CONSOLIDATED_JSON_SCHEMAS.get("manage_categories") as {
      oneOf?: Array<{ properties?: { op?: { const?: string } } }>;
    };
    const ops = (schema.oneOf ?? []).map((b) => b.properties?.op?.const).sort();
    expect(ops).toEqual(["create", "delete", "merge", "rename"]);
  });
});

// ─── DB-backed behaviour ─────────────────────────────────────────────────────
describeDb("manage_categories rename + merge (seeded DB)", () => {
  let userId: string;
  let accountId: number;
  let handler: Handler;

  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  async function freshWorld() {
    await resetTestDb();
    userId = await createTestUser();
    accountId = await createAccount({ userId, name: "Chequing", currency: "USD", isInvestment: false });
    const { db } = await import("@/db");
    const server = new McpServer({ name: "mc-db", version: "0.0.0" });
    registerPgTools(server, db as never, userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler = (server as any)._registeredTools.manage_categories.handler as Handler;
  }

  it("rename: happy path changes the name; the FK stays put", async () => {
    await freshWorld();
    const catId = await createCategory({ userId, name: "Dining", type: "E" });
    const txId = await recordTransaction({ userId, accountId, categoryId: catId, currency: "USD", amount: -10 });

    const res = parse(await handler({ op: "rename", id: catId, new_name: "Restaurants" }, { requestId: 1 }));
    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.newName).toBe("Restaurants");

    const { db } = await import("@/db");
    // The tx still references the SAME category id (only the label changed).
    const rows = (await db.execute(
      sql`SELECT category_id FROM transactions WHERE id = ${txId}`,
    )) as unknown as { rows: Array<{ category_id: number }> };
    expect(Number(rows.rows[0].category_id)).toBe(catId);
  });

  it("rename: duplicate name → clear conflict error, no change", async () => {
    await freshWorld();
    const a = await createCategory({ userId, name: "Groceries", type: "E" });
    await createCategory({ userId, name: "Utilities", type: "E" });

    const res = await handler({ op: "rename", id: a, new_name: "Utilities" }, { requestId: 1 });
    expect(errText(res)).toMatch(/^Error:/);
    expect(errText(res)).toMatch(/already exists/i);
  });

  it("merge: preview reports per-type counts + token; commit repoints all + deletes source", async () => {
    await freshWorld();
    const src = await createCategory({ userId, name: "Dining", type: "E" });
    const tgt = await createCategory({ userId, name: "Food & drink", type: "E" });
    // Dependents across ≥2 types: two transactions + a subscription + a budget.
    await recordTransaction({ userId, accountId, categoryId: src, currency: "USD", amount: -10 });
    await recordTransaction({ userId, accountId, categoryId: src, currency: "USD", amount: -20 });
    const { db } = await import("@/db");
    await db.execute(sql`INSERT INTO subscriptions (user_id, amount, currency, frequency, category_id) VALUES (${userId}, 30, 'USD', 'monthly', ${src})`);
    await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${src}, '2026-07', 100, 'USD')`);

    // Preview (no token) — writes nothing.
    const previewData = (parse(await handler({ op: "merge", source: src, target: tgt }, { requestId: 1 })).data) as Record<string, unknown>;
    expect(previewData.preview).toBe(true);
    const token = (previewData as { confirmationToken?: string }).confirmationToken;
    expect(typeof token).toBe("string");
    const summary = previewData.summary as { dependents: Record<string, number>; totalDependents: number };
    expect(summary.dependents.transactions).toBe(2);
    expect(summary.dependents.subscriptions).toBe(1);
    expect(summary.dependents.budgets).toBe(1);
    expect(summary.totalDependents).toBe(4);
    // Source still exists after preview (no writes).
    const stillThere = (await db.execute(sql`SELECT id FROM categories WHERE id = ${src}`)) as unknown as { rows: unknown[] };
    expect(stillThere.rows.length).toBe(1);

    // Commit with the token.
    const commitData = (parse(await handler({ op: "merge", source: src, target: tgt, confirmation_token: token }, { requestId: 2 })).data) as Record<string, unknown>;
    expect(commitData.merged).toBe(true);
    expect((commitData.repointed as Record<string, number>).transactions).toBe(2);

    // Source gone; every dependent now on target; nothing left on source.
    const gone = (await db.execute(sql`SELECT id FROM categories WHERE id = ${src}`)) as unknown as { rows: unknown[] };
    expect(gone.rows.length).toBe(0);
    const onTgt = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = ${userId} AND category_id = ${tgt}`)) as unknown as { rows: Array<{ c: number }> };
    expect(onTgt.rows[0].c).toBe(2);
    const onSrc = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = ${userId} AND category_id = ${src}`)) as unknown as { rows: Array<{ c: number }> };
    expect(onSrc.rows[0].c).toBe(0);
    const subOnTgt = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM subscriptions WHERE user_id = ${userId} AND category_id = ${tgt}`)) as unknown as { rows: Array<{ c: number }> };
    expect(subOnTgt.rows[0].c).toBe(1);
    const budOnTgt = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM budgets WHERE user_id = ${userId} AND category_id = ${tgt}`)) as unknown as { rows: Array<{ c: number }> };
    expect(budOnTgt.rows[0].c).toBe(1);
  });

  it("merge: same source & target is refused (no token)", async () => {
    await freshWorld();
    const c = await createCategory({ userId, name: "Solo", type: "E" });
    const res = await handler({ op: "merge", source: c, target: c }, { requestId: 1 });
    expect(errText(res)).toMatch(/same category/i);
  });

  it("merge: unmatched name → not-found; id fast-path resolves", async () => {
    await freshWorld();
    const tgt = await createCategory({ userId, name: "Keeper", type: "E" });
    // Unknown source name → clean not-found err (no token).
    const nf = await handler({ op: "merge", source: "Nonexistent", target: tgt }, { requestId: 1 });
    expect(errText(nf)).toMatch(/not found/i);
  });

  it("merge: ambiguous source name → ambiguous candidate list (no token)", async () => {
    await freshWorld();
    // Two categories sharing a startsWith prefix → substring match is ambiguous.
    await createCategory({ userId, name: "Travel Air", type: "E" });
    await createCategory({ userId, name: "Travel Rail", type: "E" });
    const tgt = await createCategory({ userId, name: "Trips", type: "E" });
    const res = await handler({ op: "merge", source: "Travel", target: tgt }, { requestId: 1 });
    expect(errText(res)).toMatch(/ambiguous/i);
  });
});

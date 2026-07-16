/**
 * FINLYNQ-271 phase 2 — `upload_statement` content-hash idempotency.
 *
 * Re-sending the SAME file bytes while a PENDING staged import for that content
 * hash already exists must return the existing { stagedImportId, duplicateOf }
 * and stage NOTHING (one staged_imports row for that hash), while different
 * bytes create a new staged import. The web upload route stays hash-less
 * (content_hash NULL) and byte-identical — asserted structurally here via the
 * fact that only the MCP path stamps the hash.
 *
 * DB-gated exactly like readonly-contract.test.ts: reuses the
 * `readonly-contract-seed` world (which refuses any non-`*_test` DB) and skips
 * entirely when no `finlynq_test` DATABASE_URL is configured. Run with e.g.
 *   DATABASE_URL=postgres://…/finlynq_test npx vitest run tests/mcp/upload-statement-idempotency.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import {
  CONTRACT_DEK,
  seedContractWorld,
  type SeededWorld,
} from "./readonly-contract-seed";
import { shutdownTestDb } from "../helpers/portfolio-fixtures";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type ToolResponse = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: unknown, extra: unknown) => Promise<ToolResponse>;

/** Parse the { success, data } envelope out of a tool's MCP content response. */
function envelope(res: ToolResponse): { success?: boolean; data?: unknown; error?: unknown } {
  expect(Array.isArray(res.content)).toBe(true);
  expect(res.content.length).toBeGreaterThan(0);
  return JSON.parse(res.content[0].text);
}

const CSV_A =
  "Date,Description,Amount\n2026-01-05,Coffee Shop,-4.50\n2026-01-06,Grocery Mart,-22.30\n";
const CSV_B =
  "Date,Description,Amount\n2026-02-05,Bookstore,-14.00\n2026-02-06,Pharmacy,-9.99\n";

const toBase64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const sha256Hex = (s: string) =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

describeDb("upload_statement content-hash idempotency (FINLYNQ-271)", () => {
  let world: SeededWorld;
  let handler: ToolHandler;

  beforeAll(async () => {
    world = await seedContractWorld();
    const server = new McpServer({ name: "upload-idem", version: "0.0.0" });
    const { db } = await import("@/db");
    // No enabledToolsets passed ⇒ treated as all-enabled (upload_statement is
    // registered regardless; the toolset gate is a route-level concern).
    registerPgTools(server, db as never, world.userId, CONTRACT_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, { handler: ToolHandler }>;
    handler = tools["upload_statement"].handler;
  }, 60_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  it("second identical upload returns duplicateOf = the first id and stages no new row", async () => {
    const args = {
      fileContent: toBase64(CSV_A),
      fileName: "idem-a.csv",
      accountId: world.cashAccountId,
    };

    const first = envelope(await handler(args, {}));
    expect(first.success).toBe(true);
    const firstData = first.data as Record<string, unknown>;
    const firstId = String(firstData.stagedImportId);
    expect(firstId).toBeTruthy();
    // The first upload is NOT a duplicate.
    expect(firstData.duplicateOf).toBeUndefined();

    const second = envelope(await handler(args, {}));
    expect(second.success).toBe(true);
    const secondData = second.data as Record<string, unknown>;
    expect(String(secondData.duplicateOf)).toBe(firstId);
    expect(String(secondData.stagedImportId)).toBe(firstId);

    // Exactly ONE staged_imports row carries this content hash.
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM staged_imports
          WHERE user_id = ${world.userId} AND content_hash = ${sha256Hex(CSV_A)}`,
    );
    // normalize {rows:[]} | [] shapes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (Array.isArray(rows) ? rows : (rows as any).rows) as Array<{ n: number }>;
    expect(Number(out[0].n)).toBe(1);
  }, 60_000);

  it("different bytes create a new staged import (no duplicateOf)", async () => {
    const res = envelope(
      await handler(
        {
          fileContent: toBase64(CSV_B),
          fileName: "idem-b.csv",
          accountId: world.cashAccountId,
        },
        {},
      ),
    );
    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.stagedImportId).toBeTruthy();
    expect(data.duplicateOf).toBeUndefined();

    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(
      sql`SELECT content_hash FROM staged_imports
          WHERE user_id = ${world.userId} AND content_hash = ${sha256Hex(CSV_B)}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (Array.isArray(rows) ? rows : (rows as any).rows) as Array<{ content_hash: string }>;
    expect(out.length).toBe(1);
    expect(out[0].content_hash).toBe(sha256Hex(CSV_B));
  }, 60_000);
});

/**
 * FINLYNQ-264 Phase 1 — tc-1 gate coverage for `delete_transfer`.
 *
 * tc-1 (primary): "No tool can irreversibly remove >1 row in a single call:
 * calling delete_transfer without a valid confirmation token is refused and
 * performs no delete; supplying the token completes it."
 *
 * `delete_transfer` removes BOTH legs of a transfer pair. This DB-free suite
 * exercises the PREVIEW branch (which runs against the tool's injected `db`)
 * and asserts:
 *   1. A bare call (no token) returns `{ preview:true, summary, confirmationToken }`
 *      and issues NO `DELETE` — the "performs no delete" half of tc-1.
 *   2. The preview summary echoes BOTH legs (blast radius > 1 row).
 *   3. An INVALID / stale token is refused with a clear error and no delete.
 *
 * The full token→commit round-trip goes through `deleteTransferPair`, which
 * uses the real Drizzle `db` singleton (not the injected fixture), so the
 * commit-deletes-both-legs half is covered by the deployed-dev agent verifier
 * against the demo account (see the item's tc-1 repro).
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { encryptField } from "../../src/lib/crypto/envelope";

type CapturedQuery = { text: string };

function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const result = sqlObj.toQuery?.(dialect);
    if (result && typeof result.sql === "string") return result.sql;
  } catch { /* fall through */ }
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) out += (c as { value: string[] }).value.join("");
    else if (typeof c === "string") out += c;
  }
  return out;
}

function makeFixtureDb(matcher: (sqlText: string) => Record<string, unknown>[] | undefined) {
  const queries: CapturedQuery[] = [];
  const db = {
    execute: async (q: unknown) => {
      const text = serializeSqlTemplate(q);
      queries.push({ text });
      const rows = matcher(text);
      return { rows: rows ?? [], rowCount: rows?.length ?? 0 };
    },
  };
  return { db, queries };
}

function getDeleteTransferTool(db: { execute: (q: unknown) => Promise<unknown> }, dek: Buffer | null) {
  const server = new McpServer({ name: "delete-transfer-test", version: "0.0.0" });
  registerPgTools(server, db, "test-user", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
  // v4.1 clean break: the `delete_transfer` alias was removed; the op lives on
  // `manage_transfers(op:"delete")`. Grab the union tool and wrap its handler to
  // inject the `op` discriminator — every test's args stay identical.
  const tool = tools["manage_transfers"];
  if (!tool) throw new Error("manage_transfers not registered");
  return {
    handler: (args: unknown, extra: unknown) =>
      tool.handler({ op: "delete", ...(args as Record<string, unknown>) }, extra),
  };
}

function envelopeText(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any)?.content?.[0]?.text ?? "";
}

/** Fixture for a clean 2-leg transfer pair identified by transactionId=5001. */
function transferFixture(dek: Buffer) {
  return (sqlText: string): Record<string, unknown>[] | undefined => {
    // seed resolve: link_id from a leg id
    if (/SELECT link_id FROM transactions/i.test(sqlText) && /AND id = /i.test(sqlText)) {
      return [{ link_id: "LINK-XFER-1" }];
    }
    // seed resolve: link_id from a link id
    if (/SELECT link_id FROM transactions/i.test(sqlText) && /AND link_id = /i.test(sqlText)) {
      return [{ link_id: "LINK-XFER-1" }];
    }
    // both legs read
    if (/FROM transactions t/i.test(sqlText) && /link_id = /i.test(sqlText)) {
      return [
        { id: 5001, amount: -100, currency: "USD", date: "2026-01-01", payee: encryptField(dek, "To Savings"), account_ct: encryptField(dek, "Checking") },
        { id: 5002, amount: 100, currency: "USD", date: "2026-01-01", payee: encryptField(dek, "From Checking"), account_ct: encryptField(dek, "Savings") },
      ];
    }
    return [];
  };
}

describe("delete_transfer — tc-1 two-step gate (FINLYNQ-264 Phase 1)", () => {
  it("a bare call previews both legs + a token and deletes NOTHING", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb(transferFixture(dek));
    const tool = getDeleteTransferTool(db, dek);

    const res = await tool.handler({ transactionId: 5001 }, {});
    const text = envelopeText(res);
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(true);
    expect(parsed.data.preview).toBe(true);
    expect(typeof parsed.data.confirmationToken).toBe("string");
    expect(parsed.data.confirmationToken.length).toBeGreaterThan(0);
    // Blast radius > 1 row echoed.
    expect(parsed.data.summary.deletedCount).toBe(2);
    expect(parsed.data.summary.legs).toHaveLength(2);
    // NO delete issued on the preview path.
    expect(queries.filter((q) => /DELETE\s+FROM\s+transactions/i.test(q.text))).toHaveLength(0);
  });

  it("refuses an invalid confirmation token and deletes nothing", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb(transferFixture(dek));
    const tool = getDeleteTransferTool(db, dek);

    const res = await tool.handler({ transactionId: 5001, confirmation_token: "not.a.real.token" }, {});
    const text = envelopeText(res);
    expect(text).toMatch(/Confirmation token invalid/);
    expect(queries.filter((q) => /DELETE\s+FROM\s+transactions/i.test(q.text))).toHaveLength(0);
  });

  it("a token minted for a DIFFERENT pair is rejected (payload binds identity)", async () => {
    const dek = randomBytes(32);
    const { db } = makeFixtureDb(transferFixture(dek));
    const tool = getDeleteTransferTool(db, dek);

    // Mint a token for transactionId=5001.
    const previewText = envelopeText(await tool.handler({ transactionId: 5001 }, {}));
    const token = JSON.parse(previewText).data.confirmationToken as string;

    // Replay it against a DIFFERENT transactionId → payload-mismatch.
    const { db: db2, queries: q2 } = makeFixtureDb(transferFixture(dek));
    const tool2 = getDeleteTransferTool(db2, dek);
    const res = await tool2.handler({ transactionId: 9999, confirmation_token: token }, {});
    expect(envelopeText(res)).toMatch(/Confirmation token invalid/);
    expect(q2.filter((q) => /DELETE\s+FROM\s+transactions/i.test(q.text))).toHaveLength(0);
  });

  it("aborts cleanly (no token) when the pair does not exist", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb(() => []); // no rows for any query
    const tool = getDeleteTransferTool(db, dek);
    const res = await tool.handler({ transactionId: 5001 }, {});
    const text = envelopeText(res);
    expect(text).toMatch(/No transfer pair found/);
    expect(text).not.toMatch(/confirmationToken/);
    expect(queries.filter((q) => /DELETE\s+FROM\s+transactions/i.test(q.text))).toHaveLength(0);
  });
});

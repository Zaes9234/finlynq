/**
 * FINLYNQ-264 (child B) — MCP annotation-registry assertion (tc-2).
 *
 * tc-2 has two clauses:
 *   1. readOnlyHint / destructiveHint / idempotentHint are set on EVERY tool,
 *      verified against the registry (never readOnly-and-destructive at once).
 *   2. The confirmation-token machinery lives in ONE shared middleware, not N
 *      hand-rolled copies.
 *
 * This suite proves both, DB-free (registration only — no handler is invoked).
 *
 *  (1) Register the whole HTTP tool surface against a mock McpServer wrapped in
 *      `withAutoAnnotations` (exactly as both transports do), enumerate
 *      `_registeredTools`, and assert each tool's `annotations` object carries
 *      all three hints as booleans + is never both readOnly and destructive.
 *  (2) grep the HTTP tool surface (`mcp-server/tools/`) and assert
 *      `signConfirmationToken(` / `verifyConfirmationToken(` are each CALLED in
 *      exactly one place — inside the shared `_confirm.ts` middleware.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import {
  withAutoAnnotations,
  inferAnnotations,
  TOOL_ANNOTATION_OVERRIDES,
} from "../../mcp-server/auto-annotations";

type Annotations = {
  title?: unknown;
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  idempotentHint?: unknown;
  openWorldHint?: unknown;
};
type RegisteredTool = { annotations?: Annotations };

/** Register the whole HTTP surface against a mock server + auto-annotations. */
function registerAll(): Record<string, RegisteredTool> {
  const server = withAutoAnnotations(
    new McpServer({ name: "annotation-registry-test", version: "0.0.0" }),
  );
  // dek present so name-resolving registration paths don't short-circuit.
  registerPgTools(server, { execute: async () => ({ rows: [], rowCount: 0 }) }, "default", Buffer.alloc(32));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools as Record<string, RegisteredTool>;
}

describe("MCP annotation registry (FINLYNQ-264 tc-2, clause 1)", () => {
  let tools: Record<string, RegisteredTool>;
  beforeAll(() => {
    tools = registerAll();
  });

  it("registers a non-trivial tool surface", () => {
    expect(Object.keys(tools).length).toBeGreaterThan(100);
  });

  it("every tool carries all three hints as booleans + a title", () => {
    const violations: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      const a = tool.annotations;
      if (!a || typeof a !== "object") {
        violations.push(`${name}: no annotations object`);
        continue;
      }
      if (typeof a.readOnlyHint !== "boolean") violations.push(`${name}: readOnlyHint not boolean (${String(a.readOnlyHint)})`);
      if (typeof a.destructiveHint !== "boolean") violations.push(`${name}: destructiveHint not boolean (${String(a.destructiveHint)})`);
      if (typeof a.idempotentHint !== "boolean") violations.push(`${name}: idempotentHint not boolean (${String(a.idempotentHint)})`);
      if (typeof a.title !== "string" || a.title.length === 0) violations.push(`${name}: title missing`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no tool is BOTH readOnly and destructive", () => {
    const both = Object.entries(tools)
      .filter(([, t]) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map(([name]) => name);
    expect(both, `readOnly+destructive: ${both.join(", ")}`).toEqual([]);
  });

  it("every hard-delete / reject tool is flagged destructive", () => {
    // Every `delete_*` / `reject_*` / `*_delete` tool (that is NOT a read-only
    // preview) must carry destructiveHint:true — the tc-1/tc-2 safety contract.
    const misflagged = Object.entries(tools)
      .filter(([name]) => (/^delete_/.test(name) || /^reject_/.test(name) || /_delete(_|$)/.test(name)) && !name.startsWith("preview_"))
      .filter(([, t]) => t.annotations?.destructiveHint !== true)
      .map(([name]) => name);
    expect(misflagged, `destructive tools missing destructiveHint: ${misflagged.join(", ")}`).toEqual([]);
  });

  it("read-only preview tools stay readOnly, never destructive", () => {
    // preview_delete_category / preview_bulk_delete embed a delete/reject token
    // in their NAME but are pure reads — must be readOnly, not destructive.
    for (const name of ["preview_delete_category", "preview_bulk_delete"]) {
      const a = tools[name]?.annotations;
      expect(a, `${name} registered`).toBeTruthy();
      expect(a?.readOnlyHint, `${name} readOnly`).toBe(true);
      expect(a?.destructiveHint, `${name} not destructive`).toBe(false);
    }
  });

  it("the annotation override map has no stale entries", () => {
    for (const name of Object.keys(TOOL_ANNOTATION_OVERRIDES)) {
      expect(tools[name], `override for unregistered tool "${name}"`).toBeDefined();
      // An override entry must actually apply (inference returns its hints).
      const inferred = inferAnnotations(name);
      const ov = TOOL_ANNOTATION_OVERRIDES[name];
      if (ov.destructiveHint !== undefined) expect(inferred.destructiveHint).toBe(ov.destructiveHint);
      if (ov.readOnlyHint !== undefined) expect(inferred.readOnlyHint).toBe(ov.readOnlyHint);
    }
  });
});

describe("MCP confirmation-token machinery is single-sourced (FINLYNQ-264 tc-2, clause 2)", () => {
  const toolsDir = join(__dirname, "..", "..", "mcp-server", "tools");

  /** Count real CALL sites of `fn(` across every .ts under mcp-server/tools/. */
  function countCallSites(fn: string): { total: number; files: string[] } {
    const files: string[] = [];
    let total = 0;
    for (const entry of readdirSync(toolsDir)) {
      if (!entry.endsWith(".ts")) continue;
      const src = readFileSync(join(toolsDir, entry), "utf8");
      // Count `fn(` occurrences on non-comment lines.
      let n = 0;
      for (const line of src.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        // Match a call, not the import or a type re-export.
        const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
        const m = line.match(re);
        if (m) n += m.length;
      }
      if (n > 0) {
        files.push(entry);
        total += n;
      }
    }
    return { total, files };
  }

  it("signConfirmationToken is called in exactly one file (_confirm.ts)", () => {
    const { total, files } = countCallSites("signConfirmationToken");
    expect(files, `call sites in: ${files.join(", ")}`).toEqual(["_confirm.ts"]);
    expect(total).toBe(1);
  });

  it("verifyConfirmationToken is called in exactly one file (_confirm.ts)", () => {
    const { total, files } = countCallSites("verifyConfirmationToken");
    expect(files, `call sites in: ${files.join(", ")}`).toEqual(["_confirm.ts"]);
    expect(total).toBe(1);
  });
});

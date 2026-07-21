/**
 * reconcile-consolidation D-1 — the OAuth scope gate covers registerTool tools.
 *
 * The MCP route (src/app/api/mcp/route.ts) gates BOTH `server.tool` AND
 * `server.registerTool` with the read/write scope filter. Before D-1 only
 * `server.tool` was patched, so the consolidated `manage_*` / `reconcile` /
 * `portfolio_record_entry` union tools — which register via
 * `server.registerTool` — leaked to a read-only (`mcp:read`) token: registered,
 * advertised, and callable. This suite replicates the route's DUAL patch and
 * asserts a read-only token registers NO union write tool while a write token
 * does; the read-only reconcile discovery tool (`get_reconciliation_summary`)
 * stays reachable under `mcp:read`.
 *
 * DB-free (registration only).
 */
import { describe, it, expect } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import {
  parseScope,
  isToolAllowedForScope,
  enabledToolsetsForRequest,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
} from "../../src/lib/oauth-scopes";
import { isToolInEnabledToolsets } from "../../src/lib/mcp/toolsets";

interface Patchable {
  tool(name: string, ...args: unknown[]): unknown;
  registerTool(name: string, ...args: unknown[]): unknown;
}

/** Register the whole surface under `scopeString`, replicating the route's dual
 *  scope+toolset patch of BOTH `tool` and `registerTool`. Returns the names of
 *  the tools that actually got registered for that scope. */
function registerWithScope(scopeString: string): string[] {
  const server = withAutoAnnotations(
    new McpServer({ name: "scope-gate-test", version: "0.0.0" }),
  );
  const scopeSet = parseScope(scopeString);
  const enabledSets = enabledToolsetsForRequest(scopeSet);
  const gate = (name: string): boolean =>
    isToolAllowedForScope(name, scopeSet) && isToolInEnabledToolsets(name, enabledSets);
  const s = server as unknown as Patchable;
  const origTool = s.tool.bind(server);
  s.tool = (name: string, ...args: unknown[]) => (gate(name) ? origTool(name, ...args) : undefined);
  const origReg = s.registerTool.bind(server);
  s.registerTool = (name: string, ...args: unknown[]) => (gate(name) ? origReg(name, ...args) : undefined);
  registerPgTools(server, { execute: async () => ({ rows: [], rowCount: 0 }) }, "default", Buffer.alloc(32));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.keys((server as any)._registeredTools as Record<string, unknown>);
}

// Union write tools registered via server.registerTool (the D-1 hole class) +
// the 3 folded reconcile/import unions.
const UNION_WRITE_TOOLS = [
  "reconcile",
  "manage_statement_import",
  "manage_bank_ledger",
  "manage_transactions",
  "manage_accounts",
  "portfolio_record_entry",
];

describe("MCP scope gate covers registerTool (reconcile-consolidation D-1)", () => {
  it("a read-only (mcp:read) token registers NO consolidated union write tool", () => {
    const names = registerWithScope(SCOPE_MCP_READ);
    const leaked = UNION_WRITE_TOOLS.filter((n) => names.includes(n));
    expect(leaked, `union write tools leaked to mcp:read: ${leaked.join(", ")}`).toEqual([]);
  });

  it("a read-only token still gets the read tools (incl. the reconcile discovery read)", () => {
    const names = registerWithScope(SCOPE_MCP_READ);
    expect(names).toContain("get_reconciliation_summary");
    expect(names).toContain("get_net_worth");
    expect(names).toContain("search_transactions");
  });

  it("a write (mcp:read mcp:write) token registers the consolidated union tools", () => {
    const names = registerWithScope(`${SCOPE_MCP_READ} ${SCOPE_MCP_WRITE}`);
    for (const n of UNION_WRITE_TOOLS) {
      expect(names, `${n} present under write scope`).toContain(n);
    }
  });
});

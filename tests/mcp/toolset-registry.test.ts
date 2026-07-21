/**
 * Toolset-registry assertion (reconcile-consolidation, was FINLYNQ-263 child A).
 *
 * The statement-import + bank-reconcile cohort was folded into the default-ON
 * `reconcile` / `manage_statement_import` / `manage_bank_ledger` union tools and
 * the `import-pipeline` toolset was RETIRED (un-gated — resolves #306). This
 * tripwire now asserts every registered tool maps to one of the surviving sets
 * (analytics | ledger-write | admin), that no retired per-verb reconcile/import
 * name survives, and that the folded cohort is DEFAULT-ON in every session.
 *
 * DB-free (registration only).
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import {
  toolsetForTool,
  isToolInEnabledToolsets,
  DEFAULT_TOOLSETS,
  type Toolset,
} from "../../src/lib/mcp/toolsets";

/** The 3 folded union tools + the standalone reconcile read. */
const RECONCILE_SURFACE = [
  "reconcile",
  "manage_statement_import",
  "manage_bank_ledger",
  "get_reconciliation_summary",
] as const;

/** Every per-verb name the clean break removed (must not survive on ANY surface). */
const RETIRED_RECONCILE_NAMES = [
  "upload_statement",
  "get_reconcile_suggestions",
  "accept_reconcile_suggestion",
  "accept_reconcile_suggestions",
  "unlink_reconcile",
  "materialize_bank_row",
  "send_to_bank_ledger",
  "find_duplicate_bank_rows",
  "get_balance_anchors",
  "upsert_balance_anchor",
  "delete_bank_transaction",
  "apply_rules_to_bank_rows",
  "apply_rules_to_staged_import",
  "list_staged_imports",
  "get_staged_import",
  "list_staged_transactions",
  "update_staged_transaction",
  "link_staged_transfer_pair",
  "approve_staged_rows",
  "reject_staged_import",
  "list_pending_uploads",
  "preview_import",
  "execute_import",
  "cancel_import",
] as const;

function registeredNames(): string[] {
  const server = withAutoAnnotations(
    new McpServer({ name: "toolset-registry-test", version: "0.0.0" }),
  );
  registerPgTools(
    server,
    { execute: async () => ({ rows: [], rowCount: 0 }) },
    "default",
    Buffer.alloc(32),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.keys((server as any)._registeredTools as Record<string, unknown>);
}

describe("MCP toolset registry (reconcile-consolidation)", () => {
  let names: string[];
  beforeAll(() => {
    names = registeredNames();
  });

  it("every registered tool maps to exactly one valid toolset", () => {
    const valid: Toolset[] = ["analytics", "ledger-write", "admin"];
    for (const name of names) {
      const set = toolsetForTool(name);
      expect(valid, `${name} → ${set}`).toContain(set);
    }
  });

  it("the retired import-pipeline set is gone — nothing derives to it", () => {
    // With no user-facing default-OFF set, every tool is analytics | ledger-write.
    const sets = new Set(names.map(toolsetForTool));
    expect([...sets].sort()).toEqual(["analytics", "ledger-write"]);
  });

  it("the 3 folded union tools + get_reconciliation_summary are all default-ON", () => {
    for (const n of RECONCILE_SURFACE) {
      expect(names, `${n} registered`).toContain(n);
      expect(isToolInEnabledToolsets(n, DEFAULT_TOOLSETS), `${n} default-on`).toBe(true);
    }
  });

  it("get_reconciliation_summary is a read (analytics); the union tools are ledger-write", () => {
    expect(toolsetForTool("get_reconciliation_summary")).toBe("analytics");
    expect(toolsetForTool("reconcile")).toBe("ledger-write");
    expect(toolsetForTool("manage_statement_import")).toBe("ledger-write");
    expect(toolsetForTool("manage_bank_ledger")).toBe("ledger-write");
  });

  it("no retired reconcile/import per-verb name survives on the registered surface", () => {
    const survivors = RETIRED_RECONCILE_NAMES.filter((n) => names.includes(n));
    expect(survivors, `retired names still registered: ${survivors.join(", ")}`).toEqual([]);
  });

  it("the default-profile tools/list advertises the folded union tools (no gating)", async () => {
    const { dumpToolsList } = await import("./eval/dump-tools-list");
    const defProfile = await dumpToolsList((n) =>
      isToolInEnabledToolsets(n, DEFAULT_TOOLSETS),
    );
    const listed = defProfile.map((t) => t.name);
    for (const n of ["reconcile", "manage_statement_import", "manage_bank_ledger"]) {
      expect(listed, `${n} advertised in default profile`).toContain(n);
    }
  });
});

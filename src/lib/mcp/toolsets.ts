/**
 * MCP session-scoped toolsets (FINLYNQ-263, child A of the MCP-surface-v4 epic).
 *
 * This module tags each tool with a `toolset` and lets the MCP server expose
 * only the sets a given connection is entitled to.
 *
 * Sets:
 *   - `analytics`    — all read tools (default-ON).
 *   - `ledger-write` — record/update/delete ledger + portfolio + config +
 *                      import/reconcile writes (default-ON).
 *   - `admin`        — reserved (no user-facing connector tools today).
 *
 * History: the statement-import + bank-reconcile cohort used to live in a
 * default-OFF `import-pipeline` set gated behind the `mcp:import` scope — but
 * hosted-cloud users could never reach it (#306), so the cohort was folded into
 * the `reconcile` / `manage_statement_import` / `manage_bank_ledger` union
 * tools and UN-gated (reconcile-consolidation). Those unions derive to
 * `ledger-write` by the name heuristic (no read prefix); `get_reconciliation_
 * summary` stays a read → `analytics`. Everything is default-ON now — no opt-in
 * of any kind. The `admin` seam + `isToolInEnabledToolsets` filter are retained
 * for a future reserved cohort.
 *
 * Read-only classification mirrors auto-annotations.ts / oauth-scopes.ts — kept
 * in sync via the shared `READ_PREFIXES` semantics (duplicated here to avoid a
 * server↔lib import cycle, same rationale as oauth-scopes.ts).
 */

export type Toolset = "analytics" | "ledger-write" | "admin";

/**
 * The default-ON sets. A connection with no explicit toolset entitlement sees
 * exactly these — analytics + ledger-write (which now includes the folded
 * import/reconcile writes). No default-OFF set remains for user-facing tools.
 */
export const DEFAULT_TOOLSETS: ReadonlySet<Toolset> = new Set<Toolset>([
  "analytics",
  "ledger-write",
]);

const READ_PREFIXES = [
  "get_",
  "list_",
  "find_",
  "search_",
  "analyze_",
  "preview_",
  "test_",
  "trace_",
  "detect_",
  "convert_",
  "suggest_",
  "describe_",
  "read_",
] as const;

const READ_ONLY_EXACT_NAMES = new Set<string>(["finlynq_help"]);

function isReadOnlyName(name: string): boolean {
  if (READ_ONLY_EXACT_NAMES.has(name)) return true;
  if (name.endsWith("_help")) return true;
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * The toolset a given tool belongs to. Precedence:
 *   1. read tools → analytics,
 *   2. everything else → ledger-write.
 *
 * Pure + total: every tool name maps to exactly one set. (The `admin` set is
 * reserved — no tool derives to it today.)
 */
export function toolsetForTool(name: string): Toolset {
  if (isReadOnlyName(name)) return "analytics";
  return "ledger-write";
}

/**
 * Decision: should the MCP server register `toolName` for a connection entitled
 * to `enabled` toolsets? A tool is exposed iff its set is enabled.
 */
export function isToolInEnabledToolsets(
  toolName: string,
  enabled: ReadonlySet<Toolset>,
): boolean {
  return enabled.has(toolsetForTool(toolName));
}

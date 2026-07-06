/**
 * FINLYNQ-263 (child A) — helpers for CRUD consolidation: discriminated-union
 * `manage_*` tool registration, hidden back-compat aliases, and the filtered
 * `tools/list` builder.
 *
 * A consolidated tool folds a per-verb CRUD family (add/update/delete/list …)
 * into ONE `registerTool` call whose input is a `z.discriminatedUnion` on `op`
 * (or `entry_type` for `portfolio_record_entry`). Per-op handler bodies are
 * lifted VERBATIM from the old 1:1 tools, so response shapes stay byte-identical.
 *
 * ### The SDK / JSON-Schema constraint (verified against @modelcontextprotocol/sdk)
 * The SDK's `tools/list` only knows how to render a raw object shape or a Zod
 * OBJECT schema — a top-level `z.discriminatedUnion` normalizes to `undefined`,
 * so the SDK emits an EMPTY inputSchema for it (fields vanish from tools/list).
 * VALIDATION still runs against the union (the SDK falls back to the raw schema
 * in `validateToolInput`), so a bad op+field combo is rejected at the schema
 * layer (tc-2). To ALSO advertise a proper JSON-Schema `oneOf`, we pre-compute
 * the schema with Zod v4's native `z.toJSONSchema(union)` (which emits `oneOf`
 * with a `const` on the discriminator per branch) and store it in
 * `CONSOLIDATED_JSON_SCHEMAS`. The MCP route's `tools/list` handler
 * (`buildFilteredToolsList`) substitutes that schema for the consolidated tools.
 *
 * ### Aliases (owner decision #1 — hidden aliases for one minor version)
 * Each old tool name is registered as a thin wrapper that injects the
 * discriminator + delegates to the same per-op handler, then recorded in
 * `ALIAS_NAMES` so `buildFilteredToolsList` hides it (callable, but not
 * advertised). Aliases are removed in v4.1.
 *
 * `withAutoAnnotations` already patches BOTH `server.tool` and
 * `server.registerTool` (FINLYNQ-264), so consolidated tools + aliases inherit
 * inferred annotations automatically.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type AnyZod = z.ZodTypeAny;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Pre-computed JSON Schema (`oneOf`) for each consolidated `manage_*` /
 * `portfolio_record_entry` tool, keyed by tool name. Populated at registration
 * time by `registerManageTool`; consumed by `buildFilteredToolsList` to
 * override the (empty) schema the SDK would otherwise emit for a union input.
 *
 * Module-level (the schema is identical across users/sessions).
 */
export const CONSOLIDATED_JSON_SCHEMAS: Map<string, unknown> = new Map();

/**
 * The alias registry — the set of retired tool NAMES that forward to a
 * consolidated tool. `buildFilteredToolsList` consults it to hide aliases from
 * the advertised surface while leaving them callable. Module-level Set (the
 * alias name set is static across all users/sessions; recording twice is a
 * no-op).
 */
export const ALIAS_NAMES: Set<string> = new Set();

/**
 * Register a consolidated `manage_*` tool from a discriminated union. The union
 * drives VALIDATION (a bad op+field combo is rejected — tc-2); its native
 * `z.toJSONSchema` `oneOf` is recorded for `tools/list` advertisement.
 *
 * @param server   the McpServer (already auto-annotated)
 * @param name     the consolidated tool name (e.g. "manage_goals")
 * @param description  the tool description (verb-first, distinct first 60 chars)
 * @param union    a `z.discriminatedUnion(...)` over the op/entry_type variants
 * @param handler  receives the validated (narrowed) input; switches on the
 *                 discriminator and returns the per-op result verbatim
 */
export function registerManageTool<U extends AnyZod>(
  server: McpServer,
  name: string,
  description: string,
  union: U,
  handler: (input: z.infer<U>) => Promise<ToolResult>,
): void {
  // Record the native-v4 oneOf JSON schema for tools/list advertisement.
  try {
    CONSOLIDATED_JSON_SCHEMAS.set(name, z.toJSONSchema(union));
  } catch {
    // If schema generation ever fails, tools/list falls back to the SDK's
    // (empty) rendering — validation is unaffected. Non-fatal.
    CONSOLIDATED_JSON_SCHEMAS.delete(name);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(
    name,
    { description, inputSchema: union },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (input: any) => handler(input as z.infer<U>),
  );
}

/**
 * Register a hidden back-compat alias `oldName` that forwards to the same
 * per-op handler as a consolidated tool, taking the OLD raw-shape fields (no
 * discriminator) exactly as the retired tool did — so clients that hardcoded
 * the old name + old args keep working. Hidden from `tools/list` via
 * `ALIAS_NAMES`.
 */
export function registerAlias(
  server: McpServer,
  oldName: string,
  description: string,
  inputSchema: z.ZodRawShape,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<ToolResult>,
): void {
  ALIAS_NAMES.add(oldName);
  server.tool(oldName, description, inputSchema, handler);
}

/** True iff `name` is a hidden back-compat alias (excluded from `tools/list`). */
export function isAliasName(name: string): boolean {
  return ALIAS_NAMES.has(name);
}

/** A single `tools/list` entry (the subset the route re-emits). */
export type ToolsListEntry = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
};

/**
 * Build the FILTERED `tools/list` response from a registered server. Replaces
 * the SDK's default list handler at the MCP route so we can:
 *   1. HIDE aliases (`ALIAS_NAMES`) — callable but not advertised (decision #1),
 *   2. GATE by toolset — drop tools whose set isn't enabled for the connection
 *      (`isEnabled(name)` returns false), and
 *   3. SUBSTITUTE the pre-computed `oneOf` JSON schema for consolidated tools
 *      (the SDK would otherwise emit an empty schema for a union input).
 *
 * `isEnabled` is the per-connection toolset predicate (from
 * `isToolInEnabledToolsets` bound to the resolved sets). Passing `() => true`
 * yields the full (alias-hidden, schema-corrected) surface.
 *
 * The SDK's own JSON-Schema rendering is reused for every NON-consolidated tool
 * by reading the already-normalized `inputSchema` off `_registeredTools` via a
 * throwaway list call — but to stay decoupled from SDK internals we instead ask
 * the SDK to render the list ONCE and post-process it.
 */
export function buildFilteredToolsList(
  sdkTools: ToolsListEntry[],
  isEnabled: (name: string) => boolean,
): ToolsListEntry[] {
  const out: ToolsListEntry[] = [];
  for (const t of sdkTools) {
    if (isAliasName(t.name)) continue;
    if (!isEnabled(t.name)) continue;
    const override = CONSOLIDATED_JSON_SCHEMAS.get(t.name);
    out.push(override ? { ...t, inputSchema: override } : t);
  }
  return out;
}

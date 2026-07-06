/**
 * FINLYNQ-263 (child A) — dump the HTTP MCP `tools/list` surface.
 *
 * Registers the full HTTP tool surface against a mock McpServer (exactly as
 * the transports do, wrapped in withAutoAnnotations) and prints, to stdout, a
 * deterministic JSON array of `{ name, description, inputSchema }` (input
 * schema = the JSON Schema the SDK emits from each tool's Zod input).
 *
 * Used by:
 *   - the Phase-0 golden baseline snapshot (`tools-list.baseline.json`), the
 *     117-tool pre-consolidation reference the eval + count tests compare to;
 *   - the eval harness, which feeds these definitions to the model.
 *
 * Run: `npx tsx tests/mcp/eval/dump-tools-list.ts > out.json`
 */
process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerPgTools } from "../../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../../mcp-server/auto-annotations";
import {
  buildFilteredToolsList,
  type ToolsListEntry,
} from "../../../mcp-server/tools/_consolidate";

export type ToolListEntry = {
  name: string;
  description: string;
  inputSchema: unknown;
};

/**
 * Render the ADVERTISED HTTP surface exactly as the MCP route does: ask the SDK
 * to render `tools/list` (which produces correct JSON Schema for every raw-shape
 * tool), then post-process with `buildFilteredToolsList` (full surface —
 * `() => true`) to hide aliases + substitute the `oneOf` schema for consolidated
 * tools. Sorted by name for deterministic diffs.
 *
 * `optsFilter` lets callers apply a toolset predicate (e.g. default-profile
 * only) instead of the full surface.
 */
export async function dumpToolsList(
  optsFilter: (name: string) => boolean = () => true,
): Promise<ToolListEntry[]> {
  const server = withAutoAnnotations(
    new McpServer({ name: "tools-list-dump", version: "0.0.0" }),
  );
  // dek present so name-resolving registration paths don't short-circuit.
  registerPgTools(
    server,
    { execute: async () => ({ rows: [], rowCount: 0 }) },
    "default",
    Buffer.alloc(32),
  );

  // Reach the SDK's own tools/list handler so every raw-shape tool gets the
  // SDK's exact JSON-Schema rendering (aliases + union tools are then handled
  // by buildFilteredToolsList).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server.server as any)._requestHandlers as Map<
    string,
    (req: unknown, extra: unknown) => Promise<{ tools: ToolsListEntry[] }>
  >;
  const listHandler = handlers.get(ListToolsRequestSchema.shape.method.value);
  if (!listHandler) throw new Error("dumpToolsList: no tools/list handler");
  const { tools: sdkTools } = await listHandler(
    { method: "tools/list", params: {} },
    {},
  );

  const filtered = buildFilteredToolsList(sdkTools, optsFilter);
  const out = filtered.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? null,
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const invokedDirectly = (process.argv[1] ?? "").includes("dump-tools-list");
if (invokedDirectly) {
  dumpToolsList().then((list) => {
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
  });
}

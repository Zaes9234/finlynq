/**
 * FINLYNQ-263 (child A) — golden `tools/list` snapshot + registered-count guard.
 *
 * Phase 0 committed `tests/mcp/eval/tools-list.baseline.json` — the 117-tool
 * pre-consolidation surface (name + description + JSON-Schema inputSchema). It
 * is the reference the eval harness scores against and the frozen record of the
 * surface before any `manage_*` fold.
 *
 * This suite asserts:
 *   1. the LIVE registered surface still parses + registers (mock server),
 *   2. its registered-tool count equals `MCP_TOOL_COUNTS.http` (the single
 *      source of truth) — the vitest twin of the build-time drift check in
 *      `scripts/generate-mcp-tool-catalog.mjs`, so a fold that forgets to bump
 *      the count fails here too,
 *   3. the baseline snapshot is well-formed (117 entries, sorted, unique).
 *
 * DB-free (registration only). The baseline is NOT re-asserted equal to the
 * live surface — consolidation deliberately changes the live surface while the
 * baseline stays frozen at 117 for the eval comparison.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { dumpToolsList } from "./eval/dump-tools-list";
import { MCP_TOOL_COUNTS } from "../../src/lib/mcp/tool-counts";

describe("MCP tools/list surface (FINLYNQ-263 phase 0)", () => {
  it("advertised-tool count equals MCP_TOOL_COUNTS.http", async () => {
    // dumpToolsList = the ADVERTISED surface (aliases hidden). MCP_TOOL_COUNTS.http
    // tracks the advertised count, so aliases (callable-but-hidden) never inflate it.
    const live = await dumpToolsList();
    expect(live.length).toBe(MCP_TOOL_COUNTS.http);
  });

  it("baseline snapshot is well-formed (117 entries, sorted, unique)", () => {
    const raw = readFileSync(
      join(__dirname, "eval", "tools-list.baseline.json"),
      "utf8",
    );
    const baseline = JSON.parse(raw) as Array<{ name: string }>;
    expect(baseline.length).toBe(117);
    const names = baseline.map((t) => t.name);
    // sorted
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    // unique
    expect(new Set(names).size).toBe(names.length);
  });
});

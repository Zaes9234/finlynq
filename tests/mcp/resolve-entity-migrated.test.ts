/**
 * FINLYNQ-267 — tc-2 (code) contract test: the shared resolver is migrated.
 *
 * Asserts, by scanning the MCP HTTP tool modules under `mcp-server/tools/`:
 *   1. `resolveEntity` (the single shared name-resolver) is DEFINED once in
 *      `_shared.ts` and IMPORTED by every migrated write module + the rebalancer.
 *   2. ZERO remaining resolve-to-act `fuzzyFind(` callsites in the tool modules
 *      — the only `fuzzyFind` reference allowed is its own definition/export in
 *      `_shared.ts`. (The stdio `register-core-tools.ts` legacy stack is a
 *      SEPARATE plaintext surface and is out of scope — epic non-goal.)
 *
 * This is the "single util, no per-tool re-implementation" guard: if a future
 * name-accepting handler reaches for bare `fuzzyFind` again, this fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(__dirname, "..", "..", "mcp-server", "tools");

function toolModuleFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => join(TOOLS_DIR, f));
}

describe("FINLYNQ-267 tc-2 — shared resolver migrated", () => {
  it("resolveEntity is defined once in _shared.ts", () => {
    const shared = readFileSync(join(TOOLS_DIR, "_shared.ts"), "utf8");
    const defs = shared.match(/export function resolveEntity\(/g) ?? [];
    expect(defs).toHaveLength(1);
    // The envelope helpers ship alongside it.
    expect(shared).toMatch(/export function resolveOrReport\(/);
    expect(shared).toMatch(/export function collectWarnings\(/);
    expect(shared).toMatch(/export const DEFAULT_STRICT/);
  });

  it("holdings DEFAULT_STRICT is ambiguous:true (the FINLYNQ-267 flip)", () => {
    const shared = readFileSync(join(TOOLS_DIR, "_shared.ts"), "utf8");
    // The holding entry carries the flip + a self-documenting comment.
    expect(shared).toMatch(/ambiguous: true, \/\/ FINLYNQ-267 flip/);
  });

  it("every migrated write module + the rebalancer imports resolveEntity", () => {
    const expected = [
      "accounts.ts",
      "goals.ts",
      "loans.ts",
      "subscriptions.ts",
      "rules.ts",
      "transactions.ts",
      "portfolio.ts",
      "categories.ts",
    ];
    for (const f of expected) {
      const src = readFileSync(join(TOOLS_DIR, f), "utf8");
      expect(src, `${f} should call resolveEntity(`).toMatch(/resolveEntity\(/);
    }
  });

  it("no tool module calls bare fuzzyFind() for a resolve-to-act", () => {
    const offenders: string[] = [];
    for (const path of toolModuleFiles()) {
      const src = readFileSync(path, "utf8");
      // A CALL is `fuzzyFind(` with an arg; the import/definition doesn't count.
      // Strip import lines, then look for an invocation.
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bfuzzyFind\s*\(/.test(line)) {
          offenders.push(`${path.split(/[\\/]/).pop()}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `remaining fuzzyFind callsites:\n${offenders.join("\n")}`).toHaveLength(0);
  });
});

/**
 * FINLYNQ-263 (child A) — scripted tool-selection eval harness (decision #4).
 *
 * For each of the 10 owner-approved flows, feed the model the task + the MCP
 * tool definitions (as Anthropic `tools`) and inspect its FIRST `tool_use`.
 * Score whether that first tool call is in the flow's acceptable set for the
 * surface under test. Run it against BOTH surfaces and compare accuracy:
 *   - `baseline`     — the frozen 117-tool `tools-list.baseline.json`.
 *   - `consolidated` — the LIVE registered surface (post-fold).
 *
 * The acceptance bar (tc-1) is EQUAL-OR-BETTER accuracy on `consolidated` vs
 * `baseline`.
 *
 * Requires `ANTHROPIC_API_KEY`. No SDK dependency — a direct fetch to the
 * Messages API keeps this out of the production bundle. Modest spend: one
 * model, one call per (flow × surface) = 20 calls per full run.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=… npx tsx tests/mcp/eval/run-eval.ts
 *   ANTHROPIC_API_KEY=… npx tsx tests/mcp/eval/run-eval.ts --surface=consolidated
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_FLOWS } from "./flows";
import { dumpToolsList, type ToolListEntry } from "./dump-tools-list";

const MODEL = process.env.EVAL_MODEL || "claude-sonnet-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";

type AnthropicTool = { name: string; description: string; input_schema: unknown };

function toAnthropicTools(list: ToolListEntry[]): AnthropicTool[] {
  return list.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema:
      t.inputSchema && typeof t.inputSchema === "object"
        ? t.inputSchema
        : { type: "object", properties: {} },
  }));
}

function loadBaseline(): ToolListEntry[] {
  const raw = readFileSync(join(__dirname, "tools-list.baseline.json"), "utf8");
  return JSON.parse(raw) as ToolListEntry[];
}

/** Call the model once; return the name of the first tool_use (or null). */
async function firstToolCall(
  apiKey: string,
  tools: AnthropicTool[],
  task: string,
): Promise<string | null> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: task }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    content?: Array<{ type: string; name?: string }>;
  };
  for (const block of body.content ?? []) {
    if (block.type === "tool_use" && block.name) return block.name;
  }
  return null;
}

type FlowResult = {
  id: string;
  surface: "baseline" | "consolidated";
  chosen: string | null;
  acceptable: string[];
  pass: boolean;
};

async function runSurface(
  apiKey: string,
  surface: "baseline" | "consolidated",
  tools: AnthropicTool[],
): Promise<FlowResult[]> {
  const out: FlowResult[] = [];
  for (const flow of EVAL_FLOWS) {
    const acceptable =
      surface === "baseline" ? flow.baselineTools : flow.consolidatedTools;
    let chosen: string | null = null;
    try {
      chosen = await firstToolCall(apiKey, tools, flow.task);
    } catch (e) {
      chosen = `ERROR:${(e as Error).message.slice(0, 60)}`;
    }
    out.push({
      id: flow.id,
      surface,
      chosen,
      acceptable,
      pass: chosen != null && acceptable.includes(chosen),
    });
  }
  return out;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "run-eval: ANTHROPIC_API_KEY not set. The harness + baseline snapshot are " +
        "committed; the eval RUN is owner-gated on an API key (decision #4).",
    );
    process.exit(2);
  }
  const which = process.argv.find((a) => a.startsWith("--surface="))?.split("=")[1];

  const baselineTools = toAnthropicTools(loadBaseline());
  const consolidatedTools = toAnthropicTools(await dumpToolsList());

  const results: FlowResult[] = [];
  if (which !== "consolidated") {
    results.push(...(await runSurface(apiKey, "baseline", baselineTools)));
  }
  if (which !== "baseline") {
    results.push(...(await runSurface(apiKey, "consolidated", consolidatedTools)));
  }

  // Report.
  const bySurface = (s: string) => results.filter((r) => r.surface === s);
  for (const surface of ["baseline", "consolidated"] as const) {
    const rows = bySurface(surface);
    if (rows.length === 0) continue;
    const passed = rows.filter((r) => r.pass).length;
    console.log(`\n=== ${surface} (${passed}/${rows.length}) ===`);
    for (const r of rows) {
      console.log(
        `  ${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(20)} chose=${r.chosen} (want ${r.acceptable.join("|")})`,
      );
    }
  }

  const baseAcc = bySurface("baseline").filter((r) => r.pass).length;
  const consAcc = bySurface("consolidated").filter((r) => r.pass).length;
  if (baseAcc && consAcc) {
    console.log(
      `\nEqual-or-better gate: consolidated ${consAcc} vs baseline ${baseAcc} → ${
        consAcc >= baseAcc ? "PASS" : "FAIL"
      }`,
    );
    process.exit(consAcc >= baseAcc ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

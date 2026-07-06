/**
 * FINLYNQ-267 Phase 0 — unit tests for the shared name-resolution envelope
 * (`resolveEntity` / `resolveOrReport` / `collectWarnings` / `DEFAULT_STRICT`).
 *
 * These lock the four house-rule outcomes the whole epic-child depends on:
 *   • id fast-path ALWAYS wins over name (name not consulted);
 *   • a name matching 2+ rows returns `ambiguous` (never silent first-pick);
 *   • a name matching zero rows returns `not_found` with a warning;
 *   • a low-confidence fuzzy hit is REJECTED → `not_found` + suggestion (#123);
 *   • holdings now report `ambiguous` (DEFAULT_STRICT.holding flip).
 *
 * Pure / DEK-free — the util takes already-decrypted `options`.
 */
import { describe, it, expect } from "vitest";
import {
  resolveEntity,
  resolveOrReport,
  collectWarnings,
  DEFAULT_STRICT,
  type Row,
} from "../../mcp-server/tools/_shared";

const accounts: Row[] = [
  { id: 1, name: "Checking", alias: "chk" },
  { id: 2, name: "Savings" },
  { id: 3, name: "Savings Bonds" },
];

describe("resolveEntity — id fast-path", () => {
  it("resolves via id when the id is owned", () => {
    const env = resolveEntity({ entity: "account", id: 2, options: accounts });
    expect(env).toEqual({ status: "resolved", id: 2, via: "id" });
  });

  it("id wins over a conflicting name (name not consulted)", () => {
    // name 'Checking' → id 1, but id=2 is passed; id wins.
    const env = resolveEntity({ entity: "account", id: 2, name: "Checking", options: accounts });
    expect(env).toEqual({ status: "resolved", id: 2, via: "id" });
  });

  it("id not owned → not_found (never falls back to name)", () => {
    const env = resolveEntity({ entity: "account", id: 999, name: "Checking", options: accounts });
    expect(env.status).toBe("not_found");
    if (env.status === "not_found") expect(env.warning).toContain("999");
  });

  it("ignores a non-positive / non-integer id and uses the name", () => {
    const env = resolveEntity({ entity: "account", id: 0, name: "Checking", options: accounts });
    expect(env).toMatchObject({ status: "resolved", id: 1 });
  });
});

describe("resolveEntity — name resolution", () => {
  it("exact name → resolved", () => {
    const env = resolveEntity({ entity: "account", name: "Checking", options: accounts });
    expect(env).toMatchObject({ status: "resolved", id: 1, via: "exact" });
  });

  it("exact alias → resolved", () => {
    const env = resolveEntity({ entity: "account", name: "chk", options: accounts });
    expect(env).toMatchObject({ status: "resolved", id: 1, via: "alias" });
  });

  it("2+ startsWith matches → ambiguous candidate list", () => {
    // 'Savings' is an exact match for id 2, so use a prefix that hits both.
    const env = resolveEntity({ entity: "account", name: "Savin", options: accounts });
    expect(env.status).toBe("ambiguous");
    if (env.status === "ambiguous") {
      expect(env.candidates.map((c) => c.id).sort()).toEqual([2, 3]);
      expect(env.candidates[0].name).toBeTypeOf("string");
    }
  });

  it("zero match → not_found with a warning", () => {
    const env = resolveEntity({ entity: "account", name: "Nonexistent XYZ", options: accounts });
    expect(env.status).toBe("not_found");
    if (env.status === "not_found") expect(env.warning).toContain("Nonexistent XYZ");
  });

  it("empty name and no id → not_found", () => {
    const env = resolveEntity({ entity: "account", name: "  ", options: accounts });
    expect(env.status).toBe("not_found");
    if (env.status === "not_found") expect(env.warning).toContain("no account name or id");
  });

  it("low-confidence substring (no shared ≥3 token) → not_found + suggestion (#123)", () => {
    // 'ecking' is a substring of 'Checking' but shares no whitespace token.
    const env = resolveEntity({ entity: "account", name: "ecking", options: accounts });
    expect(env.status).toBe("not_found");
    if (env.status === "not_found") {
      expect(env.suggestion?.id).toBe(1);
      expect(env.warning).toContain("no confident");
    }
  });
});

describe("resolveEntity — holdings ambiguous flip (FINLYNQ-267)", () => {
  const holdings: Row[] = [
    { id: 10, name: "Vanguard All-World", symbol: "VWRL", account: "TFSA" },
    { id: 11, name: "Vanguard All-World", symbol: "VWRL", account: "RRSP" },
  ];

  it("DEFAULT_STRICT.holding now passes ambiguous:true", () => {
    expect(DEFAULT_STRICT.holding.ambiguous).toBe(true);
  });

  it("a name/symbol matching 2 positions across accounts → ambiguous (not first-pick)", () => {
    const env = resolveEntity({ entity: "holding", name: "Vanguard All-World", options: holdings });
    expect(env.status).toBe("ambiguous");
    if (env.status === "ambiguous") {
      expect(env.candidates.map((c) => c.id).sort()).toEqual([10, 11]);
      expect(env.candidates[0].symbol).toBe("VWRL");
    }
  });

  it("holdingId still bypasses fuzzy", () => {
    const env = resolveEntity({ entity: "holding", id: 11, name: "Vanguard All-World", options: holdings });
    expect(env).toMatchObject({ status: "resolved", id: 11, via: "id" });
  });
});

describe("resolveOrReport", () => {
  it("resolved → {id}", () => {
    const out = resolveOrReport("account", { status: "resolved", id: 5, via: "exact" });
    expect(out).toEqual({ id: 5 });
  });

  it("ambiguous → err report naming candidates + disambiguation hint", () => {
    const out = resolveOrReport("account", {
      status: "ambiguous",
      candidates: [
        { id: 2, name: "Savings" },
        { id: 3, name: "Savings Bonds" },
      ],
    });
    expect("report" in out).toBe(true);
    if ("report" in out) {
      const t = out.report.content[0].text;
      expect(t).toContain("ambiguous");
      expect(t).toContain("id=2");
      expect(t).toContain("account_id");
    }
  });

  it("not_found → err report with warning + suggestion", () => {
    const out = resolveOrReport("goal", {
      status: "not_found",
      warning: "'Retirment' matched no goal",
      suggestion: { id: 7, name: "Retirement" },
    });
    expect("report" in out).toBe(true);
    if ("report" in out) {
      const t = out.report.content[0].text;
      expect(t).toContain("matched no goal");
      expect(t).toContain("Retirement");
    }
  });
});

describe("collectWarnings", () => {
  it("collects not_found entries and skips resolved/ambiguous", () => {
    const warnings = collectWarnings([
      { label: "VTI", env: { status: "resolved", id: 1, via: "exact" } },
      { label: "XXXX", env: { status: "not_found", warning: "'XXXX' matched no holding" } },
      { label: "Vanguard", env: { status: "ambiguous", candidates: [{ id: 1, name: "a" }, { id: 2, name: "b" }] } },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("XXXX");
    expect(warnings[0]).toContain("matched no holding");
  });
});

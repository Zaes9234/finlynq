/**
 * FINLYNQ-147 — reconcile "hidden accounts" persistence helper.
 *
 * Covers the pure normalization core `parseHiddenAccountIds` that backs the
 * settings-key store (no live DB). The hide flag is a dropdown-only filter; a
 * malformed stored value must degrade to "nothing hidden" rather than throw,
 * so the /import dropdown never breaks on bad data.
 */

import { describe, it, expect } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER =
  process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY =
  process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { parseHiddenAccountIds } from "../src/lib/reconcile/hidden-accounts";

describe("parseHiddenAccountIds", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(parseHiddenAccountIds(null)).toEqual([]);
    expect(parseHiddenAccountIds(undefined)).toEqual([]);
    expect(parseHiddenAccountIds("")).toEqual([]);
  });

  it("parses a JSON int array", () => {
    expect(parseHiddenAccountIds("[3,1,2]")).toEqual([1, 2, 3]);
  });

  it("de-dupes and sorts ascending", () => {
    expect(parseHiddenAccountIds("[5,5,2,2,9]")).toEqual([2, 5, 9]);
  });

  it("coerces numeric strings and drops non-positive / non-integer", () => {
    expect(parseHiddenAccountIds('["4","2",0,-1,1.5,"x"]')).toEqual([2, 4]);
  });

  it("degrades to [] on malformed JSON (never throws)", () => {
    expect(parseHiddenAccountIds("not json")).toEqual([]);
    expect(parseHiddenAccountIds("{")).toEqual([]);
    expect(parseHiddenAccountIds('{"a":1}')).toEqual([]); // object, not array
    expect(parseHiddenAccountIds("42")).toEqual([]); // bare number, not array
  });
});

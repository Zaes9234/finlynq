/**
 * FINLYNQ-271 phase 3 — pure bucketSuggestions classifier.
 *
 * DB-free. Asserts the exact/fuzzy partition + the two structural invariants
 * the tool contract relies on: exact.count + fuzzy.count === suggestions.length
 * and noMatch.bankTransactionIds ≡ bankOnly.
 */
import { describe, it, expect } from "vitest";
import {
  bucketSuggestions,
  isExactSuggestion,
  EXACT_BUCKET_DATE_TOLERANCE_DAYS,
} from "../../src/lib/reconcile/bucket-suggestions";
import {
  RECONCILE_DEFAULT_THRESHOLDS,
  type ReconcileResult,
  type ReconcileSuggestion,
} from "../../src/lib/reconcile/match-engine";

function suggestion(p: Partial<ReconcileSuggestion>): ReconcileSuggestion {
  return {
    transactionId: 1,
    bankTransactionId: "bank-1",
    strategy: "fuzzy",
    score: 0.8,
    reason: "amount+date",
    daysOff: 0,
    amountDeltaAbs: 0,
    ...p,
  };
}

function resultWith(
  suggestions: ReconcileSuggestion[],
  bankOnly: string[] = [],
  linkedCount = 0,
): ReconcileResult {
  return {
    linked: Array.from({ length: linkedCount }, (_, i) => ({
      transactionId: 100 + i,
      bankTransactionId: `linked-${i}`,
      linkType: "primary" as const,
      source: "manual",
      createdAt: "2026-01-01T00:00:00Z",
    })),
    suggestions,
    bankOnly,
    txOnly: [],
    transactions: {},
    bankTransactions: {},
  };
}

describe("isExactSuggestion", () => {
  it("is exact when amount delta 0 AND daysOff within ±3", () => {
    expect(isExactSuggestion(suggestion({ amountDeltaAbs: 0, daysOff: 0, strategy: "exact_hash" }))).toBe(true);
    expect(isExactSuggestion(suggestion({ amountDeltaAbs: 0, daysOff: EXACT_BUCKET_DATE_TOLERANCE_DAYS }))).toBe(true);
  });
  it("is fuzzy when the date drifts past the tolerance", () => {
    expect(isExactSuggestion(suggestion({ amountDeltaAbs: 0, daysOff: EXACT_BUCKET_DATE_TOLERANCE_DAYS + 1 }))).toBe(false);
  });
  it("is fuzzy when the amount differs at all (even ±$0.01)", () => {
    expect(isExactSuggestion(suggestion({ amountDeltaAbs: 0.01, daysOff: 0 }))).toBe(false);
    expect(isExactSuggestion(suggestion({ amountDeltaAbs: 5, daysOff: 1 }))).toBe(false);
  });
});

describe("bucketSuggestions", () => {
  const suggestions = [
    suggestion({ bankTransactionId: "b-exact-1", transactionId: 1, strategy: "exact_hash", amountDeltaAbs: 0, daysOff: 0, score: 1 }),
    suggestion({ bankTransactionId: "b-exact-2", transactionId: 2, amountDeltaAbs: 0, daysOff: 3, score: 0.9 }),
    suggestion({ bankTransactionId: "b-fuzzy-1", transactionId: 3, amountDeltaAbs: 0, daysOff: 4, score: 0.7, reason: "wide-date" }),
    suggestion({ bankTransactionId: "b-fuzzy-2", transactionId: 4, amountDeltaAbs: 0.01, daysOff: 0, score: 0.75, reason: "amount-drift" }),
    suggestion({ bankTransactionId: "b-fuzzy-3", transactionId: 5, amountDeltaAbs: 5, daysOff: 2, score: 0.65, reason: "loose" }),
  ];
  const bankOnly = ["no-1", "no-2", "no-3"];
  const result = resultWith(suggestions, bankOnly, 2);
  const buckets = bucketSuggestions(result, RECONCILE_DEFAULT_THRESHOLDS);

  it("partitions exact vs fuzzy", () => {
    expect(buckets.exact.count).toBe(2);
    expect(buckets.fuzzy.count).toBe(3);
    expect(buckets.exact.pairs.map((p) => p.bankTransactionId)).toEqual(["b-exact-1", "b-exact-2"]);
    expect(buckets.fuzzy.pairs.map((p) => p.bankTransactionId)).toEqual(["b-fuzzy-1", "b-fuzzy-2", "b-fuzzy-3"]);
  });

  it("every suggestion lands in exactly one of exact/fuzzy", () => {
    expect(buckets.exact.count + buckets.fuzzy.count).toBe(result.suggestions.length);
  });

  it("noMatch.bankTransactionIds is exactly bankOnly", () => {
    expect(buckets.noMatch.bankTransactionIds).toEqual(bankOnly);
    expect(buckets.noMatch.count).toBe(bankOnly.length);
  });

  it("alreadyLinked.count == linked.length", () => {
    expect(buckets.alreadyLinked.count).toBe(result.linked.length);
  });

  it("exact pairs carry score only; fuzzy pairs also carry a reason", () => {
    expect(buckets.exact.pairs[0]).toEqual({ bankTransactionId: "b-exact-1", transactionId: 1, score: 1 });
    expect(buckets.fuzzy.pairs[0]).toMatchObject({ bankTransactionId: "b-fuzzy-1", transactionId: 3, score: 0.7, reason: "wide-date" });
  });

  it("empty result yields all-zero buckets", () => {
    const b = bucketSuggestions(resultWith([], [], 0), RECONCILE_DEFAULT_THRESHOLDS);
    expect(b).toEqual({
      exact: { count: 0, pairs: [] },
      fuzzy: { count: 0, pairs: [] },
      noMatch: { count: 0, bankTransactionIds: [] },
      alreadyLinked: { count: 0 },
    });
  });
});

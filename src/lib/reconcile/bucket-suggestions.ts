/**
 * bucketSuggestions — pure, rollups-first re-grouping of a reconcile result
 * (FINLYNQ-271 phase 3).
 *
 * The `get_reconcile_suggestions` MCP tool leads its response with three
 * decision buckets so an AI agent can act per bucket without re-deriving the
 * classification: EXACT pairs are batch-approve material, FUZZY pairs are a
 * user-confirm/reject list (NEVER auto-committed), and NO-MATCH bank rows need a
 * new transaction (rules / suggest / novel-payee).
 *
 * This is a PURE POST-PASS over `computeReconcileForAccount`'s output — the
 * match engine + `loadReconcileThresholds` values are UNCHANGED; buckets only
 * re-group the existing `suggestions` / `bankOnly` / `linked` arrays. Every
 * suggestion lands in exactly one of {exact, fuzzy}, so
 * `exact.count + fuzzy.count === suggestions.length`.
 */
import type {
  ReconcileResult,
  ReconcileSuggestion,
  ReconcileThresholds,
} from "./match-engine";

/**
 * Date tolerance (days) for the EXACT bucket. Matches the owner-agreed design
 * ("amount + date ±3d") and is a CLASSIFIER constant, NOT a match threshold —
 * the engine's `RECONCILE_DEFAULT_THRESHOLDS` / `loadReconcileThresholds` values
 * are untouched (the loose fuzzy layer still uses its ±7d / ±$50-floor window).
 */
export const EXACT_BUCKET_DATE_TOLERANCE_DAYS = 3;

export interface ExactBucketPair {
  bankTransactionId: string;
  transactionId: number;
  score: number;
}

export interface FuzzyBucketPair extends ExactBucketPair {
  reason: string;
}

export interface ReconcileBuckets {
  /** High-confidence pairs — batch-approve material. */
  exact: { count: number; pairs: ExactBucketPair[] };
  /** Looser pairs — surface for user confirm/reject; NEVER auto-commit. */
  fuzzy: { count: number; pairs: FuzzyBucketPair[] };
  /** Bank rows with no linked tx AND no suggestion — need a new transaction. */
  noMatch: { count: number; bankTransactionIds: string[] };
  /** Already-linked pairs (join_existing) — nothing to do. */
  alreadyLinked: { count: number };
}

/**
 * A suggestion is EXACT when the amount matches to the cent AND the dates are
 * within ±3 days. The engine's strict `exact_hash` strategy (import_hash match)
 * always satisfies both (the hash covers date+amount+payee, so daysOff=0 and
 * amountDeltaAbs=0), so it is a subset of this predicate; a fuzzy-strategy
 * suggestion that happens to match amount exactly within the tight date window
 * is likewise treated as exact (auto-approve material). Everything else is fuzzy.
 */
export function isExactSuggestion(s: ReconcileSuggestion): boolean {
  return (
    s.amountDeltaAbs === 0 && s.daysOff <= EXACT_BUCKET_DATE_TOLERANCE_DAYS
  );
}

/**
 * Re-group a `ReconcileResult` into the three decision buckets. Pure — takes the
 * (already-computed) result + the thresholds used to compute it; returns no new
 * DB reads. `thresholds` is accepted for forward-compatibility (a future
 * per-user exact tolerance) and to keep the classifier's inputs explicit; the
 * v1 predicate uses the fixed `EXACT_BUCKET_DATE_TOLERANCE_DAYS`.
 */
export function bucketSuggestions(
  result: ReconcileResult,
  _thresholds: ReconcileThresholds,
): ReconcileBuckets {
  const exact: ExactBucketPair[] = [];
  const fuzzy: FuzzyBucketPair[] = [];

  for (const s of result.suggestions) {
    if (isExactSuggestion(s)) {
      exact.push({
        bankTransactionId: s.bankTransactionId,
        transactionId: s.transactionId,
        score: s.score,
      });
    } else {
      fuzzy.push({
        bankTransactionId: s.bankTransactionId,
        transactionId: s.transactionId,
        score: s.score,
        reason: s.reason,
      });
    }
  }

  return {
    exact: { count: exact.length, pairs: exact },
    fuzzy: { count: fuzzy.length, pairs: fuzzy },
    noMatch: { count: result.bankOnly.length, bankTransactionIds: result.bankOnly },
    alreadyLinked: { count: result.linked.length },
  };
}

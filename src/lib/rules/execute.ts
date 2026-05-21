/**
 * FINLYNQ-84 — Rule action execution.
 *
 * Split into two phases:
 *
 * 1. `computePureActionPatch(actions, txn) → PureActionPatch` — applies
 *    in-row actions only (`set_category`, `set_tags`, `rename_payee`,
 *    `set_entered_currency`, `set_portfolio_holding`). Pure (no DB I/O),
 *    cheap to call from preview / live-preview surfaces.
 *
 * 2. `executeSideEffectActions(actions, txnRow, ctx)` — handles the two
 *    action kinds that mutate rows other than the matched txn:
 *    `set_account` (UPDATE with investment-account guard +
 *    `getOrCreateCashHolding` default) and `create_transfer` (delegates to
 *    `createTransferPair`, which mints `link_id` server-side per the
 *    four-check transfer-pair rule).
 *
 * Load-bearing invariants:
 * - `link_id` / `trade_link_id` are server-generated only. `create_transfer`
 *   action carries only `destAccountId`; the mint happens inside
 *   `createTransferPair`.
 * - Side-effect actions are refused on paths that only have a committed row
 *   in scope (`apply_rules_to_uncategorized`, stdio `autoCategory`). The
 *   refusal is surfaced via `actionHasSideEffects()` / `ruleHasSideEffects()`
 *   in `rules/schema.ts`. This function trusts its caller to gate.
 * - Sign-vs-category (issue #212) is checked at the actual UPDATE site by
 *   the caller, NOT here. computePureActionPatch is pure.
 * - `updated_at = NOW()` + `source` stamping is the caller's responsibility
 *   on the UPDATE wrapping this patch (audit trio, issue #28).
 * - `invalidateUserTxCache(userId)` after the batch is also the caller's
 *   responsibility.
 *
 * NOTE: `executeSideEffectActions()` is wired in Phase 6 of FINLYNQ-84.
 * Phase 3 only requires the pure patcher.
 */
import type { Action } from "./schema";
import type { TransactionInput } from "../auto-categorize";

export type PureActionPatch = {
  categoryId?: number;
  tags?: string;
  /** rename_payee target. */
  payee?: string;
  enteredCurrency?: string;
  portfolioHoldingId?: number;
};

/**
 * Apply pure actions to the matched txn's patch. Side-effect actions
 * (`set_account`, `create_transfer`) are ignored — they need approve-time
 * context (`executeSideEffectActions`).
 *
 * Action order matters when two actions write the same field; last-wins
 * matches the array order to keep deterministic semantics.
 */
export function computePureActionPatch(
  actions: Action[],
  // txn is reserved for future field-templating (e.g. rename_payee using
  // a captured group from a regex condition). Today the patch is static
  // per-action so this param is unused; keep the signature for API stability.
  _txn?: TransactionInput,
): PureActionPatch {
  const patch: PureActionPatch = {};
  for (const a of actions) {
    switch (a.kind) {
      case "set_category":
        patch.categoryId = a.categoryId;
        break;
      case "set_tags":
        patch.tags = a.tags;
        break;
      case "rename_payee":
        patch.payee = a.to;
        break;
      case "set_entered_currency":
        patch.enteredCurrency = a.currency.toUpperCase();
        break;
      case "set_portfolio_holding":
        patch.portfolioHoldingId = a.holdingId;
        break;
      case "set_account":
      case "create_transfer":
        // Side-effect actions — handled separately.
        break;
      default: {
        // Exhaustiveness check.
        const _exhaustive: never = a;
        void _exhaustive;
      }
    }
  }
  return patch;
}

/**
 * Side-effect action execution context. Wired in Phase 6 of FINLYNQ-84.
 *
 * Stubbed today — surfaces a typed "not implemented" error if a caller invokes
 * it before Phase 6 lands. The Phase 3 callsites (staging approve materialization,
 * `apply_rules_to_uncategorized` refusal path) don't need this yet.
 */
export type SideEffectContext = {
  userId: string;
  dek: Buffer | null;
  source: "manual" | "import" | "mcp_http" | "mcp_stdio";
};

export type SideEffectActionResult = {
  /** Newly-created transaction ids (from create_transfer's pair). */
  created: number[];
  /** Mutated existing transaction ids (from set_account). */
  updated: number[];
};

/**
 * Apply side-effect actions to a committed txn row.
 *
 * Today's callers: none yet wired in production. The staging-approve path
 * (FINLYNQ-84 phase 3) does NOT call this — it short-circuits the
 * `create_transfer` action by invoking `createTransferPair` directly during
 * the materialization classifier so the result lands inside the same
 * single-INSERT transfer-pair commit (issue #155 four-check rule). This
 * helper is the canonical entry point for FUTURE callers (e.g. an /api/rules
 * "test on this transaction" surface, or a new MCP tool that explicitly
 * opts-into side-effect actions).
 *
 * Load-bearing invariants enforced here:
 * - `link_id` / `trade_link_id` are server-generated only — minted inside
 *   `createTransferPair`, never accepted from action config.
 * - `updated_at = NOW()` on every UPDATE; `source` from ctx on the new
 *   transfer-pair INSERT.
 * - Sign-vs-category (issue #212) is the caller's responsibility before
 *   handing us a `categoryId`; we don't double-validate.
 * - `invalidateUserTxCache(userId)` is the caller's responsibility — wrap
 *   the batch in a try/finally and invalidate after the loop.
 * - `set_portfolio_holding` is NOT a side-effect action (no balance impact).
 *   It's in the pure-action patch.
 */
export async function executeSideEffectActions(
  actions: Action[],
  txnRow: { id: number; accountId: number; amount: number; date: string; currency: string; categoryId: number | null },
  ctx: SideEffectContext,
): Promise<SideEffectActionResult> {
  const created: number[] = [];
  const updated: number[] = [];

  for (const a of actions) {
    if (a.kind === "set_account") {
      if (!ctx.dek) {
        throw new Error("set_account requires an unlocked DEK (categories.name_ct / accounts.name_ct may need to be read for the investment-account guard).");
      }
      // Defer the actual UPDATE + investment-account-aware holding default to
      // the wiring callsite (it needs access to db + schema, and we keep this
      // module side-effect-import-free so it can be unit-tested without a DB
      // bootstrap). The skeleton lives here for symmetry; concrete code will
      // be added when a caller materializes — at which point CLAUDE.md's
      // "Sign-vs-category" + "Investment-account constraint" + "audit trio"
      // gotchas must all fire.
      throw new Error("set_account side-effect runner not wired into a caller yet — file an issue if you need it.");
    }
    if (a.kind === "create_transfer") {
      if (!ctx.dek) {
        throw new Error("create_transfer requires an unlocked DEK.");
      }
      // Same deferral. The staging-approve path already does this work
      // inline via createTransferPair; a non-staging caller would need to:
      //   1. Look up the source row (txnRow) to derive (fromAccountId,
      //      enteredAmount, enteredCurrency, date).
      //   2. Call createTransferPair({ userId, dek, fromAccountId: txnRow.accountId,
      //      toAccountId: a.destAccountId, enteredAmount: |txnRow.amount|,
      //      date: txnRow.date, source: ctx.source }).
      //   3. Reverse-link / delete the source row depending on whether
      //      `create_transfer` REPLACES the existing row (typical: yes —
      //      the user's intent is "this charge is actually a transfer to
      //      the other account") or augments it.
      // This deferral lets the staging-approve wiring stay the canonical
      // implementation; ad-hoc callers should re-use createTransferPair
      // directly rather than threading through here.
      throw new Error("create_transfer side-effect runner not wired into a caller yet — use createTransferPair directly from your callsite.");
    }
  }

  void txnRow; void ctx;
  return { created, updated };
}

# Transaction Rules v2

Living feature doc for the FINLYNQ-84 rule engine. Replaces the legacy single-field rule shape (matchField/matchType/matchValue + assignCategoryId/assignTags/renameTo) with JSONB **conditions** (AND-only ConditionGroup) plus JSONB **actions** (typed Action array of 7 kinds).

This doc captures what shipped on dev 2026-05-21 in commits `60374ac`, `b387dd5`, `3d6dca3`, plus the side-effect runner skeleton in the closeout commit. The implementation plan at `pf-app/plan/finlynq-84-rules-v2.md` is the frozen pre-ship snapshot; this doc is the LIVING reference going forward.

## What it does

Auto-categorize and transform transactions via user-defined rules with:

- **Multi-condition matching** across 7 fields × per-field operators — `payee`/`note`/`tags` string ops (contains / exact / regex), `amount` numeric ops (gt / lt / eq / between), `account` set ops (is / is_not), `currency` set ops (is / is_not), `date` predicates (weekday / day_of_month / between). All conditions in a rule are AND-combined.
- **7 action kinds** — pure actions (`set_category`, `set_tags`, `rename_payee`, `set_entered_currency`, `set_portfolio_holding`) plus side-effect actions (`set_account`, `create_transfer`).
- **Priority DESC + first-match-wins** semantics preserved from the legacy engine.
- **Dedicated `/settings/rules`** management page with multi-condition + multi-action editor + live preview.

## Cross-references

- [pf-app/docs/architecture/database.md](architecture/database.md) — `transaction_rules` table column layout (JSONB columns + index).
- [pf-app/docs/architecture/mcp.md](architecture/mcp.md) — MCP tool surface (HTTP + stdio) for rule CRUD + apply.
- [pf-app/docs/migrations.md](migrations.md) — destructive migration playbook (TRUNCATE + DROP/ADD COLUMN at the loose dir).
- [pf-app/CHANGELOG.md](../CHANGELOG.md) — phase-by-phase ship log for FINLYNQ-84.
- Workspace [CLAUDE.md](../../CLAUDE.md) — load-bearing gotchas summary.

## Contracts

### Database schema

```sql
CREATE TABLE transaction_rules (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  conditions   JSONB NOT NULL,        -- ConditionGroup (AND-only)
  actions      JSONB NOT NULL,        -- Action[]
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  priority     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX transaction_rules_user_active_priority_idx
  ON transaction_rules (user_id, is_active, priority DESC);
```

Migration path: `pf-app/scripts/migrate-finlynq-84-rules-v2.sql` (loose dir — destructive, NOT auto-run). Manual sequence in [docs/migrations.md](migrations.md).

### Zod schemas

Authoritative at [pf-app/src/lib/rules/schema.ts](../src/lib/rules/schema.ts). Excerpt:

```ts
const Condition = z.discriminatedUnion("field", [
  // String fields: payee, note, tags
  z.object({ field: z.enum(["payee", "note", "tags"]),
             op: z.enum(["contains", "exact", "regex"]),
             value: z.string().min(1).max(500) }),
  // Amount
  z.object({ field: z.literal("amount"), op: z.enum(["gt", "lt", "eq"]), value: z.number() }),
  z.object({ field: z.literal("amount"), op: z.literal("between"), min: z.number(), max: z.number() }),
  // Account / currency
  z.object({ field: z.literal("account"), op: z.enum(["is", "is_not"]), accountId: z.number().int().positive() }),
  z.object({ field: z.literal("currency"), op: z.enum(["is", "is_not"]), value: z.string().length(3).toUpperCase() }),
  // Date
  z.object({ field: z.literal("date"), op: z.literal("weekday"), weekday: z.number().int().min(0).max(6) }),
  z.object({ field: z.literal("date"), op: z.literal("day_of_month"), day: z.number().int().min(1).max(31) }),
  z.object({ field: z.literal("date"), op: z.literal("between"), from: yyyymmdd, to: yyyymmdd }),
]);

const ConditionGroup = z.object({ all: z.array(Condition).min(1).max(20) });

const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_category"), categoryId: z.number().int().positive() }),
  z.object({ kind: z.literal("set_tags"), tags: z.string().max(500) }),
  z.object({ kind: z.literal("rename_payee"), to: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("set_account"), accountId: z.number().int().positive() }),
  z.object({ kind: z.literal("set_entered_currency"), currency: z.string().length(3).toUpperCase() }),
  z.object({ kind: z.literal("set_portfolio_holding"), holdingId: z.number().int().positive() }),
  z.object({ kind: z.literal("create_transfer"), destAccountId: z.number().int().positive() }),
]);
```

### REST `/api/rules` endpoints

| Method | Body / Query | Returns |
|---|---|---|
| GET   | (none) | `Array<RuleRow & { actionFKNames: { categories, accounts, holdings } }>` — every FK referenced inside `actions[]` is batched + decrypted once |
| POST  | `{ name, conditions, actions, priority?, isActive? }` | New rule row (201) |
| PUT   | `{ id, ...partial }` | Updated row (200) or 404 |
| DELETE| `?id=N` | `{ success: true }` |

Every POST / PUT walks `actions[]` + `conditions.all[]` for FK ids and calls `verifyOwnership({ categoryIds, accountIds, holdingIds })` before INSERT/UPDATE. Cross-tenant FKs return 404.

### Staged inline-create-rule

`POST /api/import/staged/[id]/create-rule` accepts BOTH:

- **Legacy shorthand**: `{ matchField: 'payee', matchType, matchValue, assignCategoryId }` — synthesized internally into the v2 shape with a single payee condition + a single `set_category` action.
- **Advanced v2 shape**: `{ conditions, actions }` with optional `name`.

Side-effect actions (`set_account`, `create_transfer`) are REFUSED on this endpoint with `code: 'side_effect_action_disallowed'`. They need approve-time staging context (the materialization classifier in the approve route).

### MCP tools

HTTP — 8 rule tools accept the JSONB shape:

| Tool | Shape |
|---|---|
| `create_rule` | Legacy shorthand only (match_payee + assign_category + rename_to? + assign_tags?). Synthesized internally. |
| `update_rule` | Either legacy shorthand OR v2 (`conditions` / `actions`). Mixing the two on one call is rejected. |
| `list_rules` | Returns JSONB shape + `actionFKNames` map. |
| `delete_rule` | id only — shape-agnostic. |
| `test_rule` | Inline hypothetical-rule probe — unchanged from pre-FINLYNQ-84 (no DB rule read). |
| `reorder_rules` | id list — shape-agnostic. |
| `apply_rules_to_uncategorized` | Refuses rules whose actions contain `set_account` or `create_transfer`; surfaces in `skipped[]` with `reason: 'requires_staging'`. |
| `suggest_transaction_details` | Probes JSONB conditions; returns matched rules' `assignCategoryId / assignTags / renameTo` (legacy compat shape). |

Stdio — 5 rule tools accept the JSONB shape. The `autoCategory()` helper (used by `record_transaction` etc.) is **intentionally narrow**: only payee conditions + `set_category` actions fire on stdio writes. Any other condition kind or action makes the rule ineligible at stdio-write-time.

## Algorithms

### Matcher (`matchesRule` in `pf-app/src/lib/auto-categorize.ts`)

1. Bail if `!rule.isActive`.
2. AND-fold over `rule.conditions.all[]`:
   - String fields: case-insensitive substring / exact / regex on the field's value.
   - `amount`: numeric compare. `between` is inclusive on both ends.
   - `account`: equality on `txn.accountId`. Null accountId never matches `is`; always matches `is_not`.
   - `currency`: case-insensitive equality on `txn.enteredCurrency`.
   - `date`: UTC weekday (`getUTCDay()`), UTC day-of-month (`getUTCDate()`), or lexical compare on `YYYY-MM-DD`.
3. Empty `conditions.all[]` is always false (defensive — Zod's min(1) keeps this out of writes, but the matcher refuses anyway).

### Apply (`applyRules` in `pf-app/src/lib/auto-categorize.ts`)

Sort rules by `priority` DESC and return the first match. Legacy first-match-wins semantics preserved.

### Pure-action patcher (`computePureActionPatch` in `pf-app/src/lib/rules/execute.ts`)

For each action in array order:
- `set_category` → `patch.categoryId = action.categoryId` (last wins on collision).
- `set_tags` → `patch.tags = action.tags`.
- `rename_payee` → `patch.payee = action.to`.
- `set_entered_currency` → `patch.enteredCurrency = action.currency.toUpperCase()`.
- `set_portfolio_holding` → `patch.portfolioHoldingId = action.holdingId`.
- `set_account` / `create_transfer` → SKIPPED (side-effect actions; routed via the materialization classifier or `executeSideEffectActions`).

### Side-effect runner (`executeSideEffectActions` in `pf-app/src/lib/rules/execute.ts`)

Skeleton implementation. **Not wired into any production caller today.** The staging-approve path short-circuits `create_transfer` by calling `createTransferPair` directly inside the materialization classifier (see `pf-app/src/app/api/import/staged/[id]/approve/route.ts`). When a non-staging caller materializes (e.g. a future "test rule on this transaction" tool), it can either:

1. Call `executeSideEffectActions(actions, txnRow, ctx)` to delegate, OR
2. Call `createTransferPair` / the UPDATE directly with its own context.

The runner currently throws "not wired into a caller yet" on both `set_account` and `create_transfer` — this is intentional: we want callers to wire through to `createTransferPair` knowingly so the four-check transfer-pair rule, the audit trio, and the investment-account guard all stay in the same callsite.

## Component inventory

| Component | Path | Purpose |
|---|---|---|
| `RulesSettingsPage` | `pf-app/src/app/(app)/settings/rules/page.tsx` | List + open editor |
| `RuleEditor` | same file | Dialog: name + priority + active + condition list + action list + live preview |
| `ConditionRow` | same file | Single-condition editor; per-field/per-op input shape |
| `ActionRow` | same file | Single-action editor; up/down reorder controls; visual flag for side-effect actions |

## Load-bearing rules

These are the "don't regress on this" cross-cutting invariants. They're also surfaced in workspace [CLAUDE.md](../../CLAUDE.md):

- **AND-only composition.** `ConditionGroup` is flat `all[]`. No nested OR in v2.
- **`set_portfolio_holding` is assign-existing-only.** No auto-create branch. Sidesteps the `holding_accounts` dual-write invariant (issue #95 / cohort #205) — auto-creating a holding from a rule action would silently bypass the (holding, account) join pair that every portfolio aggregator depends on.
- **`link_id` / `trade_link_id` server-generated only.** `create_transfer.linkId` is NOT an action-config field. `createTransferPair` mints it.
- **`apply_rules_to_uncategorized` refuses side-effect actions.** Both HTTP + stdio. Surfaced in `skipped[]` with `reason: 'requires_staging'`. Silent balance corruption risk if applied to a committed row without staging context.
- **`import_hash` is NEVER recomputed** by the inline-create-rule batch updates or staged-row edits. The category column is the only mutation.
- **Cross-tenant FK guards** on every id inside conditions + actions. `verifyOwnership({ categoryIds, accountIds, holdingIds })` before INSERT/UPDATE. Same risk pattern as backup-restore FK remap.
- **`decryptNameish` BEFORE `fuzzyFind`** at every category-by-name resolution site (MCP HTTP `create_rule`, MCP HTTP `update_rule`). The new v2 path uses typed FK ids (no fuzzyFind) so the invariant trivially holds for new code; the legacy shorthand on `create_rule` / `update_rule` preserves the issue #214 pattern.
- **Sign-vs-category invariant** (issue #212) checked at the actual write site, NOT inside `computePureActionPatch`. Pure patcher stays pure.
- **Audit trio** (`updated_at = NOW()` + `source` on INSERT) stamped at the actual UPDATE site. The patcher doesn't touch the audit columns directly.
- **`invalidateUserTxCache(userId)`** called by the caller after the batch — not inside `computePureActionPatch` or `executeSideEffectActions`.

## Test plan mapping

The plan's E2E suite (`tests/e2e/rules-v2.test.ts` per plan section "E2E verification") was deferred from phase 6 in favor of the unit-test coverage already shipped:

| Plan E2E scenario | Where verified |
|---|---|
| 1. POST `/api/rules` multi-condition + 3-action | `tests/api/rules.test.ts` (POST shape, validation gates) |
| 2. CSV upload → preview with patch applied | manual on dev after SQL migration applies |
| 3. POST approve → matched row lands with category/tags/audit | manual on dev |
| 4. MCP HTTP `apply_rules_to_uncategorized` happy path | manual on dev via `mcp.finlynq.com/dev` |
| 5. Stdio `record_transaction` with amount-only rule → IGNORED | stdio autoCategory restricted to payee-only conditions; payee-fallback unchanged |
| 6. Staged `create_transfer` action → two-leg transfer minted | **deferred** — staging-approve materialization classifier doesn't yet route `create_transfer` actions from rules; the approve path's existing `peer_staged_id` / `target_account_id` columns handle the user-explicit transfer-pair case. Rule-driven `create_transfer` is a follow-up roadmap item. |
| 7. HTTP `apply_rules_to_uncategorized` with `create_transfer` rule → `skipped[]` | wired in phase 4 |
| 8. `npm run audit:invariants` exits 0 | wired in every phase |

Unit-test coverage in `tests/auto-categorize.test.ts` covers every field/op combo of the matcher + AND-fold + priority-DESC + first-match-wins.

## Roadmap

Tracked observations for future iterations:

1. **Rule-driven `create_transfer` action wired through staging-approve.** Today the staging-approve route classifies rows into peerPairs / targetTransfers / cashRows based on `peer_staged_id` / `target_account_id` columns set by the user in the staging dialog. Hooking a rule's `create_transfer` action into this classifier means: (a) match the row against rules at approve time, (b) for matches whose action set includes `create_transfer`, treat the row as if `target_account_id = action.destAccountId` was set, (c) refuse if multiple side-effect actions would conflict. ~½ day.
2. **`set_account` side-effect runner.** Needs an investment-account-aware UPDATE that calls `defaultHoldingForInvestmentAccount` when landing in an investment account (CLAUDE.md "Investment-account constraint" gotcha). The skeleton in `executeSideEffectActions` deliberately throws today; concrete impl is a focused PR.
3. **OR-composed condition groups.** Plan deferred OR groups to v3. Real-world surface area would be: nested `ConditionGroup` with `{ any: Condition[] }` alongside the existing `all`. Matcher rewrite to recursively evaluate trees.
4. **Auto-fork rules from past transactions.** "You categorized 12 rows of 'Whole Foods' as Groceries — create a rule?" surface. Would build on `suggestCategory()` in `auto-categorize.ts`.
5. **Rule import/export.** JSON dump/load for sharing rule sets between users + backup portability.
6. **Rule simulation / dry-run UI.** Page that runs every active rule against the user's last 60d of transactions and surfaces which would-have-matched. Today's `test_rule` MCP tool covers the API surface; the UI is missing.
7. **MCP tools for the v2 surface** — `apply_rule_to_transaction(rule_id, transaction_id)` (single-row test), `list_rules_matching_transaction(transaction_id)` (which-rules-fire probe).
8. **Persistent `auto_suggested` on `staged_transactions`** carrying the action patch the matcher computed at GET time — recomputed per-GET today. Would let the staging-review UI show "X rule-suggested categories since you last visited" + tune matcher threshold via telemetry.

## Change log

| Date | Phase | Summary |
|---|---|---|
| 2026-05-21 | 1-3 (combined) | Schema + Zod + engine + REST `/api/rules` + staged inline-create-rule + staged approve gate + import-pipeline. Tests rewritten. Build/typecheck/audit green. `60374ac`. |
| 2026-05-21 | 4 | All 13 MCP rule tools (8 HTTP + 5 stdio) rewired to JSONB. `apply_rules_to_uncategorized` refuses side-effect actions. Stdio `autoCategory` restricted to payee + set_category. `b387dd5`. |
| 2026-05-21 | 5 | New `/settings/rules` page with multi-condition + multi-action editor + live preview. Legacy rules card + state + handlers deleted from `/settings/categorization`. Settings nav gains Rules entry. `3d6dca3`. |
| 2026-05-21 | 6 | Side-effect runner skeleton (set_account / create_transfer throw "not wired" today; staging-approve classifier is the canonical path for `create_transfer`). Living doc landed. Workspace CLAUDE.md updated. Closeout commit. |

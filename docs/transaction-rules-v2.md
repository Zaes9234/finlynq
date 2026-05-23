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

Side-effect actions (`set_account`, `create_transfer`) on the v2 payload are **accepted as of FINLYNQ-88 (2026-05-22)**. The endpoint inserts the rule, then calls `applyRulesToStagedBatch(db, userId, dek, id, { onlyRuleId: ruleId })` which folds the actions into a tier-preserving UPDATE on matched rows. `create_transfer` flips `tx_type='R'` + sets `target_account_id`; `set_account` reassigns `account_id` + re-encrypts `account_name_ct` at the row's existing tier. `link_id` is NOT minted here — the existing approve-time `createTransferPair` mints it per the four-check rule once the user clicks Approve.

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

## Rule application on staged batches

FINLYNQ-88 (2026-05-22) extended the v2 surface so side-effect actions
(`set_account`, `create_transfer`) fire BEFORE the user clicks Approve —
the rule effects land in `staged_transactions` itself rather than only at
materialization time. The dedicated helper at
[pf-app/src/lib/rules/apply-to-staged-batch.ts](../src/lib/rules/apply-to-staged-batch.ts)
is the single owner of this logic; three callsites invoke it:

### When rules apply

1. **Upload time** — `POST /api/import/staging/upload` calls
   `applyRulesToStagedBatch(tx, userId, dek, stagedImportId)` inside the
   same DB transaction as the row INSERT. The user lands on
   `/import/pending` with rule effects already visible (renamed payees,
   flipped `tx_type='R'` + `target_account_id` for `create_transfer`
   rules, reassigned account for `set_account` rules, etc.). Helper
   failures are caught at the route boundary; the upload still succeeds
   and `counts.ruleApplied` becomes `null` + `ruleApplyWarning` surfaces
   in the response payload.

2. **Manual "Re-apply rules" button** on `/import/pending` — `POST
   /api/import/staged/[id]/apply-rules` operates over the entire batch
   (no `rowIds` filter; this is the "refresh" button). Returns
   `{ success: true, data: { rowsTouched, matches: Array<{rowId, ruleId}> } }`.
   The UI surfaces a confirmation modal warning that the action "may
   overwrite manual edits to payee, category, tags, type, or account on
   matched rows" — modal is the safety net for the no-track-touched-fields
   tradeoff (deferred to roadmap).

3. **Inline `/create-rule`** — `POST /api/import/staged/[id]/create-rule`
   inserts the new rule then calls the helper with
   `{ onlyRuleId: ruleId }` so re-running this endpoint doesn't blow away
   other rules' effects on user-edited rows. The pre-FINLYNQ-88
   `side_effect_action_disallowed` refusal is GONE; side-effect actions
   on this surface now fire normally.

### Load-bearing invariants enforced inside the helper

These are baked into the helper's UPDATE shape and asserted in its file
header comment. Every callsite gets them for free; new callers that want
to bypass the helper must re-enforce them by hand.

- **`import_hash` is NEVER recomputed** — even when `rename_payee` fires.
  The hash is over plaintext payee at ingest; dedup keys on the
  ingest-time hash.
- **`encryption_tier` is NEVER flipped** — text columns re-encrypted at
  the row's EXISTING tier (`tryDecryptField`/`encryptField` for `user`,
  `decryptStaged`/`encryptStaged` for `service`). The login-time
  service→user upgrade job is the only path that promotes tiers.
- **`reconcile_state` is preserved** — rows where
  `reconcile_state IN ('linked', 'skipped_duplicate')` are SKIPPED
  entirely. Linked rows point at a live transaction (rules can't override
  that); skipped_duplicate rows are already excluded from default approve
  (applying rules to them has no observable effect and could confuse the
  user if they un-skip later).
- **`link_id` / `trade_link_id` are NEVER touched** — `create_transfer`
  only sets `tx_type='R'` + `target_account_id`; the UUID mint happens
  later inside `createTransferPair` at approve time per the four-check
  rule.
- **Cross-tenant FK guards** — every `destAccountId` / `categoryId` /
  `holdingId` referenced inside a matched rule's actions is verified
  against the user's owned ids (3 batched ownership SELECTs). Actions
  whose FK isn't owned are silently SKIPPED at apply time; other actions
  on the same rule still fire.
- **Sign-vs-category mismatch on `set_category`** — skips just that
  action, not the whole row (per user decision 2026-05-22). The user can
  fix at approve time. Other actions on the same rule still apply.

### Re-apply button semantics

- Operates over the entire batch — no per-row scope.
- SKIPS `reconcile_state='linked'` rows (linked to a live transaction).
- SKIPS `reconcile_state='skipped_duplicate'` rows (already in the bank
  ledger; excluded from default approve).
- Re-evaluates every other row (`unmatched` and `auto_suggested`) against
  every active rule. First-match-wins by `priority` DESC + `id` ASC.
- Re-fires the response into the staged-detail GET so the page re-renders
  the new row state. The unresolved-categories banner shrinks if rules
  now cover any previously-unresolved rows.
- Confirmation modal is the safety net for "this may overwrite manual
  edits"; we do NOT track which fields the user touched (roadmap item).

### Tier-preservation example

Mixed-tier batches (some rows at `service`, others at `user`) are common
during the login-time upgrade window. The helper branches per row:

```ts
const decode = (value: string | null, tier: string): string | null => {
  if (value == null) return null;
  return tier === "user" ? tryDecryptField(dek, value) : decryptStaged(value);
};
const encode = (plaintext: string | null, tier: string): string | null => {
  if (plaintext == null) return null;
  return tier === "user" ? encryptField(dek, plaintext) : encryptStaged(plaintext);
};
```

Same pattern as the approve route's tier decode at
[approve/route.ts:188-191](../src/app/api/import/staged/%5Bid%5D/approve/route.ts) and
the inline create-rule route's at
[create-rule/route.ts:281-284](../src/app/api/import/staged/%5Bid%5D/create-rule/route.ts).

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
- **`apply_rules_to_uncategorized` refuses side-effect actions.** Both HTTP + stdio. Surfaced in `skipped[]` with `reason: 'requires_staging'`. Silent balance corruption risk if applied to a committed row without staging context. (Note: FINLYNQ-88 wired side-effect actions into STAGED-batch paths only — `apply_rules_to_uncategorized` still operates on committed `transactions` rows and still refuses.)
- **Rule effects on `staged_transactions` are PERSISTED at upload time + via manual Re-apply** (FINLYNQ-88, 2026-05-22). Per-row user edits in the pending editor are NOT overwritten until the user explicitly clicks Re-apply rules (one-shot reset with confirmation modal). See "Rule application on staged batches" section above.
- **`import_hash` is NEVER recomputed** by the inline-create-rule batch updates, the upload-time rule pre-apply, the manual Re-apply pass, or staged-row edits. The text columns mutate but `import_hash` stays byte-identical to the ingest value.
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
| 6. Staged `create_transfer` action → two-leg transfer minted | **SHIPPED via FINLYNQ-88**: `applyRulesToStagedBatch` flips `tx_type='R'` + `target_account_id` at upload time / manual Re-apply / inline create-rule; existing approve-route Bucket-2 classifier routes through `createTransferPair` (mints `link_id` per the four-check rule). Test-plan tc-1-end-to-end-ui + tc-1-end-to-end-sql on FINLYNQ-88 cover this. |
| 7. HTTP `apply_rules_to_uncategorized` with `create_transfer` rule → `skipped[]` | wired in phase 4 (still refuses on the committed-rows surface; FINLYNQ-88 only wired the staged-batch path). |
| 8. `npm run audit:invariants` exits 0 | wired in every phase |

Unit-test coverage in `tests/auto-categorize.test.ts` covers every field/op combo of the matcher + AND-fold + priority-DESC + first-match-wins.

## Roadmap

Tracked observations for future iterations:

1. ~~**Rule-driven `create_transfer` action wired through staging-approve.**~~ **SHIPPED (FINLYNQ-88, 2026-05-22).** The `applyRulesToStagedBatch` helper sets `tx_type='R'` + `target_account_id` on matched rows BEFORE the user clicks Approve; the existing Bucket-2 classifier in the approve route routes through `createTransferPair` from there. See "Rule application on staged batches" section.
2. ~~**`set_account` side-effect runner.**~~ **SHIPPED via staged-batch path (FINLYNQ-88, 2026-05-22).** `applyRulesToStagedBatch` re-encrypts `account_name_ct` at the row's existing tier and assigns `account_id`. Investment-account guard fires when the destination is `is_investment=true` AND the row's `portfolio_holding_id` is currently null AND no `set_portfolio_holding` action fires on the same rule — assigns Cash sleeve via `defaultHoldingForInvestmentAccount`. The `executeSideEffectActions` stub in `execute.ts` is STILL a stub for future non-staging callers (a `/test-rule-on-this-row` surface, an explicit MCP tool, etc.) — the staging path inlines the logic since every callsite's context (DEK, db handle, ownership map) is already in scope.
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
| 2026-05-22 | FINLYNQ-88 ph 1 | New `applyRulesToStagedBatch` helper at `src/lib/rules/apply-to-staged-batch.ts`. Covers all 7 v2 action kinds with tier-preserving re-encrypt, cross-tenant FK guards, sign-vs-category skip-just-that-action semantics, and skip-linked/skipped_duplicate filters. Helper-only; no callers wired yet. `97434d8`. |
| 2026-05-22 | FINLYNQ-88 ph 2 | `POST /api/import/staging/upload` invokes the helper inside the row-INSERT transaction. Response surfaces `counts.ruleApplied` / `ruleApplyWarning`. `9258bab`. |
| 2026-05-22 | FINLYNQ-88 ph 3 | New `POST /api/import/staged/[id]/apply-rules` endpoint for the manual Re-apply button. Inline `/create-rule` refactor: side-effect refusal removed; walk-and-patch loop replaced with helper call scoped to `onlyRuleId`. `299aa6f`. |
| 2026-05-22 | FINLYNQ-88 ph 4 | "Re-apply rules" button + confirmation modal on `/import/pending`. `unresolved-categories-banner.tsx` gains the Re-apply hint line. `93e5fbd`. |
| 2026-05-22 | FINLYNQ-88 ph 5 | Living doc + workspace CLAUDE.md update. New "Rule application on staged batches" section. Closeout commit. |
| 2026-05-23 | FINLYNQ-90 ph 1 | Lifted `RuleEditor` → `RuleEditorDialog` into shared `src/components/rules/rule-editor-dialog.tsx`. URL-agnostic `onSubmit` callback contract. `dd8bb65`. |
| 2026-05-23 | FINLYNQ-90 ph 2 | `/settings/rules/page.tsx` swapped to the shared component (`<RuleEditorDialog>` + `onSubmit` callback). Page file shrank 765→309 lines. UX identical. `50d4f7b`. |
| 2026-05-23 | FINLYNQ-90 ph 3 | `unresolved-categories-banner.tsx` swapped to the shared component with payee/contains seed + name prefill + lazy-fetch of FK option lists. Removed inline 3-field form. `6d6bbff`. |

## Shared rule editor

The rule editor UI is a single shared component, reused by two call-sites.
Lifted out of `/settings/rules/page.tsx` in FINLYNQ-90 (2026-05-23) so the
reconciliation banner could stop shipping its pre-FINLYNQ-84 legacy form.

### Component

[pf-app/src/components/rules/rule-editor-dialog.tsx](../src/components/rules/rule-editor-dialog.tsx)

Default export: none. Named exports:

| Export | Purpose |
|---|---|
| `RuleEditorDialog` | The dialog component itself. |
| `Category`, `Account`, `Holding` | FK option-list shapes the caller passes in. |
| `RuleSeed` | Edit-mode prop shape (with `id`). |
| `RuleEditorPayload` | What `onSubmit` receives. |
| `SubmitResult` | `{ ok: true } \| { ok: false; error: string }`. |
| `RuleEditorDialogProps` | Full props interface. |
| `blankCondition()` / `blankAction()` | Factory helpers (callers rarely need these — the dialog seeds itself). |
| `CONDITION_FIELDS`, `ACTION_KINDS` | Display metadata (label, side-effect flag). |

### URL-agnostic `onSubmit` contract

The editor NEVER bakes in a URL. The caller's `onSubmit` callback owns the
fetch and returns `{ ok, error? }`:

```ts
onSubmit: (payload: RuleEditorPayload) => Promise<SubmitResult>;
```

On `{ ok: false }` the editor renders the error inline (existing
AlertTriangle banner) and stays open. On `{ ok: true }` the editor calls
`onClose(true)` and the caller is responsible for re-fetching / refreshing
state.

This is the load-bearing decoupling — without it the two call-sites
cannot share the form, because they target different endpoints with
different request bodies (`/api/rules` for full CRUD vs.
`/api/import/staged/<id>/create-rule` for the staging inline-create flow).

### Inline error rendering

The dialog has a single shared error slot, shown above the body whenever
`{ ok: false }` returns from `onSubmit` or local validation fails (empty
name, no conditions, no actions). Errors come through verbatim from the
server response's `error` field (or the local validation message), so any
server-side refusal (e.g. invalid Zod payload, future re-introduced
side-effect refusal) surfaces directly to the user without the caller
having to wire a custom toast.

### Lazy-fetch (banner call-site)

`/settings/rules` fetches `/api/categories` + `/api/accounts` +
`/api/portfolio` on mount (alongside `/api/rules`). The banner call-site
defers those 3 fetches until the user clicks "Create rule" on a row —
fires once, caches per-banner-instance, reuses on subsequent row clicks.
Dismissing the banner without clicking any "Create rule" triggers ZERO
fetches.

The fetches are batched via `Promise.all` so the first dialog open pays
one round-trip, not three.

### Seed-from-row pattern (banner call-site)

When the banner opens the dialog for a row, it seeds:

```ts
initialName = `Match "${row.payee.slice(0, 100)}"`;
initialConditions = [{ field: "payee", op: "contains", value: row.payee.trim() }];
initialActions = []; // user picks the action(s)
```

The 100-char cap on the payee slice keeps the rule name comfortably inside
the `transaction_rules.name` 120-char column limit (8-char surround
overhead = `Match ""`).

The `initialConditions` / `initialActions` / `initialName` / `initialPriority` /
`initialIsActive` props are only honored when the `rule` prop is null /
undefined (i.e. fresh-create mode). In edit mode, the `rule.conditions`
and `rule.actions` win.

### The two call-sites

| Call-site | URL on submit | Response shape | Why it can't share infrastructure |
|---|---|---|---|
| `/settings/rules` | `POST /api/rules` (create), `PUT /api/rules` (update, body includes `id`) | `{success: true, data: {id, ...}}` | Full-CRUD surface; supports update + delete + toggle. |
| `/import/pending` UnresolvedCategoriesBanner | `POST /api/import/staged/[id]/create-rule` | `{success: true, data: {ruleId, updatedRowIds}}` | Staged-batch path; applies new rule to current batch via `applyRulesToStagedBatch(..., {onlyRuleId})`. Endpoint accepts both legacy and v2 shape; banner emits v2 only. |

### Combobox + dropdown order

The category Combobox sorts via `useDropdownOrder("category")` (lifted
from FINLYNQ-89 unchanged). Accounts + holdings ship in canonical
`/api/accounts` / `/api/portfolio` order. Both call-sites pick up the
same sort behavior since they share the component.

### Don't-touch list

- The shared editor must NOT pre-filter side-effect actions
  (`set_account` / `create_transfer`). Server is the authority; refusal
  surfaces via the inline error path.
- The shared editor must NOT bake in a URL or know which call-site it's
  in. Anything call-site-specific lives in `onSubmit`.
- The banner's `onRuleApplied` callback contract is unchanged. Parent
  (`/import/pending`) re-fetches staged detail on save.

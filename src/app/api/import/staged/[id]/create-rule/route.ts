/**
 * POST /api/import/staged/[id]/create-rule
 *
 * FINLYNQ-57 — inline rule creation from the staging-review dialog. When the
 * approve endpoint refuses with `code: 'unresolved_categories'`, the UI lets
 * the user create an auto-categorize rule that's applied to the CURRENT
 * staged batch only (not to historical `transactions` — they keep their
 * existing category).
 *
 * FINLYNQ-84 (2026-05-21): body accepts BOTH the legacy shorthand
 *   `{ matchField, matchType, matchValue, assignCategoryId }`
 * AND the new v2 shape
 *   `{ conditions: ConditionGroup, actions: Action[] }`.
 *
 * Legacy shorthand is synthesized into a v2 rule with a single payee/string
 * condition and a single `set_category` action, then written to the new
 * JSONB columns. Either path applies the resulting rule to matching rows
 * in this batch only.
 *
 * Behavior:
 *   1. Validate body — accept either shape.
 *   2. Synthesize ConditionGroup + Action[] (legacy) or pass through (v2).
 *   3. Insert into `transaction_rules` (new JSONB columns).
 *   4. Apply the just-created rule to matching rows in this batch via
 *      `applyRulesToStagedBatch(...,{ onlyRuleId })` — tier-preserving,
 *      import_hash-stable, side-effect-aware. `onlyRuleId` scopes the
 *      apply pass to the new rule so re-running this endpoint doesn't
 *      blow away other rules' effects on user-edited rows.
 *   5. Return `{ success: true, data: { ruleId, updatedRowIds: [...] } }`.
 *
 * Load-bearing (CLAUDE.md + helper file header):
 *   - `import_hash` is NEVER recomputed (helper enforces).
 *   - Per-row encryption tier preserved — `service` rows re-encrypt under
 *     PF_STAGING_KEY (sv1:); `user` rows re-encrypt under the user DEK (v1:);
 *     never flipped (helper enforces).
 *   - HTTP only — stdio MCP has no DEK on the staging tier; out of scope.
 *   - FINLYNQ-88 (2026-05-22): side-effect actions (`set_account` /
 *     `create_transfer`) on the v2 payload are now ACCEPTED. The helper
 *     folds them into staged-row UPDATEs so matched rows flip `tx_type='R'`
 *     + `target_account_id` (create_transfer) or `account_id` +
 *     `account_name_ct` (set_account) before approve. `link_id` minting
 *     still happens server-side at approve time via `createTransferPair`
 *     per the four-check rule. The pre-FINLYNQ-88 `side_effect_action_
 *     disallowed` refusal is GONE.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptField } from "@/lib/crypto/envelope";
import {
  ConditionGroup,
  Action,
  collectActionFKs,
  type ConditionGroup as ConditionGroupType,
  type Action as ActionType,
} from "@/lib/rules/schema";
import { applyRulesToStagedBatch } from "@/lib/rules/apply-to-staged-batch";
import { encryptRuleFields } from "@/lib/rules/crypto";
import { todayISO } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

// Legacy shorthand: matchField=payee|tags, matchType, matchValue, assignCategoryId.
const LegacyBodySchema = z.object({
  matchField: z.enum(["payee", "tags"]).default("payee"),
  matchType: z.enum(["contains", "exact", "regex"]).default("contains"),
  matchValue: z.string().min(1).max(2000),
  assignCategoryId: z.number().int().positive(),
});

// FINLYNQ-84 advanced shape.
const AdvancedBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  conditions: ConditionGroup,
  actions: z.array(Action).min(1).max(10),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Try advanced shape first; fall back to legacy on a fail. Either way we
  // end up with a (conditions, actions, displayName) tuple to write.
  let conditions: ConditionGroupType;
  let actions: ActionType[];
  let displayName: string | undefined;
  let legacyAssignCategoryId: number | undefined;

  const advancedParse = AdvancedBodySchema.safeParse(raw);
  if (advancedParse.success) {
    conditions = advancedParse.data.conditions;
    actions = advancedParse.data.actions;
    displayName = advancedParse.data.name;
    // FINLYNQ-88 (2026-05-22) — side-effect actions (`set_account`,
    // `create_transfer`) are now ACCEPTED here. The rule application
    // helper (`applyRulesToStagedBatch`) folds them into staged-row UPDATEs
    // so the matched rows flip `tx_type='R'` + `target_account_id`
    // (create_transfer) or get reassigned (set_account) before the user
    // clicks Approve. `link_id` minting still happens server-side at
    // approve time via `createTransferPair` per the four-check rule.
  } else {
    const legacyParse = LegacyBodySchema.safeParse(raw);
    if (!legacyParse.success) {
      return NextResponse.json(
        { error: legacyParse.error.issues[0]?.message ?? "Invalid body" },
        { status: 400 },
      );
    }
    const lb = legacyParse.data;
    // Synthesize a v2 rule: single string-condition + single set_category action.
    const cleanedValue = lb.matchValue.replace(/%/g, "");
    conditions = {
      all: [{ field: lb.matchField, op: lb.matchType, value: cleanedValue }],
    } as ConditionGroupType;
    actions = [{ kind: "set_category", categoryId: lb.assignCategoryId }] as ActionType[];
    legacyAssignCategoryId = lb.assignCategoryId;
  }

  // Verify staged_import ownership.
  const staged = await db
    .select({ id: schema.stagedImports.id, status: schema.stagedImports.status })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (staged.status !== "pending") {
    return NextResponse.json(
      { error: "Staged import is not pending — edits are no longer accepted" },
      { status: 409 },
    );
  }

  // Cross-tenant FK guard on every id inside actions + conditions.
  const fks = collectActionFKs(actions);
  for (const c of conditions.all) {
    if (c.field === "account") fks.accountIds.push(c.accountId);
  }
  const uniqueCats = [...new Set(fks.categoryIds)];
  const uniqueAccts = [...new Set(fks.accountIds)];
  const uniqueHoldings = [...new Set(fks.holdingIds)];
  if (uniqueCats.length > 0) {
    const owned = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(
        eq(schema.categories.userId, userId),
      ))
      .all();
    const ownedSet = new Set(owned.map((r) => r.id));
    for (const cid of uniqueCats) {
      if (!ownedSet.has(cid)) {
        return NextResponse.json({ error: "Category not found" }, { status: 404 });
      }
    }
  }
  if (uniqueAccts.length > 0) {
    const owned = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, userId))
      .all();
    const ownedSet = new Set(owned.map((r) => r.id));
    for (const aid of uniqueAccts) {
      if (!ownedSet.has(aid)) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
    }
  }
  if (uniqueHoldings.length > 0) {
    const owned = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(eq(schema.portfolioHoldings.userId, userId))
      .all();
    const ownedSet = new Set(owned.map((r) => r.id));
    for (const hid of uniqueHoldings) {
      if (!ownedSet.has(hid)) {
        return NextResponse.json({ error: "Holding not found" }, { status: 404 });
      }
    }
  }

  // For the legacy shorthand we need the category name for both the rule's
  // display label and the staged-row re-encryption. For the advanced path
  // we may have multiple categories referenced; we re-encrypt per matched
  // row using the FIRST `set_category` action's id (since pure patch's
  // categoryId is the last-wins value).
  const targetCategoryId = (() => {
    for (const a of actions) {
      if (a.kind === "set_category") return a.categoryId;
    }
    return legacyAssignCategoryId ?? null;
  })();

  let categoryNamePlain = "";
  if (targetCategoryId != null) {
    const catRow = await db
      .select({ nameCt: schema.categories.nameCt })
      .from(schema.categories)
      .where(and(
        eq(schema.categories.id, targetCategoryId),
        eq(schema.categories.userId, userId),
      ))
      .get();
    if (catRow?.nameCt) {
      categoryNamePlain = decryptField(dek, catRow.nameCt) ?? "";
    }
  }

  // Synthesize a display label if the caller didn't supply one.
  const synthName = (() => {
    if (displayName && displayName.trim().length > 0) return displayName.slice(0, 200);
    // For legacy shorthand: "Match "<value>" → <category>".
    if (legacyAssignCategoryId != null) {
      const firstCond = conditions.all[0];
      const val =
        firstCond && firstCond.field !== "amount" && firstCond.field !== "account" &&
        firstCond.field !== "date" && firstCond.field !== "currency"
          ? firstCond.value
          : "";
      return `Match "${val}" → ${categoryNamePlain || `category #${targetCategoryId}`}`.slice(0, 200);
    }
    // Advanced path — describe by condition count + action count.
    return `Rule (${conditions.all.length} cond / ${actions.length} action)`.slice(0, 200);
  })();

  // Encrypt sensitive free-text (name + payee/note/tags condition values +
  // rename_payee.to + set_tags.tags) AFTER the FK guards above (2026-06-01).
  // The applyRulesToStagedBatch call below re-loads + decrypts the rule before
  // matching. plan/encryption-plaintext-gaps.md
  const enc = encryptRuleFields(dek, { name: synthName, conditions, actions });

  const inserted = await db
    .insert(schema.transactionRules)
    .values({
      userId,
      name: enc.name ?? synthName,
      conditions: enc.conditions as unknown as object,
      actions: enc.actions as unknown as object,
      isActive: true,
      priority: 0,
      createdAt: todayISO(),
    })
    .returning({ id: schema.transactionRules.id });
  const ruleId = inserted[0]?.id;

  // FINLYNQ-88 — apply the just-created rule to matching rows in this batch.
  // `onlyRuleId` scopes the helper to the new rule so re-running this
  // endpoint doesn't blow away other rules' effects on user-edited rows.
  // Tier-preserving re-encrypt + `import_hash`-stable + `encryption_tier`-
  // stable + side-effect-aware (set_account / create_transfer fold into the
  // same UPDATE) is the helper's responsibility — see
  // src/lib/rules/apply-to-staged-batch.ts.
  let updatedRowIds: string[] = [];
  if (ruleId != null) {
    try {
      const applyResult = await applyRulesToStagedBatch(
        db,
        userId,
        dek,
        id,
        { onlyRuleId: ruleId },
      );
      updatedRowIds = applyResult.matches.map((m) => m.rowId);
    } catch (err) {

      console.error("[create-rule] applyRulesToStagedBatch threw", {
        userId,
        stagedImportId: id,
        ruleId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Surface as a soft warning — the rule WAS inserted, so the response
      // shape stays valid; the UI re-fetches and sees the rule on the next
      // load even if the per-batch apply pass didn't fire.
    }
  }

  // No invalidateUserTxCache — we didn't write to `transactions`.

  return NextResponse.json({
    success: true,
    data: {
      ruleId,
      categoryId: targetCategoryId,
      categoryName: categoryNamePlain,
      updatedRowIds,
      updatedCount: updatedRowIds.length,
    },
  });
}

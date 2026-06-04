"use client";

/**
 * InboxStagingTab — Manual-lens Staging tab body for /import.
 *
 * Consolidation Phase 5 (2026-06-04): instead of a bespoke account-scoped
 * list that deep-linked OUT to /import/pending, this embeds the shared
 * StagedReviewSurface (the same list + two-pane review the /import/pending
 * route renders), scoped to the selected account. Clicking a batch opens the
 * two-pane review IN PLACE — the user never leaves /import.
 *
 * The old N+1 binding-resolution hack (fetch every batch's detail to read
 * boundAccountId) is gone: boundAccountId now rides on the /api/import/staged
 * list payload, so the surface filters by accountScope directly.
 */

import { StagedReviewSurface } from "@/components/import/staged-review-surface";

export function InboxStagingTab({ accountId }: { accountId: number }) {
  return <StagedReviewSurface embedded accountScope={accountId} />;
}

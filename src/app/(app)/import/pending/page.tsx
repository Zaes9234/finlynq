"use client";

/**
 * /import/pending — standalone route for the staged-import review surface.
 *
 * Consolidation Phase 5 (2026-06-04): the surface itself (list + two-pane
 * detail orchestration) moved to the shared `StagedReviewSurface` component
 * so the account-anchored /import Staging tab can embed the SAME
 * implementation. This route is now a thin URL-driven wrapper (embedded=false)
 * — it still owns ?id=/?account= and serves email-import deep-links + the
 * all-accounts / still-unbound batch list.
 */

import { Suspense } from "react";
import { StagedReviewSurface } from "@/components/import/staged-review-surface";

export default function PendingImportsPage() {
  return (
    <Suspense fallback={null}>
      <StagedReviewSurface />
    </Suspense>
  );
}

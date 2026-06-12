/**
 * GET/PUT /api/settings/reconcile-hidden-accounts — per-user list of account
 * ids hidden from the /import reconcile account dropdown (FINLYNQ-147).
 *
 * Stored as a JSON array under the `reconcile_hidden_accounts` key in the
 * `settings` key/value table — NO migration (mirrors `confirm_csv_mapping`).
 * Hidden is a DROPDOWN-ONLY filter; hidden accounts stay reachable via this
 * settings surface and direct deep-links (/import?account=<id>, /import/pending).
 *
 * Request body (PUT, JSON): { accountIds: number[] }
 * Response: { accountIds: number[] } (normalized — sorted, de-duped, positive)
 *
 * Bare shape + requireAuth to match the sibling settings-key routes
 * (confirm-csv-mapping, email-retention, dev-mode).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import {
  getReconcileHiddenAccountIds,
  setReconcileHiddenAccountIds,
  parseHiddenAccountIds,
} from "@/lib/reconcile/hidden-accounts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const accountIds = await getReconcileHiddenAccountIds(auth.context.userId);
  return NextResponse.json({ accountIds });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body as { accountIds?: unknown } | null)?.accountIds;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { error: "accountIds must be an array of account ids" },
      { status: 400 },
    );
  }
  // parseHiddenAccountIds normalizes (positive ints, de-duped, sorted) and
  // never throws — a malformed element is dropped rather than 500ing.
  const normalized = parseHiddenAccountIds(JSON.stringify(raw));
  const accountIds = await setReconcileHiddenAccountIds(
    auth.context.userId,
    normalized,
  );
  return NextResponse.json({ accountIds });
}

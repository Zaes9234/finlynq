/**
 * Client-side opening-balance helpers (FINLYNQ-206).
 *
 * Single source of truth for the "read the backing transaction" + "write only
 * when changed, never delete, skip for investment accounts" rules so the create
 * and edit account dialogs share ONE implementation (DRY). The opening balance
 * is backed entirely by one `kind='opening_balance'` transaction; see
 * src/lib/accounts/opening-balance.ts for the server side.
 */

export type OpeningBalance = { amount: number; date: string };

/** Fetch the account's current opening balance (or null when none exists). */
export async function loadOpeningBalance(
  accountId: number,
): Promise<OpeningBalance | null> {
  try {
    const res = await fetch(`/api/accounts/${accountId}/opening-balance`);
    if (!res.ok) return null;
    const json = await res.json();
    const ob = json?.data ?? null;
    return ob ? { amount: ob.amount, date: ob.date } : null;
  } catch {
    return null;
  }
}

/**
 * Persist the opening balance for an account, but ONLY when it actually
 * changed and the account is a (non-investment) cash account.
 *
 * - investment account            → no-op (opening balance is cash-only in v1)
 * - empty amount + no existing row → no-op (nothing to create)
 * - empty amount + existing row    → PUT amount 0 (server zeroes, never deletes)
 * - otherwise (changed)            → PUT amount/date
 *
 * Returns `{ ok: true, skipped }` when no write was needed / it succeeded, or
 * `{ ok: false, error }` so the caller can surface it inline.
 */
export async function saveOpeningBalance(
  accountId: number,
  isInvestment: boolean,
  form: { amount: string; date: string },
  original: OpeningBalance | null,
): Promise<{ ok: true; skipped: boolean } | { ok: false; error: string }> {
  if (isInvestment) return { ok: true, skipped: true };

  const amtStr = form.amount.trim();
  const newAmount: number | null = amtStr === "" ? null : Number(amtStr);
  if (amtStr !== "" && !Number.isFinite(newAmount as number)) {
    return { ok: false, error: "Opening balance must be a number" };
  }
  const newDate = form.date || new Date().toISOString().slice(0, 10);

  const prevAmount = original?.amount ?? null;
  const changed =
    newAmount !== prevAmount || (original != null && newDate !== original.date);
  // Nothing to do: unchanged, or empty with no existing row to zero.
  if (!changed || (newAmount == null && original == null)) {
    return { ok: true, skipped: true };
  }

  try {
    const res = await fetch(`/api/accounts/${accountId}/opening-balance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: newAmount, date: newDate }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return { ok: false, error: d.error ?? "Failed to update the opening balance" };
    }
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, error: "Failed to update the opening balance" };
  }
}

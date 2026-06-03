// Pure balance math + body-building for the transaction split editor.
//
// Splits are view metadata on an already-saved parent transaction: they divide
// the parent's amount across multiple category/account rows without changing
// the parent itself. The server (POST /api/transactions/splits) does an atomic
// REPLACE (delete-then-insert) and derives each row's entered_* trilogy from
// the parent, so the client sends only the account-currency `amount`.
//
// Sign convention (mirrors the web split editor): the editor holds magnitudes
// (unsigned strings the user types) that must sum to |parentTotal|; the parent's
// sign is applied to each magnitude at save time so persisted split amounts
// match the parent's sign (a -$100 expense → splits of -$60 and -$40).
import type { Split, SplitInput } from "../../../shared/types";

/** A single editable split row in the mobile editor. `amount` is a user-typed
 *  magnitude (unsigned string); category/account are optional (server nullable). */
export interface SplitDraft {
  categoryId: number | null;
  accountId: number | null;
  amount: string;
  note: string;
  tags: string;
}

export function emptySplitDraft(): SplitDraft {
  return { categoryId: null, accountId: null, amount: "", note: "", tags: "" };
}

/** Rows whose amount parses to a finite number (blank/garbage rows excluded). */
export function filledSplitRows(rows: SplitDraft[]): SplitDraft[] {
  return rows.filter((r) => {
    const n = parseFloat(r.amount);
    return r.amount.trim() !== "" && !isNaN(n);
  });
}

/** Σ of the entered magnitudes across all rows (blank rows contribute 0). */
export function splitAllocated(rows: SplitDraft[]): number {
  return rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
}

/** |parentTotal| − allocated. Positive = under-allocated, negative = over. */
export function splitRemaining(parentTotal: number, rows: SplitDraft[]): number {
  return Math.abs(parentTotal) - splitAllocated(rows);
}

/** Within a cent of fully allocated against the parent total. */
export function splitsBalanced(parentTotal: number, rows: SplitDraft[]): boolean {
  return Math.abs(splitRemaining(parentTotal, rows)) < 0.01;
}

/** Save gate: ≥2 filled rows AND balanced to the parent total. */
export function canSaveSplits(parentTotal: number, rows: SplitDraft[]): boolean {
  const filled = filledSplitRows(rows);
  return filled.length >= 2 && splitsBalanced(parentTotal, filled);
}

/** Build the POST body's `splits[]`. Filled rows only; the parent's sign is
 *  applied to each magnitude. note/tags go out as plaintext (or omitted when
 *  blank) — the server encrypts them. Never emits null for note/tags (the
 *  server's zod schema rejects null). */
export function buildSplitInputs(parentTotal: number, rows: SplitDraft[]): SplitInput[] {
  const sign = parentTotal < 0 ? -1 : 1;
  return filledSplitRows(rows).map((r) => ({
    categoryId: r.categoryId,
    accountId: r.accountId,
    amount: sign * Math.abs(parseFloat(r.amount)),
    note: r.note.trim() ? r.note.trim() : undefined,
    tags: r.tags.trim() ? r.tags.trim() : undefined,
  }));
}

/** Hydrate editor rows from existing server splits. Amounts are shown as
 *  magnitudes (the editor re-applies the parent's sign on save). */
export function draftsFromSplits(splits: Split[]): SplitDraft[] {
  return splits.map((s) => ({
    categoryId: s.categoryId ?? null,
    accountId: s.accountId ?? null,
    amount: String(Math.abs(s.amount)),
    note: s.note ?? "",
    tags: s.tags ?? "",
  }));
}

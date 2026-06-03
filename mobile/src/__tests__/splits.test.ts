import {
  emptySplitDraft,
  filledSplitRows,
  splitAllocated,
  splitRemaining,
  splitsBalanced,
  canSaveSplits,
  buildSplitInputs,
  draftsFromSplits,
  type SplitDraft,
} from "../lib/splits";
import type { Split } from "../../../shared/types";

function row(p: Partial<SplitDraft> = {}): SplitDraft {
  return { ...emptySplitDraft(), ...p };
}

describe("splits balance math", () => {
  it("sums entered magnitudes, treating blank/garbage rows as 0", () => {
    const rows = [row({ amount: "60" }), row({ amount: "40" }), row({ amount: "" }), row({ amount: "x" })];
    expect(splitAllocated(rows)).toBe(100);
  });

  it("remaining = |parentTotal| - allocated (sign-agnostic on the parent)", () => {
    const rows = [row({ amount: "60" }), row({ amount: "30" })];
    // Parent is a -$100 expense; editor works in magnitudes.
    expect(splitRemaining(-100, rows)).toBeCloseTo(10, 5);
    expect(splitRemaining(100, rows)).toBeCloseTo(10, 5);
  });

  it("is balanced within a cent, over/under outside it", () => {
    const exact = [row({ amount: "60" }), row({ amount: "40" })];
    const off = [row({ amount: "60" }), row({ amount: "39.5" })];
    const rounding = [row({ amount: "33.33" }), row({ amount: "33.33" }), row({ amount: "33.34" })];
    expect(splitsBalanced(100, exact)).toBe(true);
    expect(splitsBalanced(100, off)).toBe(false);
    expect(splitsBalanced(100, rounding)).toBe(true); // 100.00 exactly
  });
});

describe("canSaveSplits gate", () => {
  it("requires at least two FILLED rows", () => {
    // One filled + one blank → not enough rows even though it 'balances'.
    expect(canSaveSplits(100, [row({ amount: "100" }), row({ amount: "" })])).toBe(false);
    expect(canSaveSplits(100, [row({ amount: "60" }), row({ amount: "40" })])).toBe(true);
  });

  it("requires the filled rows to balance to the parent total", () => {
    expect(canSaveSplits(100, [row({ amount: "60" }), row({ amount: "30" })])).toBe(false);
    expect(canSaveSplits(-100, [row({ amount: "60" }), row({ amount: "40" })])).toBe(true);
  });
});

describe("buildSplitInputs", () => {
  it("applies the parent's sign to each magnitude and drops blank rows", () => {
    const rows = [
      row({ amount: "60", categoryId: 5 }),
      row({ amount: "40", accountId: 7 }),
      row({ amount: "" }),
    ];
    const out = buildSplitInputs(-100, rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ categoryId: 5, accountId: null, amount: -60, note: undefined, tags: undefined });
    expect(out[1]).toEqual({ categoryId: null, accountId: 7, amount: -40, note: undefined, tags: undefined });
  });

  it("keeps a positive parent's splits positive and sends note/tags as plaintext", () => {
    const out = buildSplitInputs(100, [
      row({ amount: "100", note: " groceries ", tags: "food, weekly" }),
      row({ amount: "0" }),
    ]);
    // "0" parses to a finite number → it is a filled row.
    expect(out.map((s) => s.amount)).toEqual([100, 0]);
    expect(out[0].note).toBe("groceries");
    expect(out[0].tags).toBe("food, weekly");
  });

  it("never emits null for note/tags (server zod rejects null)", () => {
    const out = buildSplitInputs(50, [row({ amount: "25" }), row({ amount: "25" })]);
    for (const s of out) {
      expect(s.note).not.toBeNull();
      expect(s.tags).not.toBeNull();
    }
  });
});

describe("draftsFromSplits", () => {
  it("hydrates rows as magnitudes from signed server splits", () => {
    const splits: Split[] = [
      { id: 1, transactionId: 9, categoryId: 5, accountId: null, amount: -60, note: "rent", tags: null },
      { id: 2, transactionId: 9, categoryId: null, accountId: 7, amount: -40, note: null, tags: "x" },
    ];
    const drafts = draftsFromSplits(splits);
    expect(drafts[0]).toEqual({ categoryId: 5, accountId: null, amount: "60", note: "rent", tags: "" });
    expect(drafts[1]).toEqual({ categoryId: null, accountId: 7, amount: "40", note: "", tags: "x" });
  });
});

describe("filledSplitRows", () => {
  it("excludes blank and non-numeric rows", () => {
    const rows = [row({ amount: "10" }), row({ amount: "  " }), row({ amount: "abc" }), row({ amount: "-5" })];
    expect(filledSplitRows(rows).map((r) => r.amount)).toEqual(["10", "-5"]);
  });
});

import {
  layoutSankey,
  sankeyDesiredWidth,
  truncateLabel,
  type SankeyDatum,
} from "../lib/reports/sankey";

const W = 600;

describe("layoutSankey", () => {
  it("flags empty when there is no income or expense", () => {
    const out = layoutSankey([], [], { width: W });
    expect(out.empty).toBe(true);
    expect(out.incomeNodes).toHaveLength(0);
    expect(out.expenseNodes).toHaveLength(0);
    expect(out.flows).toHaveLength(0);
  });

  it("builds a closed bezier flow per income×expense pair", () => {
    const income: SankeyDatum[] = [{ name: "Salary", value: 5000 }];
    const expenses: SankeyDatum[] = [
      { name: "Rent", value: 2000 },
      { name: "Food", value: 800 },
    ];
    const out = layoutSankey(income, expenses, { width: W });
    expect(out.empty).toBe(false);
    expect(out.incomeNodes).toHaveLength(1);
    expect(out.expenseNodes).toHaveLength(2);
    // 1 income × 2 expenses = 2 flows.
    expect(out.flows).toHaveLength(2);
    for (const f of out.flows) {
      expect(f.d.startsWith("M")).toBe(true);
      expect(f.d.includes("C")).toBe(true);
      expect(f.d.trim().endsWith("Z")).toBe(true);
      expect(f.value).toBeGreaterThan(0);
    }
    expect(out.totalIncome).toBe(5000);
    expect(out.totalExpenses).toBe(2800);
  });

  it("drops non-positive datums before laying out", () => {
    const out = layoutSankey(
      [
        { name: "Salary", value: 5000 },
        { name: "Bad", value: 0 },
        { name: "Neg", value: -10 },
      ],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(out.incomeNodes).toHaveLength(1);
    expect(out.incomeNodes[0].name).toBe("Salary");
  });

  it("scales node heights to the larger of total income / expenses", () => {
    // Income 6000 > expenses 3000 → full income column should fill the band;
    // the single expense node should be ~half the band height.
    const out = layoutSankey(
      [{ name: "Salary", value: 6000 }],
      [{ name: "Rent", value: 3000 }],
      { width: W }
    );
    const incH = out.incomeNodes[0].h;
    const expH = out.expenseNodes[0].h;
    expect(incH).toBeGreaterThan(expH);
    // expense (3000) is half of maxTotal (6000) → ~half the income height.
    expect(expH).toBeCloseTo(incH / 2, 0);
  });

  it("emits a savings bar only when income exceeds expenses", () => {
    const surplus = layoutSankey(
      [{ name: "Salary", value: 5000 }],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(surplus.savings).toBe(3000);
    expect(surplus.savingsBar).not.toBeNull();
    expect(surplus.savingsBar!.w).toBeGreaterThan(0);

    const deficit = layoutSankey(
      [{ name: "Salary", value: 1000 }],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(deficit.savings).toBe(-1000);
    expect(deficit.savingsBar).toBeNull();
  });

  it("keeps expense nodes on the right of income nodes", () => {
    const out = layoutSankey(
      [{ name: "Salary", value: 5000 }],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(out.expenseNodes[0].x).toBeGreaterThan(out.incomeNodes[0].x);
  });
});

describe("sankeyDesiredWidth", () => {
  it("is at least wide enough for both label columns + nodes + a flow band", () => {
    const w = sankeyDesiredWidth({});
    // 2*(96+6) labels + 2*16 nodes + 90 band + 16 padding = 342.
    expect(w).toBeGreaterThanOrEqual(300);
  });
});

describe("truncateLabel", () => {
  it("appends an ellipsis past the max", () => {
    expect(truncateLabel("Groceries and Dining", 8)).toBe("Groceri…");
  });
  it("leaves short labels untouched", () => {
    expect(truncateLabel("Rent", 8)).toBe("Rent");
  });
});

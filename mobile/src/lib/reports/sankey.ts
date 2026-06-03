// Pure node/link layout math for the cash-flow Sankey. Mirrors the web custom
// Sankey component (pf-app/src/components/sankey-chart.tsx): income sources on
// the left, expense uses on the right, with each income source distributing
// proportionally across every expense (a full bipartite flow set). Node heights
// scale to the larger of total income / total expenses. JSX-free + deterministic
// so the geometry is unit-tested without a renderer; the component is a thin SVG
// wrapper over this.
//
// One faithful clean-up vs web: flows begin at the income node's right edge
// (web left a one-nodeWidth gap there). Everything else — proportional flows,
// vertical centering, the savings bar — matches.

export interface SankeyDatum {
  name: string;
  value: number;
}

export interface SankeyNode {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  value: number;
  /** Index into the chart palette (expense nodes); income nodes use the
   *  positive/teal color so this stays -1 for them. */
  colorIndex: number;
}

export interface SankeyFlow {
  d: string;
  colorIndex: number;
  fromName: string;
  toName: string;
  value: number;
}

export interface SankeyBar {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SankeyLayout {
  width: number;
  height: number;
  incomeNodes: SankeyNode[];
  expenseNodes: SankeyNode[];
  flows: SankeyFlow[];
  totalIncome: number;
  totalExpenses: number;
  savings: number;
  savingsBar: SankeyBar | null;
  /** y of the column-header text baseline. */
  headerY: number;
  incomeHeaderX: number;
  expenseHeaderX: number;
  /** No data at all → caller renders an empty state. */
  empty: boolean;
}

export interface SankeyOptions {
  width: number;
  nodeWidth?: number;
  labelGap?: number;
  /** Max px reserved for each side's label column. */
  maxLabelWidth?: number;
  /** Vertical px per node row (drives total height). */
  rowHeight?: number;
  minHeight?: number;
  paletteSize?: number;
  padding?: { top: number; bottom: number; left: number; right: number };
}

const DEFAULTS = {
  nodeWidth: 16,
  labelGap: 6,
  maxLabelWidth: 96,
  rowHeight: 46,
  minHeight: 260,
  paletteSize: 5,
  padding: { top: 26, bottom: 26, left: 8, right: 8 },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Minimum chart width that fits both label columns + the two nodes + a legible
 * flow band, given the layout options. The screen takes max(screenWidth, this)
 * and wraps the SVG in a horizontal ScrollView so a narrow phone still gets a
 * readable flow band.
 */
export function sankeyDesiredWidth(opts: Omit<SankeyOptions, "width">, minFlowBand = 90): number {
  const nodeWidth = opts.nodeWidth ?? DEFAULTS.nodeWidth;
  const labelGap = opts.labelGap ?? DEFAULTS.labelGap;
  const maxLabelWidth = opts.maxLabelWidth ?? DEFAULTS.maxLabelWidth;
  const padding = opts.padding ?? DEFAULTS.padding;
  const labelArea = maxLabelWidth + labelGap;
  return padding.left + padding.right + 2 * labelArea + 2 * nodeWidth + minFlowBand;
}

/** Truncate a label to maxChars with an ellipsis. */
export function truncateLabel(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, Math.max(1, maxChars - 1)) + "…" : text;
}

export function layoutSankey(
  income: SankeyDatum[],
  expenses: SankeyDatum[],
  opts: SankeyOptions
): SankeyLayout {
  const nodeWidth = opts.nodeWidth ?? DEFAULTS.nodeWidth;
  const labelGap = opts.labelGap ?? DEFAULTS.labelGap;
  const maxLabelWidth = opts.maxLabelWidth ?? DEFAULTS.maxLabelWidth;
  const rowHeight = opts.rowHeight ?? DEFAULTS.rowHeight;
  const minHeight = opts.minHeight ?? DEFAULTS.minHeight;
  const paletteSize = Math.max(1, opts.paletteSize ?? DEFAULTS.paletteSize);
  const padding = opts.padding ?? DEFAULTS.padding;
  const width = opts.width;

  // Keep only positive values (negatives/zeros can't be a flow).
  const inc = income.filter((d) => d.value > 0);
  const exp = expenses.filter((d) => d.value > 0);

  const totalIncome = inc.reduce((s, d) => s + d.value, 0);
  const totalExpenses = exp.reduce((s, d) => s + d.value, 0);

  const labelArea = maxLabelWidth + labelGap;
  const incomeNodeX = padding.left + labelArea;
  const expenseNodeX = width - padding.right - labelArea - nodeWidth;
  const headerY = 14;

  const empty = totalIncome === 0 && totalExpenses === 0;

  const height = Math.max(
    minHeight,
    Math.max(inc.length, exp.length) * rowHeight + padding.top + padding.bottom
  );
  const flowHeight = height - padding.top - padding.bottom;
  const maxTotal = Math.max(totalIncome, totalExpenses, 1);

  const incomeGap = inc.length > 1 ? 6 : 0;
  const expenseGap = exp.length > 1 ? 6 : 0;
  const incomeTotalGap = (inc.length - 1) * incomeGap;
  const expenseTotalGap = (exp.length - 1) * expenseGap;
  const incomeScale = (flowHeight - incomeTotalGap) / maxTotal;
  const expenseScale = (flowHeight - expenseTotalGap) / maxTotal;

  // Income nodes (left), vertically centered in the flow band.
  let iy = padding.top + (flowHeight - totalIncome * incomeScale - incomeTotalGap) / 2;
  const incomeNodes: SankeyNode[] = inc.map((d) => {
    const h = d.value * incomeScale;
    const node: SankeyNode = { name: d.name, x: incomeNodeX, y: round2(iy), w: nodeWidth, h: round2(h), value: d.value, colorIndex: -1 };
    iy += h + incomeGap;
    return node;
  });

  // Expense nodes (right).
  let ey = padding.top + (flowHeight - totalExpenses * expenseScale - expenseTotalGap) / 2;
  const expenseNodes: SankeyNode[] = exp.map((d, i) => {
    const h = d.value * expenseScale;
    const node: SankeyNode = { name: d.name, x: expenseNodeX, y: round2(ey), w: nodeWidth, h: round2(h), value: d.value, colorIndex: i % paletteSize };
    ey += h + expenseGap;
    return node;
  });

  // Bipartite flows — each income source distributes proportionally to expenses.
  const flows: SankeyFlow[] = [];
  const incomeOffsets = incomeNodes.map(() => 0);
  const expenseOffsets = expenseNodes.map(() => 0);
  const x0 = incomeNodeX + nodeWidth; // income node right edge
  const x1 = expenseNodeX; // expense node left edge
  const cx = (x0 + x1) / 2;

  for (let i = 0; i < incomeNodes.length; i++) {
    for (let j = 0; j < expenseNodes.length; j++) {
      const value = (incomeNodes[i].value / totalIncome) * expenseNodes[j].value;
      if (value < 0.01) continue;
      const fromH = value * incomeScale;
      const toH = value * expenseScale;
      const y0Top = incomeNodes[i].y + incomeOffsets[i];
      const y0Bot = y0Top + fromH;
      const y1Top = expenseNodes[j].y + expenseOffsets[j];
      const y1Bot = y1Top + toH;
      const d = `M${round2(x0)},${round2(y0Top)} C${round2(cx)},${round2(y0Top)} ${round2(cx)},${round2(y1Top)} ${round2(x1)},${round2(y1Top)} L${round2(x1)},${round2(y1Bot)} C${round2(cx)},${round2(y1Bot)} ${round2(cx)},${round2(y0Bot)} ${round2(x0)},${round2(y0Bot)} Z`;
      flows.push({ d, colorIndex: j % paletteSize, fromName: incomeNodes[i].name, toName: expenseNodes[j].name, value });
      incomeOffsets[i] += fromH;
      expenseOffsets[j] += toH;
    }
  }

  const savings = round2(totalIncome - totalExpenses);
  const savingsBar: SankeyBar | null =
    savings > 0 && totalIncome > 0
      ? { x: round2(x0), y: round2(height + 8), w: round2((savings / totalIncome) * (x1 - x0)), h: 18 }
      : null;

  return {
    width,
    height: savingsBar ? height + 36 : height,
    incomeNodes,
    expenseNodes,
    flows,
    totalIncome: round2(totalIncome),
    totalExpenses: round2(totalExpenses),
    savings,
    savingsBar,
    headerY,
    incomeHeaderX: incomeNodeX + nodeWidth / 2,
    expenseHeaderX: expenseNodeX + nodeWidth / 2,
    empty,
  };
}

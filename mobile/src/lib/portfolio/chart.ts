// Pure SVG geometry for the portfolio charts (AllocationDonut + PerformanceChart).
// JSX-free + deterministic so it can be unit-tested without a renderer.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cumulative [start, end) fractions (0..1) for a set of values. Negative values
 * clamp to 0. When the total is non-positive every segment is empty so the
 * caller can short-circuit to an "—" state.
 */
export function cumulativeFractions(
  values: number[]
): Array<{ start: number; end: number }> {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return values.map(() => ({ start: 0, end: 0 }));
  const out: Array<{ start: number; end: number }> = [];
  let acc = 0;
  for (const v of values) {
    const frac = Math.max(0, v) / total;
    out.push({ start: round4(acc), end: round4(acc + frac) });
    acc += frac;
  }
  // Snap the final end to exactly 1 to avoid a hairline gap from rounding.
  if (out.length > 0) out[out.length - 1].end = 1;
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function polar(cx: number, cy: number, r: number, frac: number): { x: number; y: number } {
  // 0 frac = 12 o'clock, clockwise.
  const angle = (frac * 360 - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/**
 * SVG path `d` for one donut wedge between [startFrac, endFrac) of the ring.
 * A full-circle wedge (span ≥ 1) is nudged just under 360° because SVG arcs
 * can't draw a closed 360° wedge (start/end points would coincide).
 */
export function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startFrac: number,
  endFrac: number
): string {
  const span = endFrac - startFrac;
  if (span <= 0) return "";
  const end = span >= 1 ? endFrac - 0.0001 : endFrac;
  const large = end - startFrac > 0.5 ? 1 : 0;
  const o0 = polar(cx, cy, rOuter, startFrac);
  const o1 = polar(cx, cy, rOuter, end);
  const i1 = polar(cx, cy, rInner, end);
  const i0 = polar(cx, cy, rInner, startFrac);
  return [
    `M ${round2(o0.x)} ${round2(o0.y)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${round2(o1.x)} ${round2(o1.y)}`,
    `L ${round2(i1.x)} ${round2(i1.y)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${round2(i0.x)} ${round2(i0.y)}`,
    "Z",
  ].join(" ");
}

/** Shared min/max across one or more numeric series (for a common Y scale). */
export function seriesRange(arrays: number[][]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of arrays) {
    for (const v of arr) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

/**
 * Map a numeric series to a "x,y x,y …" polyline points string scaled into a
 * (width × height) box, inverted so larger values sit higher. A single point
 * is centered horizontally. `min`/`max` are passed in (shared across series).
 */
export function scalePoints(
  values: number[],
  min: number,
  max: number,
  width: number,
  height: number,
  padY = 6
): string {
  const n = values.length;
  if (n === 0) return "";
  const span = max - min || 1;
  const usableH = Math.max(1, height - padY * 2);
  return values
    .map((v, i) => {
      const x = n === 1 ? width / 2 : (i / (n - 1)) * width;
      const y = padY + (1 - (v - min) / span) * usableH;
      return `${round2(x)},${round2(y)}`;
    })
    .join(" ");
}

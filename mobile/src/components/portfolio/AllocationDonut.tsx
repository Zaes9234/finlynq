// SVG donut + legend for portfolio allocation (by type / by account). Pure
// react-native-svg (already a dep). Sub-1% slices fold into "Other". Static.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../../theme";
import { formatCurrency } from "../../lib/format";
import { cumulativeFractions, arcPath } from "../../lib/portfolio/chart";

export interface AllocationSlice {
  label: string;
  value: number;
}

const SIZE = 118;
const R_OUTER = SIZE / 2;
const R_INNER = SIZE / 2 - 26;

function compactTotal(value: number, currency: string): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return formatCurrency(value / 1_000_000, currency, { decimals: 1 }) + "M";
  if (abs >= 1_000) return formatCurrency(value / 1_000, currency, { decimals: 0 }) + "k";
  return formatCurrency(value, currency, { decimals: 0 });
}

export function AllocationDonut({
  data,
  currency,
}: {
  data: AllocationSlice[];
  currency: string;
}) {
  const { colors } = useTheme();
  const palette = [colors.chart1, colors.chart2, colors.chart5, colors.chart4, colors.chart3];

  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);

  // Fold sub-1% slices into a single "Other" bucket so the ring + legend stay
  // legible. Keep input order; bucket trailing remainder.
  const visible: AllocationSlice[] = [];
  let other = 0;
  for (const d of data) {
    if (total > 0 && d.value / total < 0.01) other += Math.max(0, d.value);
    else if (d.value > 0) visible.push(d);
  }
  if (other > 0) visible.push({ label: "Other", value: other });

  const colored = visible.map((s, i) => ({
    ...s,
    color: s.label === "Other" ? colors.mutedForeground : palette[i % palette.length],
    pct: total > 0 ? (s.value / total) * 100 : 0,
  }));
  const fractions = cumulativeFractions(colored.map((s) => s.value));

  if (total <= 0 || colored.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.mutedForeground }]}>No allocation data</Text>
    );
  }

  return (
    <View style={styles.row}>
      <View style={styles.donutWrap}>
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          {colored.map((s, i) => (
            <Path
              key={`${s.label}-${i}`}
              d={arcPath(
                R_OUTER,
                R_OUTER,
                R_OUTER,
                R_INNER,
                fractions[i].start,
                fractions[i].end
              )}
              fill={s.color}
            />
          ))}
        </Svg>
        <View style={styles.center} pointerEvents="none">
          <Text style={[styles.centerLabel, { color: colors.mutedForeground }]}>Total</Text>
          <Text style={[styles.centerValue, { color: colors.foreground }]}>
            {compactTotal(total, currency)}
          </Text>
        </View>
      </View>
      <View style={styles.legend}>
        {colored.map((s, i) => (
          <View key={`${s.label}-${i}`} style={styles.legendRow}>
            <View style={[styles.dot, { backgroundColor: s.color }]} />
            <Text style={[styles.legendLabel, { color: colors.foreground }]} numberOfLines={1}>
              {s.label}
            </Text>
            <Text style={[styles.legendVal, { color: colors.mutedForeground }]}>
              {s.pct.toFixed(0)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  donutWrap: { width: SIZE, height: SIZE, alignItems: "center", justifyContent: "center" },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  centerLabel: { fontSize: 11 },
  centerValue: { fontSize: 16, fontWeight: "800", fontVariant: ["tabular-nums"] },
  legend: { flex: 1, marginLeft: 16, gap: 7 },
  legendRow: { flexDirection: "row", alignItems: "center" },
  dot: { width: 10, height: 10, borderRadius: 3, marginRight: 8 },
  legendLabel: { flex: 1, fontSize: 13 },
  legendVal: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  empty: { fontSize: 13, textAlign: "center", paddingVertical: 16 },
});

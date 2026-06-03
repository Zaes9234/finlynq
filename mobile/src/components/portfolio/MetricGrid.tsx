// 2-column label/value metric grid — the "Investment returns" + performance
// stat blocks. Pure presentational; tone drives the value color.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../../theme";

export interface MetricItem {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "default";
}

export function MetricGrid({ items }: { items: MetricItem[] }) {
  const { colors } = useTheme();
  const toneColor = (tone?: MetricItem["tone"]) =>
    tone === "pos" ? colors.pos : tone === "neg" ? colors.neg : colors.foreground;
  return (
    <View style={styles.grid}>
      {items.map((m, i) => (
        <View
          key={`${m.label}-${i}`}
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Text style={[styles.label, { color: colors.mutedForeground }]} numberOfLines={1}>
            {m.label}
          </Text>
          <Text style={[styles.value, { color: toneColor(m.tone) }]} numberOfLines={1}>
            {m.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  card: {
    width: "48.5%",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
  },
  label: { fontSize: 12, marginBottom: 3 },
  value: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
});

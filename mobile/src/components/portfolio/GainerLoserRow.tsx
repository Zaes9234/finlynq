// One "top mover" row — up/down chip + symbol/name + %change + day-change $.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { formatCurrency, safeName } from "../../lib/format";
import type { EnrichedHolding } from "../../../../shared/types";

export function GainerLoserRow({
  holding,
  currency,
}: {
  holding: EnrichedHolding;
  currency: string;
}) {
  const { colors } = useTheme();
  const pct = holding.changePct ?? 0;
  const up = pct >= 0;
  const tone = up ? colors.pos : colors.neg;
  // Day-change dollar estimate in the holding's own quote currency.
  const dayChange = (holding.change ?? 0) * (holding.quantity ?? 0);
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View
        style={[
          styles.arrow,
          { backgroundColor: up ? colors.pos + "26" : colors.neg + "26" },
        ]}
      >
        <Icon name={up ? "inflow" : "outflow"} size={14} color={tone} />
      </View>
      <View style={styles.mid}>
        <Text style={[styles.symbol, { color: colors.foreground }]} numberOfLines={1}>
          {safeName(holding.symbol || holding.name, "—")}
        </Text>
        <Text style={[styles.name, { color: colors.mutedForeground }]} numberOfLines={1}>
          {safeName(holding.name)}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.pct, { color: tone }]}>
          {up ? "+" : ""}
          {pct.toFixed(1)}%
        </Text>
        <Text style={[styles.change, { color: colors.mutedForeground }]}>
          {dayChange >= 0 ? "+" : ""}
          {formatCurrency(dayChange, holding.quoteCurrency ?? currency, { decimals: 0 })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  arrow: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  mid: { flex: 1, marginRight: 12 },
  symbol: { fontSize: 14, fontWeight: "600" },
  name: { fontSize: 12, marginTop: 1 },
  right: { alignItems: "flex-end" },
  pct: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  change: { fontSize: 12, marginTop: 1, fontVariant: ["tabular-nums"] },
});

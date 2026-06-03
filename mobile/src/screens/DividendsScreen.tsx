// Dividend income — grouped by year / quarter / holding. Reads
// GET /api/portfolio/dividends?groupBy= (enveloped).
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency } from "../lib/format";
import { Icon } from "../components/icon";
import type { DividendIncomeResult } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "Dividends">;
type GroupBy = "year" | "quarter" | "holding";

export default function DividendsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const displayCurrency = route.params?.displayCurrency ?? "CAD";
  const [groupBy, setGroupBy] = useState<GroupBy>("year");
  const [data, setData] = useState<DividendIncomeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    endpoints
      .getDividends(`groupBy=${groupBy}`)
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          logger.warn("dividends", "fetch failed", { error: res.error });
          setError(res.error);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        logger.error("dividends", "fetch threw", { detail: String(e) });
        setError("Cannot connect to server");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [groupBy]);

  const groups = data?.groups ?? [];
  const total = data?.totals.amount ?? 0;
  const payments = data?.totals.rowCount ?? 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Portfolio</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Dividend income</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.chipRow}>
          {(["year", "quarter", "holding"] as GroupBy[]).map((g) => {
            const active = groupBy === g;
            return (
              <TouchableOpacity
                key={g}
                onPress={() => setGroupBy(g)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? colors.primary : colors.secondary,
                    borderColor: active ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={{
                    color: active ? colors.primaryForeground : colors.foreground,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  By {g}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>Total dividends</Text>
              <Text style={[styles.cardValue, { color: colors.foreground }]}>
                {formatCurrency(total, displayCurrency, { decimals: 0 })}
              </Text>
              <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                {payments} payment{payments === 1 ? "" : "s"}
              </Text>
            </View>

            {groups.length === 0 ? (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No dividend income recorded.
              </Text>
            ) : (
              groups.map((g) => (
                <View
                  key={g.bucket}
                  style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={styles.rowTop}>
                    <Text style={[styles.rowLabel, { color: colors.foreground }]} numberOfLines={1}>
                      {g.label}
                    </Text>
                    <Text style={[styles.rowAmt, { color: colors.foreground }]}>
                      {formatCurrency(g.amount, g.currency, { decimals: 0 })}
                    </Text>
                  </View>
                  <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                    {g.rowCount} payment{g.rowCount === 1 ? "" : "s"}
                    {g.reinvestedCount > 0 ? ` · ${g.reinvestedCount} reinvested` : ""}
                    {g.withholdingCount > 0 ? ` · ${g.withholdingCount} withholding` : ""}
                  </Text>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  chipRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardHint: { fontSize: 12, marginTop: 4 },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 8 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontSize: 15, fontWeight: "700", flex: 1, marginRight: 10 },
  rowAmt: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rowMeta: { fontSize: 12, marginTop: 3 },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});

// Portfolio performance over time — period selector + value/cost line chart +
// TWRR / MWRR stat grid. Reads GET /api/portfolio/performance (enveloped).
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency } from "../lib/format";
import { Icon } from "../components/icon";
import { PerformanceChart } from "../components/portfolio/PerformanceChart";
import { MetricGrid, type MetricItem } from "../components/portfolio/MetricGrid";
import type { PortfolioPerformance } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "Performance">;

const PERIODS = ["1m", "3m", "6m", "ytd", "1y", "all"] as const;

function pct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

export default function PerformanceScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("1y");
  const [data, setData] = useState<PortfolioPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    endpoints
      .getPortfolioPerformance(period)
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          logger.warn("performance", "fetch failed", { error: res.error });
          setError(res.error);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        logger.error("performance", "fetch threw", { detail: String(e) });
        setError("Cannot connect to server");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [period]);

  const currency = data?.currency ?? "USD";
  const metrics: MetricItem[] = data
    ? [
        { label: `TWRR (${period.toUpperCase()})`, value: pct(data.twrr.period), tone: data.twrr.period >= 0 ? "pos" : "neg" },
        { label: "Annualized", value: pct(data.twrr.annualized), tone: data.twrr.annualized >= 0 ? "pos" : "neg" },
        {
          label: "MWRR (XIRR)",
          value: data.mwrr.converged ? pct(data.mwrr.irr) : "—",
          tone: data.mwrr.irr >= 0 ? "pos" : "neg",
        },
        {
          label: "Cost basis",
          value: formatCurrency(data.series[data.series.length - 1]?.costBasis ?? 0, currency, { decimals: 0 }),
        },
      ]
    : [];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Portfolio</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Performance</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.seg, { backgroundColor: colors.secondary }]}>
          {PERIODS.map((p) => {
            const active = p === period;
            return (
              <TouchableOpacity
                key={p}
                style={[styles.segBtn, active && { backgroundColor: colors.primary }]}
                onPress={() => setPeriod(p)}
              >
                <Text
                  style={[styles.segText, { color: active ? colors.primaryForeground : colors.mutedForeground }]}
                >
                  {p.toUpperCase()}
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
              <PerformanceChart series={data?.series ?? []} />
            </View>
            <MetricGrid items={metrics} />
            {(data?.gapsFilledDays ?? 0) > 0 && (
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                · {data!.gapsFilledDays} days gap-filled (shown dashed)
              </Text>
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
  seg: { flexDirection: "row", borderRadius: 10, padding: 3, marginBottom: 12 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 7, alignItems: "center" },
  segText: { fontSize: 12, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  hint: { fontSize: 12, marginTop: 4 },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});

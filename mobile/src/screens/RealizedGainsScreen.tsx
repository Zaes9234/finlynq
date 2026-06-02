// Realized gains — tax-year + term (short/long/all) filters + base-currency
// toggle. Reads GET /api/portfolio/realized-gains (enveloped). Each row is one
// lot closure.
import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName, formatShortDate } from "../lib/format";
import { Icon } from "../components/icon";
import type { RealizedGainsResult, RealizedGainRow } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "RealizedGains">;
type Term = "all" | "short" | "long";

function recentYears(): number[] {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2, y - 3];
}

export default function RealizedGainsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const displayCurrency = route.params?.displayCurrency ?? "CAD";
  const [year, setYear] = useState<number | null>(recentYears()[0]);
  const [term, setTerm] = useState<Term>("all");
  const [base, setBase] = useState(false);
  const [data, setData] = useState<RealizedGainsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const years = useMemo(recentYears, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("term", term);
    if (year != null) params.set("taxYear", String(year));
    if (base) params.set("currency", "base");
    endpoints
      .getRealizedGains(params.toString())
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          logger.warn("realized-gains", "fetch failed", { error: res.error });
          setError(res.error);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        logger.error("realized-gains", "fetch threw", { detail: String(e) });
        setError("Cannot connect to server");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [year, term, base]);

  const rows = data?.rows ?? [];
  const totalGain = base
    ? data?.totalRealizedGainInBase ?? 0
    : data?.totals.realizedGain ?? 0;
  const holdingsCount = new Set(rows.map((r) => r.holdingId)).size;
  const totalColor = totalGain > 0 ? colors.pos : totalGain < 0 ? colors.neg : colors.foreground;

  const rowGain = (r: RealizedGainRow) => (base ? r.realizedGainInBase ?? r.realizedGain : r.realizedGain);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Portfolio</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Realized gains</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Year chips */}
        <View style={styles.chipRow}>
          <Chip label="All years" active={year == null} onPress={() => setYear(null)} />
          {years.map((y) => (
            <Chip key={y} label={String(y)} active={year === y} onPress={() => setYear(y)} />
          ))}
        </View>
        {/* Term chips */}
        <View style={styles.chipRow}>
          {(["all", "short", "long"] as Term[]).map((t) => (
            <Chip
              key={t}
              label={t === "all" ? "All" : t === "short" ? "Short" : "Long"}
              active={term === t}
              onPress={() => setTerm(t)}
            />
          ))}
        </View>
        {/* Base-currency toggle */}
        <View style={[styles.toggleRow, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.toggleTitle, { color: colors.foreground }]}>Show in base currency</Text>
            <Text style={[styles.toggleSub, { color: colors.mutedForeground }]}>
              Cross-currency gains via historical FX
            </Text>
          </View>
          <Switch
            value={base}
            onValueChange={setBase}
            trackColor={{ true: colors.primary, false: colors.border }}
          />
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} />
        ) : error ? (
          <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
                Total realized {year != null ? `(${year})` : "(all years)"}
              </Text>
              <Text style={[styles.cardValue, { color: totalColor }]}>
                {totalGain >= 0 ? "+" : ""}
                {formatCurrency(totalGain, displayCurrency, { decimals: 0 })}
              </Text>
              <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                {rows.length} closure{rows.length === 1 ? "" : "s"} · {holdingsCount} holding
                {holdingsCount === 1 ? "" : "s"}
              </Text>
            </View>

            {rows.length === 0 ? (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No realized gains in this range.
              </Text>
            ) : (
              rows.map((r) => {
                const g = rowGain(r);
                return (
                  <View
                    key={r.closureId}
                    style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={styles.rowTop}>
                      <Text style={[styles.rowSym, { color: colors.foreground }]} numberOfLines={1}>
                        {safeName(r.holdingName, "Holding")}
                      </Text>
                      <Text
                        style={[styles.rowGain, { color: g >= 0 ? colors.pos : colors.neg }]}
                      >
                        {g >= 0 ? "+" : ""}
                        {formatCurrency(g, base ? displayCurrency : r.currency, { decimals: 0 })}
                      </Text>
                    </View>
                    <Text style={[styles.rowMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {formatShortDate(r.closeDate)} · {r.qtyClosed}u · {r.costPerShare} →{" "}
                      {r.proceedsPerShare}
                    </Text>
                    <View style={styles.badges}>
                      <Badge
                        label={`${r.term === "short" ? "Short" : "Long"} · ${r.daysHeld}d`}
                        bg={colors.secondary}
                        fg={colors.mutedForeground}
                      />
                      {r.closeKind.startsWith("short") && (
                        <Badge label="Short" bg={colors.neg + "22"} fg={colors.neg} />
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? colors.primary : colors.secondary,
          borderColor: active ? colors.primary : colors.border,
        },
      ]}
    >
      <Text style={{ color: active ? colors.primaryForeground : colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function Badge({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
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
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleTitle: { fontSize: 14, fontWeight: "600" },
  toggleSub: { fontSize: 12, marginTop: 2 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardHint: { fontSize: 12, marginTop: 4 },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 8 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowSym: { fontSize: 15, fontWeight: "700", flex: 1, marginRight: 10 },
  rowGain: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rowMeta: { fontSize: 12, marginTop: 3 },
  badges: { flexDirection: "row", gap: 6, marginTop: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  empty: { fontSize: 14, textAlign: "center", paddingVertical: 32 },
});

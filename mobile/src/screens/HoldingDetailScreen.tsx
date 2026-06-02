// Holding drill-down: aggregated header + per-account rows + open lots + a
// transaction list, with Buy/Sell shortcuts. `members` are the per-account
// EnrichedHolding rows that the overview pooled into this byHolding summary.
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName, formatShortDate } from "../lib/format";
import { Icon } from "../components/icon";
import type { LotRow, Transaction } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "HoldingDetail">;

function gainTone(colors: ReturnType<typeof useTheme>["colors"], v: number) {
  return v > 0 ? colors.pos : v < 0 ? colors.neg : colors.foreground;
}

export default function HoldingDetailScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { summary, members, displayCurrency } = route.params;
  const [lots, setLots] = useState<LotRow[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  const accountNameById = new Map<number, string>();
  for (const m of members) {
    if (m.accountId != null) accountNameById.set(m.accountId, m.accountName);
  }
  // The first member's (account, holding) anchors the Buy/Sell shortcuts.
  const primary = members[0];
  const isCash = summary.assetType === "cash";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      members.flatMap((m) => [
        endpoints.getPortfolioLots(m.id, m.accountId ?? undefined),
        endpoints.getTransactions(`portfolioHoldingId=${m.id}&sort=date&sortDir=desc&limit=50`),
      ])
    )
      .then((results) => {
        if (cancelled) return;
        const allLots: LotRow[] = [];
        const allTx: Transaction[] = [];
        results.forEach((res, i) => {
          if (i % 2 === 0) {
            // lots result
            if (res.success && res.data && "lots" in res.data) {
              allLots.push(...(res.data as { lots: LotRow[] }).lots);
            }
          } else if (res.success && Array.isArray(res.data)) {
            allTx.push(...(res.data as Transaction[]));
          }
        });
        allTx.sort((a, b) => (a.date < b.date ? 1 : -1));
        setLots(allLots);
        setTxns(allTx);
      })
      .catch((e) => logger.error("holding-detail", "load threw", { detail: String(e) }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [members]);

  const mv = summary.marketValueDisplay;
  const unreal = summary.unrealizedGainDisplay;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Portfolio</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {safeName(summary.symbol || summary.name, "—")}
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
          {safeName(summary.name)} · {summary.assetType}
          {primary ? ` · ${primary.currency}` : ""}
        </Text>

        {/* Market value card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>Market value</Text>
          <Text style={[styles.cardValue, { color: colors.foreground }]}>
            {formatCurrency(mv, displayCurrency, { decimals: 0 })}
          </Text>
          <Text style={[styles.cardSub, { color: gainTone(colors, unreal) }]}>
            {unreal >= 0 ? "+" : ""}
            {formatCurrency(unreal, displayCurrency, { decimals: 0 })}
            {summary.unrealizedGainPct != null
              ? ` · ${summary.unrealizedGainPct >= 0 ? "+" : ""}${summary.unrealizedGainPct.toFixed(1)}%`
              : ""}
          </Text>
          <View style={styles.kvBlock}>
            <KV
              k={`${summary.totalQty} units @ avg cost`}
              v={summary.avgCostDisplay != null ? formatCurrency(summary.avgCostDisplay, displayCurrency) : "—"}
            />
            <KV k="Cost basis" v={formatCurrency(summary.costBasisDisplay, displayCurrency, { decimals: 0 })} />
            <KV
              k="Realized G/L"
              v={`${summary.realizedGainDisplay >= 0 ? "+" : ""}${formatCurrency(summary.realizedGainDisplay, displayCurrency, { decimals: 0 })}`}
              tone={gainTone(colors, summary.realizedGainDisplay)}
            />
            <KV k="Dividends" v={formatCurrency(summary.dividendsDisplay, displayCurrency, { decimals: 0 })} />
          </View>
        </View>

        {/* By account */}
        <Text style={[styles.section, { color: colors.mutedForeground }]}>By account</Text>
        <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {members.map((m) => (
            <View key={m.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
              <View style={styles.listMain}>
                <Text style={[styles.listTitle, { color: colors.foreground }]} numberOfLines={1}>
                  {safeName(m.accountName)} · {m.currency}
                </Text>
                <Text style={[styles.listSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {m.firstPurchaseDate ? `first buy ${m.firstPurchaseDate}` : "—"}
                  {m.daysHeld != null ? ` · ${m.daysHeld}d held` : ""}
                </Text>
              </View>
              <View style={styles.listRight}>
                <Text style={[styles.listAmt, { color: colors.foreground }]}>
                  {formatCurrency(m.marketValueDisplay ?? 0, displayCurrency, { decimals: 0 })}
                </Text>
                <Text style={[styles.listMeta, { color: colors.mutedForeground }]}>
                  {m.quantity ?? 0} units
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* Open lots */}
        {!isCash && (
          <>
            <Text style={[styles.section, { color: colors.mutedForeground }]}>Open lots</Text>
            <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {loading ? (
                <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.primary} />
              ) : lots.length === 0 ? (
                <Text style={[styles.emptyInline, { color: colors.mutedForeground }]}>No open lots</Text>
              ) : (
                lots.map((l) => (
                  <View key={l.lotId} style={[styles.listRow, { borderBottomColor: colors.border }]}>
                    <View style={styles.listMain}>
                      <Text style={[styles.listTitle, { color: colors.foreground }]}>
                        {formatShortDate(l.openDate)}
                      </Text>
                      <Text style={[styles.listSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {safeName(accountNameById.get(l.accountId), "—")} · {l.qtyRemaining} units
                      </Text>
                    </View>
                    <Text style={[styles.listAmt, { color: colors.foreground }]}>
                      @ {l.costPerShare} {l.currency}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}

        {/* Transactions */}
        <Text style={[styles.section, { color: colors.mutedForeground }]}>Transactions</Text>
        <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {loading ? (
            <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.primary} />
          ) : txns.length === 0 ? (
            <Text style={[styles.emptyInline, { color: colors.mutedForeground }]}>No transactions</Text>
          ) : (
            txns.slice(0, 25).map((t) => (
              <View key={t.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
                <View style={styles.listMain}>
                  <Text style={[styles.listTitle, { color: colors.foreground }]} numberOfLines={1}>
                    {safeName(t.payee || t.note, "Transaction")}
                  </Text>
                  <Text style={[styles.listSub, { color: colors.mutedForeground }]}>
                    {formatShortDate(t.date)}
                  </Text>
                </View>
                <View style={styles.listRight}>
                  <Text style={[styles.listAmt, { color: colors.foreground }]}>
                    {formatCurrency(t.amount, t.currency, { decimals: 0 })}
                  </Text>
                  {t.quantity != null && t.quantity !== 0 && (
                    <Text style={[styles.listMeta, { color: colors.mutedForeground }]}>
                      {t.quantity > 0 ? "+" : ""}
                      {t.quantity}u
                    </Text>
                  )}
                </View>
              </View>
            ))
          )}
        </View>

        {/* Buy / Sell shortcuts */}
        {!isCash && primary && primary.accountId != null && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.primary }]}
              onPress={() =>
                navigation.navigate("OperationForm", {
                  op: "buy",
                  preselectAccountId: primary.accountId!,
                  preselectHoldingId: primary.id,
                })
              }
            >
              <Text style={[styles.actionText, { color: colors.primaryForeground }]}>+ Buy</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.secondary }]}
              onPress={() =>
                navigation.navigate("OperationForm", {
                  op: "sell",
                  preselectAccountId: primary.accountId!,
                  preselectHoldingId: primary.id,
                })
              }
            >
              <Text style={[styles.actionText, { color: colors.foreground }]}>− Sell</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.kvRow}>
      <Text style={[styles.kvKey, { color: colors.mutedForeground }]} numberOfLines={1}>
        {k}
      </Text>
      <Text style={[styles.kvVal, { color: tone ?? colors.foreground }]}>{v}</Text>
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
  title: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  scroll: { padding: 16, paddingBottom: 32 },
  subtitle: { fontSize: 13, marginBottom: 12 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardSub: { fontSize: 14, fontWeight: "700", marginTop: 4, fontVariant: ["tabular-nums"] },
  kvBlock: { marginTop: 12 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  kvKey: { fontSize: 13, flex: 1, marginRight: 12 },
  kvVal: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  section: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 6, marginTop: 4 },
  listCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listMain: { flex: 1, marginRight: 10 },
  listTitle: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  listSub: { fontSize: 12, marginTop: 2 },
  listRight: { alignItems: "flex-end" },
  listAmt: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  listMeta: { fontSize: 12, marginTop: 2 },
  emptyInline: { fontSize: 13, textAlign: "center", paddingVertical: 16 },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  actionBtn: { flex: 1, paddingVertical: 13, borderRadius: 10, alignItems: "center" },
  actionText: { fontSize: 15, fontWeight: "700" },
});

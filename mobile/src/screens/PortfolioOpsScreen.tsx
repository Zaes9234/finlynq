// 8-tile "New operation" chooser (modal). Each tile routes to the single
// OperationFormScreen with its op key. Tiles + order come from the registry.
import React from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { Icon } from "../components/icon";
import { OP_ORDER, OP_CONFIGS } from "../lib/portfolio/operations";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "PortfolioOps">;

export default function PortfolioOpsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={[styles.cancel, { color: colors.primary }]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>New operation</Text>
        <View style={{ width: 52 }} />
      </View>
      <ScrollView contentContainerStyle={styles.grid}>
        {OP_ORDER.map((op) => {
          const cfg = OP_CONFIGS[op];
          return (
            <TouchableOpacity
              key={op}
              style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => navigation.navigate("OperationForm", { op })}
            >
              <View style={[styles.iconWrap, { backgroundColor: colors.primary + "24" }]}>
                <Icon name={cfg.icon} size={20} color={colors.primary} />
              </View>
              <Text style={[styles.tileLabel, { color: colors.foreground }]} numberOfLines={1}>
                {cfg.title}
              </Text>
              <Text style={[styles.tileSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                {cfg.subtitle}
              </Text>
            </TouchableOpacity>
          );
        })}
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cancel: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    padding: 16,
  },
  tile: {
    width: "48.5%",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 18,
    paddingHorizontal: 12,
    alignItems: "center",
    marginBottom: 12,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  tileLabel: { fontSize: 14, fontWeight: "700", textAlign: "center" },
  tileSub: { fontSize: 11, marginTop: 2, textAlign: "center" },
});

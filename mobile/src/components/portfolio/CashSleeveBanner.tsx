// Amber prerequisite banner — buy/sell/fx/income hard-fail without a matching
// (account, currency) cash sleeve. One tap provisions it (409-dup treated as
// success by the caller). Shown both proactively (client precheck) and
// reactively (server `cash_sleeve_not_found`).
import React from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useTheme } from "../../theme";

export function CashSleeveBanner({
  currency,
  creating,
  onCreate,
}: {
  currency: string;
  creating: boolean;
  onCreate: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: colors.primary + "1A", borderColor: colors.primary + "59" },
      ]}
    >
      <Text style={[styles.text, { color: colors.foreground }]}>
        No <Text style={styles.bold}>{currency}</Text> cash sleeve in this account. Buys, sells
        and conversions debit/credit it.
      </Text>
      <TouchableOpacity
        style={[styles.btn, { backgroundColor: colors.primary }]}
        onPress={onCreate}
        disabled={creating}
      >
        {creating ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <Text style={[styles.btnText, { color: colors.primaryForeground }]}>
            Create {currency} cash sleeve
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 12,
  },
  text: { fontSize: 13, lineHeight: 18 },
  bold: { fontWeight: "800" },
  btn: {
    marginTop: 10,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
  },
  btnText: { fontSize: 14, fontWeight: "700" },
});

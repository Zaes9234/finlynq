// Coral "edit blocked" notice — the server refused an edit (code
// portfolio_edit_blocked) because the row opens a lot that has downstream
// closures. Each blocking tx id is a tappable row that deep-links into the
// Transactions tab filtered to that id. No auto-retry (mirrors web).
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../../theme";

export function BlockingClosuresNotice({
  txIds,
  onPressTx,
}: {
  txIds: number[];
  onPressTx: (id: number) => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.notice,
        { backgroundColor: colors.destructive + "17", borderColor: colors.destructive + "59" },
      ]}
    >
      <Text style={[styles.title, { color: colors.foreground }]}>
        Edit blocked — delete these dependent transactions first:
      </Text>
      {txIds.map((id) => (
        <TouchableOpacity key={id} onPress={() => onPressTx(id)} style={styles.row}>
          <Text style={[styles.link, { color: colors.primary }]}>› Transaction #{id}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 12,
  },
  title: { fontSize: 13, lineHeight: 18, marginBottom: 6 },
  row: { paddingVertical: 4 },
  link: { fontSize: 14, fontWeight: "600" },
});

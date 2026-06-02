// Per-lot quantity picker for the Sell flow. Parent owns the
// `selection: {lotId, qty}[]`; the Sell form auto-computes "quantity to sell"
// as the sum. Toggle a lot on → defaults its qty to qtyRemaining; the qty box
// lets the user sell a partial lot. Selecting beyond long inventory is allowed
// server-side (opens a short for the overflow) — surfaced as a hint here.
import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Pressable,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { formatShortDate } from "../../lib/format";
import type { LotRow } from "../../../../shared/types";

export interface LotPick {
  lotId: number;
  qty: number;
}

export function LotPickerSheet({
  visible,
  lots,
  selection,
  currency,
  onChange,
  onClose,
}: {
  visible: boolean;
  lots: LotRow[];
  selection: LotPick[];
  currency: string;
  onChange: (sel: LotPick[]) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [local, setLocal] = useState<LotPick[]>(selection);

  useEffect(() => {
    if (visible) setLocal(selection);
  }, [visible, selection]);

  const picked = (lotId: number) => local.find((l) => l.lotId === lotId);
  const selectedQty = local.reduce((s, l) => s + (Number.isFinite(l.qty) ? l.qty : 0), 0);

  const toggle = (lot: LotRow) => {
    const existing = picked(lot.lotId);
    if (existing) setLocal(local.filter((l) => l.lotId !== lot.lotId));
    else setLocal([...local, { lotId: lot.lotId, qty: lot.qtyRemaining }]);
  };

  const setQty = (lotId: number, text: string) => {
    const v = parseFloat(text);
    setLocal(local.map((l) => (l.lotId === lotId ? { ...l, qty: Number.isFinite(v) ? v : 0 } : l)));
  };

  const commit = () => {
    onChange(local.filter((l) => l.qty > 0));
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: colors.card, borderColor: colors.border, paddingTop: insets.top + 12 },
          ]}
          onPress={() => {}}
        >
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.foreground }]}>Select lots to sell</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Icon name="close" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <FlatList
            data={lots}
            keyExtractor={(l) => String(l.lotId)}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            renderItem={({ item }) => {
              const p = picked(item.lotId);
              const on = !!p;
              return (
                <View style={[styles.row, { borderBottomColor: colors.border }]}>
                  <TouchableOpacity onPress={() => toggle(item)} style={styles.cboxTap}>
                    <View
                      style={[
                        styles.cbox,
                        {
                          borderColor: on ? colors.primary : colors.border,
                          backgroundColor: on ? colors.primary : "transparent",
                        },
                      ]}
                    >
                      {on && <Icon name="check" size={13} color={colors.primaryForeground} />}
                    </View>
                  </TouchableOpacity>
                  <View style={styles.info}>
                    <Text style={[styles.lotDate, { color: colors.foreground }]}>
                      {formatShortDate(item.openDate)}
                    </Text>
                    <Text style={[styles.lotMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {item.qtyRemaining} units · @ {item.costPerShare} {item.currency || currency}
                      {item.status === "open" ? "" : ` · ${item.status}`}
                    </Text>
                  </View>
                  {on && (
                    <TextInput
                      style={[
                        styles.qtyInput,
                        { color: colors.foreground, borderColor: colors.input },
                      ]}
                      value={String(p!.qty)}
                      onChangeText={(t) => setQty(item.lotId, t)}
                      keyboardType="decimal-pad"
                    />
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                No open lots — FIFO will be used.
              </Text>
            }
          />

          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            <Text style={[styles.selected, { color: colors.mutedForeground }]}>
              Selected: <Text style={{ color: colors.foreground, fontWeight: "700" }}>{selectedQty}</Text> units
            </Text>
            <TouchableOpacity
              style={[styles.doneBtn, { backgroundColor: colors.primary }]}
              onPress={commit}
            >
              <Text style={[styles.doneText, { color: colors.primaryForeground }]}>Done</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-start" },
  sheet: {
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingBottom: 16,
    maxHeight: "75%",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: { fontSize: 17, fontWeight: "700" },
  list: { flexGrow: 0, flexShrink: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cboxTap: { paddingRight: 10 },
  cbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  info: { flex: 1, marginRight: 10 },
  lotDate: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  lotMeta: { fontSize: 12, marginTop: 2 },
  qtyInput: {
    minWidth: 58,
    height: 36,
    borderWidth: 1,
    borderRadius: 7,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
    paddingVertical: 0,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  selected: { fontSize: 14 },
  doneBtn: { paddingHorizontal: 22, paddingVertical: 9, borderRadius: 8 },
  doneText: { fontSize: 15, fontWeight: "700" },
  empty: { fontSize: 13, textAlign: "center", paddingVertical: 20 },
});

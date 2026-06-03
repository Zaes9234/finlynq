// Reusable searchable picker. Opens as a bottom sheet with a search box + a
// scrollable list — replaces the horizontal chip rows that don't scale once a
// user has many accounts or categories. Tapping a row selects it and closes.
import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { Icon } from "./icon";

export interface PickerOption {
  id: number;
  label: string;
  sublabel?: string;
}

interface PickerSheetProps {
  visible: boolean;
  title: string;
  options: PickerOption[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClose: () => void;
}

export function PickerSheet({
  visible,
  title,
  options,
  selectedId,
  onSelect,
  onClose,
}: PickerSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");

  // Reset the search each time the sheet opens so a stale filter doesn't hide
  // everything on the next open.
  useEffect(() => {
    if (visible) setQuery("");
  }, [visible]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q))
    : options;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      {/* Tap the dimmed backdrop to dismiss. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop touches inside the sheet from bubbling to the backdrop.
            Anchored at the TOP so the search box + results sit above the
            on-screen keyboard (which rises from the bottom) — otherwise the
            filtered results render behind the keyboard. */}
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: colors.card, borderColor: colors.border, paddingTop: insets.top + 12 },
          ]}
          onPress={() => {}}
        >
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Icon name="close" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <View
            style={[
              styles.searchWrap,
              { backgroundColor: colors.secondary, borderColor: colors.border },
            ]}
          >
            <Icon name="search" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.searchInput, { color: colors.foreground }]}
              value={query}
              onChangeText={setQuery}
              placeholder="Search…"
              placeholderTextColor={colors.mutedForeground}
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(item) => String(item.id)}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            renderItem={({ item }) => {
              const active = item.id === selectedId;
              return (
                <TouchableOpacity
                  style={[styles.row, { borderBottomColor: colors.border }]}
                  onPress={() => {
                    onSelect(item.id);
                    onClose();
                  }}
                >
                  <View style={styles.rowText}>
                    <Text
                      style={[styles.rowLabel, { color: active ? colors.primary : colors.foreground }]}
                      numberOfLines={1}
                    >
                      {item.label}
                    </Text>
                    {item.sublabel ? (
                      <Text style={[styles.rowSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {item.sublabel}
                      </Text>
                    ) : null}
                  </View>
                  {active && <Icon name="check" size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>No matches</Text>
            }
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-start",
  },
  sheet: {
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingBottom: 16,
    maxHeight: "65%",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  title: { fontSize: 17, fontWeight: "700" },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
    marginBottom: 8,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  // flexShrink lets the list scroll inside the capped sheet when results are
  // long; flexGrow 0 keeps the sheet hugging its content when results are few.
  list: { flexGrow: 0, flexShrink: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, marginRight: 12 },
  rowLabel: { fontSize: 15, fontWeight: "500" },
  rowSub: { fontSize: 12, marginTop: 2 },
  empty: { textAlign: "center", paddingVertical: 24, fontSize: 14 },
});

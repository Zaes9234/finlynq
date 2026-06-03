// First-run prompt offering to seed sample data. Shown once after a fresh
// register / first sign-in of an un-onboarded account (gated in useAuth via an
// AsyncStorage flag). Reuses the same /api/onboarding/sample-data endpoint the
// More tab's "Load sample data" row calls.
import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";

interface OnboardingPromptProps {
  visible: boolean;
  onDismiss: () => void;
}

export function OnboardingPrompt({ visible, onDismiss }: OnboardingPromptProps) {
  const { colors } = useTheme();
  const [loading, setLoading] = useState(false);

  const loadSample = async () => {
    setLoading(true);
    try {
      const res = await endpoints.loadSampleData();
      if (res.success) {
        // The route returns `{ success, transactionsCreated }` (no `.data`
        // wrapper) — read the count off the top level.
        const created =
          (res as unknown as { transactionsCreated?: number }).transactionsCreated ?? 0;
        logger.info("onboarding", "sample data loaded", { created });
        onDismiss();
        Alert.alert(
          "Sample data added",
          "Added starter accounts, categories" +
            (created > 0 ? ` and ${created} sample transactions` : "") +
            ". Explore the app, then delete them anytime from Settings."
        );
      } else {
        logger.warn("onboarding", "sample data rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to load sample data");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("onboarding", "sample data threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>Welcome to Finlynq</Text>
          <Text style={[styles.desc, { color: colors.mutedForeground }]}>
            Want to start with some sample accounts, categories and transactions so
            you can explore the app right away? You can delete them anytime.
          </Text>

          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            onPress={loadSample}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>
                Load sample data
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.skipBtn} onPress={onDismiss} disabled={loading}>
            <Text style={[styles.skipText, { color: colors.mutedForeground }]}>
              Start empty
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
  },
  title: { fontSize: 20, fontWeight: "800", marginBottom: 10 },
  desc: { fontSize: 14, lineHeight: 21, marginBottom: 20 },
  primaryBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { fontSize: 15, fontWeight: "700" },
  skipBtn: { height: 44, alignItems: "center", justifyContent: "center", marginTop: 6 },
  skipText: { fontSize: 14, fontWeight: "600" },
});

import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AmexAnchor,
  getGetAmexAnchorQueryKey,
  useDeleteAmexAnchor,
  useGetAmexAnchor,
  useSetAmexAnchor,
} from "@workspace/api-client-react";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDateTime, todayISO } from "@/lib/format";

const SOURCE_LABEL: Record<AmexAnchor["source"], string> = {
  debt: "Debt account",
  anchor: "Manual anchor",
  computed: "Computed from txns",
  missing: "No data",
};

const SOURCE_HINT: Record<AmexAnchor["source"], string> = {
  debt: "Pulled from your linked Amex debt account.",
  anchor: "You set this anchor manually. New Amex transactions accrue against it.",
  computed: "Estimated from recent Amex transactions only.",
  missing: "No Amex balance has been recorded yet.",
};

export default function AmexScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch, isRefetching } =
    useGetAmexAnchor();
  const setAnchor = useSetAmexAnchor();
  const deleteAnchor = useDeleteAmexAnchor();

  const [editing, setEditing] = useState(false);
  const [balanceInput, setBalanceInput] = useState("");
  const [asOfInput, setAsOfInput] = useState(todayISO());
  const [submitError, setSubmitError] = useState<string | null>(null);

  const openEditor = () => {
    const initial =
      data?.amexEndingBalance != null ? Math.abs(data.amexEndingBalance) : 0;
    setBalanceInput(initial > 0 ? initial.toFixed(2) : "");
    setAsOfInput(todayISO());
    setSubmitError(null);
    setEditing(true);
  };

  const submitAnchor = async () => {
    setSubmitError(null);
    const parsed = Number(balanceInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setSubmitError("Enter a non-negative number (Amex balance owed).");
      return;
    }
    try {
      await setAnchor.mutateAsync({
        data: {
          // Amex balance is stored as a negative liability (debt).
          balance: -Math.abs(parsed),
          asOf: asOfInput || null,
        },
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await queryClient.invalidateQueries({
        queryKey: getGetAmexAnchorQueryKey(),
      });
      setEditing(false);
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSubmitError(
        err instanceof Error ? err.message : "Couldn't save anchor",
      );
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      "Clear anchor",
      "Remove the manual Amex anchor? Balance will fall back to the next available source.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteAnchor.mutateAsync(undefined as never);
              await Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Success,
              );
              await queryClient.invalidateQueries({
                queryKey: getGetAmexAnchorQueryKey(),
              });
            } catch (err) {
              Alert.alert(
                "Couldn't clear anchor",
                err instanceof Error ? err.message : "Unknown error",
              );
            }
          },
        },
      ],
    );
  };

  const balance = data?.amexEndingBalance;
  const owedDisplay =
    balance == null ? "—" : formatCurrency(Math.abs(balance));

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.primary}
          />
        }
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Amex</Text>

        {isLoading ? (
          <View style={{ paddingTop: 60, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : isError ? (
          <View style={{ paddingTop: 60, alignItems: "center" }}>
            <Text style={{ color: colors.destructive, fontWeight: "600" }}>
              Couldn't load Amex balance
            </Text>
            <Text
              style={{
                color: colors.mutedForeground,
                marginTop: 6,
                textAlign: "center",
              }}
            >
              {error instanceof Error ? error.message : "Unknown error"}
            </Text>
            <Pressable
              onPress={() => refetch()}
              style={({ pressed }) => [
                styles.retryButton,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text
                style={{ color: colors.primaryForeground, fontWeight: "600" }}
              >
                Retry
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View
              style={[
                styles.balanceCard,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text
                style={[styles.balanceLabel, { color: colors.mutedForeground }]}
              >
                Current balance owed
              </Text>
              <Text style={[styles.balanceValue, { color: colors.foreground }]}>
                {owedDisplay}
              </Text>

              {data && (
                <View style={styles.chipRow}>
                  <View
                    style={[
                      styles.chip,
                      {
                        backgroundColor: colors.accent,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <Feather
                      name={
                        data.source === "anchor"
                          ? "anchor"
                          : data.source === "debt"
                            ? "credit-card"
                            : data.source === "computed"
                              ? "activity"
                              : "alert-circle"
                      }
                      size={12}
                      color={colors.accentForeground}
                    />
                    <Text
                      style={[styles.chipText, { color: colors.accentForeground }]}
                    >
                      {SOURCE_LABEL[data.source]}
                    </Text>
                  </View>
                </View>
              )}
              {data && (
                <Text
                  style={[styles.asOf, { color: colors.mutedForeground }]}
                >
                  As of {formatDateTime(data.asOf)}
                </Text>
              )}
              {data && (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  {SOURCE_HINT[data.source]}
                </Text>
              )}
            </View>

            <Pressable
              onPress={openEditor}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Feather name="edit-3" size={16} color={colors.primaryForeground} />
              <Text
                style={[
                  styles.primaryButtonText,
                  { color: colors.primaryForeground },
                ]}
              >
                {data?.source === "anchor" ? "Update anchor" : "Set anchor"}
              </Text>
            </Pressable>

            {data?.source === "anchor" && (
              <Pressable
                onPress={confirmDelete}
                disabled={deleteAnchor.isPending}
                style={({ pressed }) => [
                  styles.ghostButton,
                  {
                    borderColor: colors.border,
                    opacity: deleteAnchor.isPending
                      ? 0.5
                      : pressed
                        ? 0.85
                        : 1,
                  },
                ]}
              >
                <Text
                  style={{
                    color: colors.destructive,
                    fontFamily: "Inter_600SemiBold",
                  }}
                >
                  Clear manual anchor
                </Text>
              </Pressable>
            )}
          </>
        )}
      </ScrollView>

      <Modal
        visible={editing}
        transparent
        animationType="slide"
        onRequestClose={() => setEditing(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalScrim}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setEditing(false)}
          />
          <View
            style={[
              styles.modalCard,
              { backgroundColor: colors.background },
            ]}
          >
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Update Amex anchor
            </Text>
            <Text
              style={[styles.modalHint, { color: colors.mutedForeground }]}
            >
              Enter the current balance owed (positive number).
            </Text>

            <Text style={[styles.label, { color: colors.foreground }]}>
              Balance owed
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.foreground,
                  borderColor: colors.border,
                },
              ]}
              keyboardType="decimal-pad"
              value={balanceInput}
              onChangeText={setBalanceInput}
              placeholder="0.00"
              placeholderTextColor={colors.mutedForeground}
              autoFocus
            />

            <Text
              style={[
                styles.label,
                { color: colors.foreground, marginTop: 12 },
              ]}
            >
              As of (YYYY-MM-DD)
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.foreground,
                  borderColor: colors.border,
                },
              ]}
              autoCapitalize="none"
              autoCorrect={false}
              value={asOfInput}
              onChangeText={setAsOfInput}
              placeholder={todayISO()}
              placeholderTextColor={colors.mutedForeground}
            />

            {submitError && (
              <Text style={[styles.error, { color: colors.destructive }]}>
                {submitError}
              </Text>
            )}

            <View style={styles.modalButtons}>
              <Pressable
                onPress={() => setEditing(false)}
                style={({ pressed }) => [
                  styles.modalGhost,
                  {
                    borderColor: colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={submitAnchor}
                disabled={setAnchor.isPending}
                style={({ pressed }) => [
                  styles.modalPrimary,
                  {
                    backgroundColor: colors.primary,
                    opacity: setAnchor.isPending
                      ? 0.5
                      : pressed
                        ? 0.85
                        : 1,
                  },
                ]}
              >
                {setAnchor.isPending ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text
                    style={{
                      color: colors.primaryForeground,
                      fontWeight: "600",
                    }}
                  >
                    Save anchor
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  h1: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    marginBottom: 16,
  },
  balanceCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
    marginBottom: 16,
  },
  balanceLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  balanceValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 40,
    fontVariant: ["tabular-nums"],
  },
  chipRow: {
    flexDirection: "row",
    marginTop: 14,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  asOf: {
    marginTop: 12,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  hint: {
    marginTop: 8,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  primaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  ghostButton: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  modalScrim: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  modalCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 36,
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
    marginBottom: 4,
  },
  modalHint: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginBottom: 16,
  },
  label: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
  },
  error: {
    marginTop: 8,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  modalButtons: {
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
  },
  modalGhost: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  modalPrimary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
});

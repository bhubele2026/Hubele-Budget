import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ForecastBundle,
  type ForecastEvent,
  type ForecastResolution,
  type ForecastResolutionInput,
  type Transaction,
  getGetForecastQueryKey,
  useGetForecast,
  useUpsertForecastResolution,
} from "@workspace/api-client-react";
import * as Haptics from "expo-haptics";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDayShort, todayISO } from "@/lib/format";
import {
  type BankLine,
  buildLineRegister,
  filterForecastTxns,
  type PlanSuggestion,
  suggestPlanMatchesForBank,
} from "@/lib/forecastMatch";

type Pending = BankLine & { suggestions: PlanSuggestion[] };

function buildPending(bundle: ForecastBundle): Pending[] {
  const checkingIds = new Set<string>();
  for (const a of bundle.plaidCheckingAccounts ?? []) {
    if (a.accountId) checkingIds.add(a.accountId);
  }
  const txns = filterForecastTxns<Transaction>(
    bundle.transactions ?? [],
    checkingIds,
  );
  const events = (bundle.events ?? []).map((e: ForecastEvent) => ({
    date: e.date,
    itemId: e.itemId,
    label: e.label,
    kind: (e.kind === "income" ? "income" : "expense") as
      | "income"
      | "expense",
    amount: e.amount,
  }));
  const resolutions = (bundle.resolutions ?? []).map(
    (r: ForecastResolution) => ({
      id: r.id,
      recurringItemId: r.recurringItemId ?? null,
      occurrenceDate: r.occurrenceDate ?? null,
      status: r.status,
      matchedTxnId: r.matchedTxnId ?? null,
      rescheduledTo: r.rescheduledTo,
      txnDate: r.txnDate,
      txnDescription: r.txnDescription,
      txnAmount: r.txnAmount,
      txnForecastFlag: r.txnForecastFlag,
    }),
  );
  const closed = new Set(bundle.closedMonths ?? []);
  const startBalance = Number(bundle.bankSnapshot?.balance ?? 0) || 0;
  const today = todayISO();
  const { rows, allPlan } = buildLineRegister({
    events,
    txns: txns.map((t) => ({
      id: t.id,
      occurredOn: t.occurredOn,
      description: t.description,
      amount: t.amount,
      forecastFlag: t.forecastFlag,
      categoryId: t.categoryId ?? undefined,
      source: t.source ?? undefined,
      plaidAccountId: t.plaidAccountId ?? undefined,
    })),
    resolutions,
    closedMonths: closed,
    startBalance,
    fromISO: bundle.fromDate,
    toISO: bundle.toDate,
    snapshotISO: bundle.bankSnapshot?.at?.slice(0, 10) ?? null,
  });
  const banks = rows.filter(
    (r): r is Pending =>
      r.kind === "bank" && (r as BankLine).status === "pending_bank",
  );
  // Stable order: oldest first so the user clears chronologically.
  banks.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return banks.map((b) => ({
    ...b,
    suggestions: suggestPlanMatchesForBank(b, allPlan, { limit: 3 }),
    date: b.date,
  })).slice(0, 200);
}

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "#15803d",
  medium: "#ca8a04",
  low: "#64748b",
};

export default function ReconcileScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch, isRefetching } =
    useGetForecast({ days: 60 });
  const upsert = useUpsertForecastResolution();

  const [reschedTarget, setReschedTarget] = useState<Pending | null>(null);
  const [reschedDate, setReschedDate] = useState("");
  const [reschedError, setReschedError] = useState<string | null>(null);

  const pending = useMemo(() => (data ? buildPending(data) : []), [data]);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetForecastQueryKey({ days: 60 }),
    });

  const submit = async (
    body: ForecastResolutionInput,
    onError: (msg: string) => void,
  ) => {
    try {
      await upsert.mutateAsync({ data: body });
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      );
      await invalidate();
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      onError(err instanceof Error ? err.message : "Couldn't save");
    }
  };

  const handleMatch = (b: Pending, sug: PlanSuggestion) =>
    submit(
      {
        recurringItemId: sug.plan.itemId,
        occurrenceDate: sug.plan.date,
        status: "matched",
        matchedTxnId: b.txn.id,
      },
      (msg) => Alert.alert("Match failed", msg),
    );

  const handleSkip = (b: Pending) =>
    submit(
      {
        status: "ignored_unforecasted",
        matchedTxnId: b.txn.id,
      },
      (msg) => Alert.alert("Skip failed", msg),
    );

  const openReschedule = (b: Pending) => {
    if (b.suggestions.length === 0) {
      Alert.alert(
        "No plan to reschedule",
        "Reschedule moves a planned occurrence to this transaction's date. There are no candidate plans within range.",
      );
      return;
    }
    setReschedTarget(b);
    setReschedDate(b.txn.occurredOn);
    setReschedError(null);
  };

  const submitReschedule = async () => {
    if (!reschedTarget) return;
    const sug = reschedTarget.suggestions[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reschedDate)) {
      setReschedError("Use YYYY-MM-DD format");
      return;
    }
    try {
      await upsert.mutateAsync({
        data: {
          recurringItemId: sug.plan.itemId,
          occurrenceDate: sug.plan.date,
          status: "rescheduled",
          rescheduledTo: reschedDate,
        },
      });
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      );
      await invalidate();
      setReschedTarget(null);
    } catch (err) {
      setReschedError(err instanceof Error ? err.message : "Couldn't save");
    }
  };

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.h1, { color: colors.foreground }]}>Reconcile</Text>
          <Text style={[styles.sub, { color: colors.mutedForeground }]}>
            {pending.length === 0
              ? "Inbox clear"
              : `${pending.length} pending bank ${
                  pending.length === 1 ? "transaction" : "transactions"
                }`}
          </Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive, fontWeight: "600" }}>
            Couldn't load forecast
          </Text>
          <Text
            style={{
              color: colors.mutedForeground,
              marginTop: 6,
              paddingHorizontal: 24,
              textAlign: "center",
            }}
          >
            {error instanceof Error ? error.message : "Unknown error"}
          </Text>
          <Pressable
            onPress={() => refetch()}
            style={({ pressed }) => [
              styles.retryButton,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={{ color: colors.primaryForeground, fontWeight: "600" }}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={pending}
          keyExtractor={(p) => p.txn.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather
                name="check-circle"
                size={48}
                color={colors.success}
              />
              <Text
                style={{
                  color: colors.foreground,
                  marginTop: 12,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 16,
                }}
              >
                Inbox clear
              </Text>
              <Text
                style={{
                  color: colors.mutedForeground,
                  marginTop: 4,
                  textAlign: "center",
                }}
              >
                All bank transactions are matched or skipped.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <PendingCard
              item={item}
              onMatch={(sug) => handleMatch(item, sug)}
              onSkip={() => handleSkip(item)}
              onReschedule={() => openReschedule(item)}
              busy={upsert.isPending}
            />
          )}
        />
      )}

      <Modal
        visible={!!reschedTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setReschedTarget(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalScrim}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setReschedTarget(null)}
          />
          {reschedTarget && (
            <View
              style={[
                styles.modalCard,
                { backgroundColor: colors.background },
              ]}
            >
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                Reschedule
              </Text>
              <Text
                style={[styles.modalHint, { color: colors.mutedForeground }]}
              >
                Move planned "{reschedTarget.suggestions[0]?.plan.label}" from{" "}
                {reschedTarget.suggestions[0]?.plan.date} to a new date.
              </Text>
              <Text style={[styles.label, { color: colors.foreground }]}>
                New date (YYYY-MM-DD)
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
                value={reschedDate}
                onChangeText={setReschedDate}
                placeholder="2026-05-15"
                placeholderTextColor={colors.mutedForeground}
              />
              {reschedError && (
                <Text style={[styles.error, { color: colors.destructive }]}>
                  {reschedError}
                </Text>
              )}
              <View style={styles.modalButtons}>
                <Pressable
                  onPress={() => setReschedTarget(null)}
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
                  onPress={submitReschedule}
                  disabled={upsert.isPending}
                  style={({ pressed }) => [
                    styles.modalPrimary,
                    {
                      backgroundColor: colors.primary,
                      opacity: upsert.isPending
                        ? 0.5
                        : pressed
                          ? 0.85
                          : 1,
                    },
                  ]}
                >
                  {upsert.isPending ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <Text
                      style={{
                        color: colors.primaryForeground,
                        fontWeight: "600",
                      }}
                    >
                      Reschedule
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function PendingCard(props: {
  item: Pending;
  onMatch: (sug: PlanSuggestion) => void;
  onSkip: () => void;
  onReschedule: () => void;
  busy: boolean;
}) {
  const colors = useColors();
  const { item, onMatch, onSkip, onReschedule, busy } = props;
  const amt = item.amount;
  return (
    <View
      style={[
        cardStyles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={cardStyles.headerRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={[cardStyles.desc, { color: colors.foreground }]}
          >
            {item.txn.description}
          </Text>
          <Text style={[cardStyles.meta, { color: colors.mutedForeground }]}>
            {formatDayShort(item.date)} · {item.txn.source}
          </Text>
        </View>
        <Text
          style={[
            cardStyles.amount,
            { color: amt >= 0 ? colors.success : colors.foreground },
          ]}
        >
          {formatCurrency(amt)}
        </Text>
      </View>

      {item.suggestions.length === 0 ? (
        <Text
          style={[cardStyles.noMatch, { color: colors.mutedForeground }]}
        >
          No suggested plan within ±14 days.
        </Text>
      ) : (
        <View style={{ marginTop: 12, gap: 8 }}>
          {item.suggestions.map((sug) => (
            <Pressable
              key={`${sug.plan.itemId}|${sug.plan.date}`}
              onPress={() => onMatch(sug)}
              disabled={busy}
              style={({ pressed }) => [
                cardStyles.suggestion,
                {
                  borderColor: colors.border,
                  backgroundColor: pressed ? colors.accent : colors.background,
                  opacity: busy ? 0.6 : 1,
                },
              ]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={[cardStyles.suggestionLabel, { color: colors.foreground }]}
                >
                  {sug.plan.label}
                </Text>
                <View style={cardStyles.suggestionMetaRow}>
                  <View
                    style={[
                      cardStyles.confDot,
                      { backgroundColor: CONFIDENCE_COLOR[sug.confidence] },
                    ]}
                  />
                  <Text
                    style={[
                      cardStyles.suggestionMeta,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {sug.confidence} · {formatCurrency(sug.plan.amount)} ·{" "}
                    {sug.plan.date} ({sug.daysAway}d)
                  </Text>
                </View>
              </View>
              <Feather
                name="check"
                size={20}
                color={colors.primary}
              />
            </Pressable>
          ))}
        </View>
      )}

      <View style={cardStyles.actionRow}>
        <Pressable
          onPress={onReschedule}
          disabled={busy}
          style={({ pressed }) => [
            cardStyles.ghostBtn,
            {
              borderColor: colors.border,
              opacity: busy ? 0.6 : pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="calendar" size={14} color={colors.foreground} />
          <Text style={{ color: colors.foreground, fontWeight: "600" }}>
            Reschedule
          </Text>
        </Pressable>
        <Pressable
          onPress={onSkip}
          disabled={busy}
          style={({ pressed }) => [
            cardStyles.ghostBtn,
            {
              borderColor: colors.border,
              opacity: busy ? 0.6 : pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="slash" size={14} color={colors.mutedForeground} />
          <Text style={{ color: colors.mutedForeground, fontWeight: "600" }}>
            Skip
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 8,
  },
  h1: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
  },
  sub: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginTop: 2,
  },
  center: {
    paddingTop: 80,
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

const cardStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  desc: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  meta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 2,
  },
  amount: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    fontVariant: ["tabular-nums"],
  },
  noMatch: {
    fontStyle: "italic",
    fontSize: 13,
    marginTop: 10,
  },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 12,
  },
  suggestionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  suggestionMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  suggestionMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  confDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  ghostBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
});

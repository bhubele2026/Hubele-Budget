import { Feather } from "@expo/vector-icons";
import {
  getListTransactionsQueryKey,
  type Transaction,
  useClearTransferOverride,
  useListTransactions,
  useUpdateTransaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDateTime } from "@/lib/format";

function Row(props: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  value: string;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.row, { borderBottomColor: colors.border }]}
    >
      <View style={styles.rowLeft}>
        <Feather name={props.icon} size={16} color={colors.mutedForeground} />
        <Text style={[styles.rowLabel, { color: colors.mutedForeground }]}>
          {props.label}
        </Text>
      </View>
      <Text
        style={[styles.rowValue, { color: colors.foreground }]}
        numberOfLines={2}
      >
        {props.value}
      </Text>
    </View>
  );
}

function Flag(props: {
  active: boolean;
  label: string;
  onPress?: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const style = [
    styles.flag,
    {
      backgroundColor: props.active ? colors.accent : colors.muted,
      borderColor: colors.border,
    },
  ];
  const inner = (
    <>
      <Feather
        name={props.active ? "check" : "x"}
        size={12}
        color={props.active ? colors.accentForeground : colors.mutedForeground}
      />
      <Text
        style={[
          styles.flagText,
          {
            color: props.active
              ? colors.accentForeground
              : colors.mutedForeground,
          },
        ]}
      >
        {props.label}
      </Text>
    </>
  );
  if (props.onPress) {
    return (
      <Pressable
        style={style}
        onPress={props.onPress}
        testID={props.testID}
        accessibilityRole="button"
      >
        {inner}
      </Pressable>
    );
  }
  return (
    <View style={style} testID={props.testID}>
      {inner}
    </View>
  );
}

export default function TransactionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const qc = useQueryClient();
  const updateTx = useUpdateTransaction();
  const clearTransferOverride = useClearTransferOverride();

  // Use cached transactions list to look up by id; falls back to refetch
  // when the cache is empty (deep-link).
  const { data, isLoading, isError, error } = useListTransactions(
    { limit: 200 },
    {
      query: {
        queryKey: getListTransactionsQueryKey({ limit: 200 }),
        select: (rows: Transaction[]) => rows.find((t) => t.id === id) ?? null,
      },
    },
  );

  if (isLoading) {
    return (
      <View
        style={[
          styles.center,
          { backgroundColor: colors.background, flex: 1 },
        ]}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (isError) {
    return (
      <View
        style={[
          styles.center,
          { backgroundColor: colors.background, flex: 1, padding: 24 },
        ]}
      >
        <Text style={{ color: colors.destructive, fontWeight: "600" }}>
          Couldn't load transaction
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
      </View>
    );
  }

  const t = data as Transaction | null;
  if (!t) {
    return (
      <View
        style={[
          styles.center,
          { backgroundColor: colors.background, flex: 1, padding: 24 },
        ]}
      >
        <Text style={{ color: colors.mutedForeground }}>
          Transaction not found.
        </Text>
      </View>
    );
  }

  const amt = Number(t.amount) || 0;
  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
    >
      <View
        style={[
          styles.heroCard,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.heroDesc, { color: colors.foreground }]}>
          {t.description}
        </Text>
        <Text
          style={[
            styles.heroAmount,
            { color: amt >= 0 ? colors.success : colors.foreground },
          ]}
        >
          {formatCurrency(amt)}
        </Text>
        <Text style={[styles.heroDate, { color: colors.mutedForeground }]}>
          {formatDateTime(t.occurredOn)}
        </Text>
      </View>

      <View style={styles.flagRow}>
        <Flag active={t.forecastFlag} label="Forecast" />
        {/* (#607) Hide Weekly/Monthly/Unplanned allowance flags on
            transfer rows: they're excluded from budget actuals so
            those buckets are meaningless and would only confuse. */}
        {!t.isTransfer && (
          <>
            <Flag active={t.weeklyAllowance} label="Weekly" />
            <Flag active={t.monthlyAllowance} label="Monthly" />
            <Flag active={t.unplannedAllowance} label="Unplanned" />
          </>
        )}
        <Flag active={t.reimbursable} label="Reimbursable" />
        <Flag active={t.reimbursed} label="Reimbursed" />
        <Flag
          active={t.isTransfer}
          label={t.isTransferUserOverridden ? "Transfer*" : "Transfer"}
          testID="flag-transfer"
          onPress={() => {
            updateTx.mutate(
              { id: t.id, data: { isTransfer: !t.isTransfer } },
              {
                onSuccess: () => {
                  qc.invalidateQueries({
                    queryKey: getListTransactionsQueryKey({ limit: 200 }),
                  });
                },
              },
            );
          }}
        />
      </View>
      {t.isTransferUserOverridden && (
        <View
          style={[
            styles.overrideHint,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
          testID="transfer-override-hint"
        >
          <View style={{ flex: 1 }}>
            <Text
              style={[styles.overrideTitle, { color: colors.foreground }]}
            >
              Transfer status manually set
            </Text>
            <Text
              style={[styles.overrideBody, { color: colors.mutedForeground }]}
            >
              Future bank syncs won't re-flag this row. Reset to let
              auto-detection take over again.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            testID="button-reset-transfer-override"
            disabled={clearTransferOverride.isPending}
            onPress={() => {
              clearTransferOverride.mutate(
                { id: t.id },
                {
                  onSuccess: () => {
                    qc.invalidateQueries({
                      queryKey: getListTransactionsQueryKey({ limit: 200 }),
                    });
                  },
                },
              );
            }}
            style={[
              styles.overrideButton,
              { borderColor: colors.border, backgroundColor: colors.background },
            ]}
          >
            <Text
              style={[styles.overrideButtonText, { color: colors.foreground }]}
            >
              Reset to auto
            </Text>
          </Pressable>
        </View>
      )}

      <View style={styles.rows}>
        <Row icon="hash" label="ID" value={t.id} />
        <Row icon="link" label="Source" value={t.source} />
        {t.account && <Row icon="briefcase" label="Account" value={t.account} />}
        {t.categoryId && (
          <Row icon="tag" label="Category" value={t.categoryId} />
        )}
        {t.weeklyBucket && (
          <Row icon="layers" label="Weekly bucket" value={t.weeklyBucket} />
        )}
        {t.member && <Row icon="user" label="Member" value={t.member} />}
        {t.owedBy && <Row icon="users" label="Owed by" value={t.owedBy} />}
        {t.plaidAccountId && (
          <Row icon="server" label="Plaid account" value={t.plaidAccountId} />
        )}
        {t.plaidTransactionId && (
          <Row icon="server" label="Plaid txn" value={t.plaidTransactionId} />
        )}
        {t.notes && <Row icon="file-text" label="Notes" value={t.notes} />}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  heroCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  heroDesc: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    marginBottom: 8,
  },
  heroAmount: {
    fontFamily: "Inter_700Bold",
    fontSize: 32,
    fontVariant: ["tabular-nums"],
    marginBottom: 6,
  },
  heroDate: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  flagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  flag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  flagText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  rows: {
    borderRadius: 14,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 110,
  },
  rowLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  rowValue: {
    flex: 1,
    textAlign: "right",
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  overrideHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  overrideTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  overrideBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 2,
  },
  overrideButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  overrideButtonText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
});

import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAmexAnchorQueryKey,
  getGetDashboardQueryKey,
  getGetForecastQueryKey,
  getListDashboardBudgetsQueryKey,
  getListTransactionsQueryKey,
  type RecurringItem,
  type Transaction,
  getGetSettingsQueryKey,
  useGetAmexAnchor,
  useGetDashboard,
  useGetForecast,
  useGetSettings,
  useListDashboardBudgets,
  useListTransactions,
} from "@workspace/api-client-react";
import { Stack } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDateTime } from "@/lib/format";

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthStartISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-01`;
}

const SOURCE_LABEL: Record<string, string> = {
  debt: "Debt account",
  anchor: "Manual anchor",
  computed: "Computed",
  missing: "No data",
  manual: "Manual",
  plaid: "Plaid",
};

export default function DashboardScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const monthKey = useMemo(currentMonthKey, []);
  const monthStart = useMemo(monthStartISO, []);

  const dashboard = useGetDashboard();
  const forecast = useGetForecast();
  const amex = useGetAmexAnchor();
  const settings = useGetSettings();
  const weeklyBudgets = useListDashboardBudgets({
    bucket: "weekly",
    periodKey: monthKey,
  });
  const monthTxns = useListTransactions({ from: monthStart, limit: 5000 });

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetAmexAnchorQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() }),
        queryClient.invalidateQueries({
          queryKey: getListDashboardBudgetsQueryKey({
            bucket: "weekly",
            periodKey: monthKey,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: getListTransactionsQueryKey({
            from: monthStart,
            limit: 5000,
          }),
        }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const bankSnapshot = forecast.data?.bankSnapshot ?? null;
  const chaseBalance = bankSnapshot ? Number(bankSnapshot.balance) || 0 : null;
  const amexBalance = amex.data?.amexEndingBalance ?? null;
  const amexOwed = amexBalance == null ? null : Math.abs(amexBalance);

  const weeklySpend = useMemo(() => {
    const all = (monthTxns.data ?? []) as Transaction[];
    let sum = 0;
    for (const t of all) {
      if (!t.weeklyAllowance) continue;
      const amt = Number(t.amount) || 0;
      if (amt < 0) sum += -amt;
    }
    return sum;
  }, [monthTxns.data]);

  const weeklyTarget = useMemo(() => {
    const rows = weeklyBudgets.data ?? [];
    if (rows.length > 0) {
      const fromBudgets = Number(rows[0].amount) || 0;
      if (fromBudgets > 0) return fromBudgets;
    }
    const fromSettings = Number(settings.data?.weeklyAllowanceAmount) || 0;
    return fromSettings;
  }, [weeklyBudgets.data, settings.data?.weeklyAllowanceAmount]);

  const upcomingBills: RecurringItem[] = useMemo(
    () => (dashboard.data?.upcomingBills ?? []).slice(0, 6),
    [dashboard.data?.upcomingBills],
  );

  const initialLoading =
    dashboard.isLoading || forecast.isLoading || amex.isLoading;

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Dashboard</Text>

        {initialLoading ? (
          <View style={{ paddingTop: 60, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <>
            <BalancesSection
              chaseBalance={chaseBalance}
              chaseAt={bankSnapshot?.at ?? null}
              chaseSource={bankSnapshot?.source ?? null}
              amexOwed={amexOwed}
              amexAt={amex.data?.asOf ?? null}
              amexSource={amex.data?.source ?? null}
            />

            <WeeklySpendingSection
              spent={weeklySpend}
              target={weeklyTarget}
            />

            <UpcomingBillsSection bills={upcomingBills} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function BalancesSection(props: {
  chaseBalance: number | null;
  chaseAt: string | null;
  chaseSource: string | null;
  amexOwed: number | null;
  amexAt: string | null;
  amexSource: string | null;
}) {
  const colors = useColors();
  return (
    <View style={styles.balancesRow}>
      <BalanceCard
        label="Chase ending"
        value={
          props.chaseBalance == null
            ? "—"
            : formatCurrency(props.chaseBalance)
        }
        valueColor={
          props.chaseBalance != null && props.chaseBalance < 0
            ? colors.destructive
            : colors.foreground
        }
        hint={
          props.chaseAt
            ? `as of ${formatDateTime(props.chaseAt)}`
            : "Link Chase to see this"
        }
        sourceLabel={
          props.chaseSource ? SOURCE_LABEL[props.chaseSource] : null
        }
      />
      <BalanceCard
        label="Amex owed"
        value={props.amexOwed == null ? "—" : formatCurrency(props.amexOwed)}
        valueColor={colors.foreground}
        hint={
          props.amexAt ? `as of ${formatDateTime(props.amexAt)}` : "No Amex data"
        }
        sourceLabel={
          props.amexSource ? SOURCE_LABEL[props.amexSource] : null
        }
      />
    </View>
  );
}

function BalanceCard(props: {
  label: string;
  value: string;
  valueColor: string;
  hint: string;
  sourceLabel: string | null;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.balanceCard,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>
        {props.label}
      </Text>
      <Text style={[styles.balanceValue, { color: props.valueColor }]}>
        {props.value}
      </Text>
      <Text style={[styles.balanceHint, { color: colors.mutedForeground }]}>
        {props.hint}
      </Text>
      {props.sourceLabel && (
        <View
          style={[
            styles.sourceChip,
            { backgroundColor: colors.accent, borderColor: colors.border },
          ]}
        >
          <Text
            style={[styles.sourceChipText, { color: colors.accentForeground }]}
          >
            {props.sourceLabel}
          </Text>
        </View>
      )}
    </View>
  );
}

function WeeklySpendingSection(props: { spent: number; target: number }) {
  const colors = useColors();
  const { spent, target } = props;
  const pct = target > 0 ? Math.min(100, (spent / target) * 100) : 0;
  const over = target > 0 && spent > target;
  const remaining = Math.max(0, target - spent);
  return (
    <View
      style={[
        styles.section,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        This week's spending
      </Text>
      <View style={styles.weeklyRow}>
        <Text
          style={[
            styles.weeklyValue,
            { color: over ? colors.destructive : colors.foreground },
          ]}
        >
          {formatCurrency(spent)}
        </Text>
        <Text
          style={[styles.weeklyTarget, { color: colors.mutedForeground }]}
        >
          {" / "}
          {target > 0 ? formatCurrency(target) : "no target"}
        </Text>
      </View>
      <View
        style={[
          styles.progressTrack,
          { backgroundColor: colors.muted },
        ]}
      >
        <View
          style={[
            styles.progressFill,
            {
              width: `${pct}%`,
              backgroundColor: over ? colors.destructive : colors.primary,
            },
          ]}
        />
      </View>
      <Text style={[styles.weeklyHint, { color: colors.mutedForeground }]}>
        {target > 0
          ? over
            ? `Over by ${formatCurrency(spent - target)} this month`
            : `${formatCurrency(remaining)} left this month`
          : "Set a weekly target on the web app"}
      </Text>
    </View>
  );
}

function UpcomingBillsSection(props: { bills: RecurringItem[] }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.section,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        Upcoming bills
      </Text>
      {props.bills.length === 0 ? (
        <Text
          style={{
            color: colors.mutedForeground,
            paddingVertical: 12,
            textAlign: "center",
          }}
        >
          All clear — no recurring bills on the radar.
        </Text>
      ) : (
        <View style={{ marginTop: 4 }}>
          {props.bills.map((b, i) => (
            <View
              key={b.id}
              style={[
                styles.billRow,
                {
                  borderBottomColor: colors.border,
                  borderBottomWidth:
                    i === props.bills.length - 1
                      ? 0
                      : StyleSheet.hairlineWidth,
                },
              ]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={[styles.billName, { color: colors.foreground }]}
                >
                  {b.name}
                </Text>
                <Text
                  style={[styles.billMeta, { color: colors.mutedForeground }]}
                >
                  {b.frequency}
                  {b.dayOfMonth ? ` · day ${b.dayOfMonth}` : ""}
                </Text>
              </View>
              <Text style={[styles.billAmount, { color: colors.foreground }]}>
                {formatCurrency(b.amount)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  h1: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    marginBottom: 16,
  },
  balancesRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  balanceCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  balanceLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  balanceValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    fontVariant: ["tabular-nums"],
  },
  balanceHint: {
    marginTop: 6,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  sourceChip: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  sourceChipText: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  section: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  sectionLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  weeklyRow: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 10,
  },
  weeklyValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    fontVariant: ["tabular-nums"],
  },
  weeklyTarget: {
    fontFamily: "Inter_500Medium",
    fontSize: 16,
    fontVariant: ["tabular-nums"],
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
  },
  weeklyHint: {
    marginTop: 8,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  billRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  billName: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  billMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 2,
    textTransform: "capitalize",
  },
  billAmount: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    fontVariant: ["tabular-nums"],
  },
});


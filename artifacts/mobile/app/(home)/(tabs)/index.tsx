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

import { PlaidReauthBanner } from "@/components/PlaidReauthBanner";
import { useColors } from "@/hooks/useColors";
import { usePlaidSync } from "@/hooks/usePlaidSync";
import { formatCurrency, formatDateTime } from "@/lib/format";

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Parity with the web dashboard: pull a year of history so the Unplanned
// month cycler can scroll back into prior months without a refetch (#487).
function monthsAgoStartISO(monthsBack: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-01`;
}

function monthBoundsForOffset(offset: number): {
  start: string;
  end: string;
  label: string;
} {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  const label = start.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  return { start: fmt(start), end: fmt(end), label };
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentWeekRangeISO(): { start: string; end: string } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(d);
  start.setDate(d.getDate() + offsetToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: toISODate(start), end: toISODate(end) };
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
  const weekRange = useMemo(currentWeekRangeISO, []);
  // (#487) Pull a rolling year so the Unplanned month cycler can scroll
  // back into prior months without an extra fetch. Mirrors web behavior.
  const txnFetchFrom = useMemo(() => {
    const earliest = monthsAgoStartISO(12);
    return weekRange.start < earliest ? weekRange.start : earliest;
  }, [weekRange.start]);

  const dashboard = useGetDashboard();
  const forecast = useGetForecast();
  const amex = useGetAmexAnchor();
  const settings = useGetSettings();
  const weeklyBudgets = useListDashboardBudgets({
    bucket: "weekly",
    periodKey: monthKey,
  });
  const monthTxns = useListTransactions({ from: txnFetchFrom, limit: 5000 });
  // (#358) Pull-to-refresh on the dashboard now also kicks a Plaid sync
  // (mirroring the web app's behavior). The hook surfaces structured
  // per-item failures as "<Institution>: <plain reason>" via Alert and
  // adds a Reconnect CTA on re-auth — never the bare axios string.
  const { runSync } = usePlaidSync();

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      // Kick a Plaid sync first so any new rows / errors are reflected
      // when the queries below re-fetch. The hook owns its own user
      // messaging (Alert), so we don't need to surface anything here.
      await runSync();
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
            from: txnFetchFrom,
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
      const occurredOn = String(t.occurredOn ?? "").slice(0, 10);
      if (!occurredOn) continue;
      if (occurredOn < weekRange.start || occurredOn > weekRange.end) continue;
      const amt = Number(t.amount) || 0;
      if (amt < 0) sum += -amt;
    }
    return sum;
  }, [monthTxns.data, weekRange.start, weekRange.end]);

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

  // (#487) Mirror the web dashboard: a txn marked Unplanned in the
  // forecast inbox writes a resolution of `ignored_unforecasted`
  // (legacy `unplanned`) against the bank txn's id. Surface that set
  // so the Unplanned tile counts those rows alongside ones whose
  // `unplannedAllowance` flag was set manually.
  const resolvedUnplannedTxnIds = useMemo(() => {
    const ids = new Set<string>();
    const rs = forecast.data?.resolutions ?? [];
    for (const r of rs) {
      if (!r.matchedTxnId) continue;
      if (r.status === "ignored_unforecasted" || r.status === "unplanned") {
        ids.add(r.matchedTxnId);
      }
    }
    return ids;
  }, [forecast.data?.resolutions]);

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

        <PlaidReauthBanner />

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

            <UnplannedSpendingSection
              transactions={(monthTxns.data ?? []) as Transaction[]}
              resolvedUnplannedTxnIds={resolvedUnplannedTxnIds}
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
            ? `Over by ${formatCurrency(spent - target)} this week`
            : `${formatCurrency(remaining)} left this week`
          : "Set a weekly target on the web app"}
      </Text>
    </View>
  );
}

function UnplannedSpendingSection(props: {
  transactions: Transaction[];
  resolvedUnplannedTxnIds: ReadonlySet<string>;
}) {
  const colors = useColors();
  const [monthOffset, setMonthOffset] = useState(0);
  const bounds = useMemo(
    () => monthBoundsForOffset(monthOffset),
    [monthOffset],
  );

  // (#487) Mirror web: count any txn whose `unplannedAllowance` flag is
  // set OR whose forecast resolution stamps it ignored_unforecasted /
  // unplanned. Bucket by `occurredOn` so switching months does the
  // right thing.
  const monthRows = useMemo(() => {
    const rows: Transaction[] = [];
    for (const t of props.transactions) {
      const occurredOn = String(t.occurredOn ?? "").slice(0, 10);
      if (!occurredOn) continue;
      if (occurredOn < bounds.start || occurredOn > bounds.end) continue;
      const tagged =
        t.unplannedAllowance ||
        props.resolvedUnplannedTxnIds.has(t.id);
      if (!tagged) continue;
      rows.push(t);
    }
    rows.sort((a, b) =>
      String(b.occurredOn ?? "").localeCompare(String(a.occurredOn ?? "")),
    );
    return rows;
  }, [props.transactions, props.resolvedUnplannedTxnIds, bounds.start, bounds.end]);

  const total = useMemo(() => {
    let sum = 0;
    for (const t of monthRows) {
      const amt = Number(t.amount) || 0;
      if (amt < 0) sum += -amt;
    }
    return sum;
  }, [monthRows]);

  const recent = monthRows.slice(0, 5);

  return (
    <View
      style={[
        styles.section,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
      testID="unplanned-spending-section"
    >
      <View style={styles.unplannedHeader}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
          Unplanned spending
        </Text>
        <View style={styles.monthCycler}>
          <Text
            onPress={() => setMonthOffset((m) => m - 1)}
            style={[styles.cyclerBtn, { color: colors.foreground, borderColor: colors.border }]}
            accessibilityLabel="Previous month"
            testID="unplanned-prev-month"
          >
            ‹
          </Text>
          <Text
            style={[styles.cyclerLabel, { color: colors.mutedForeground }]}
            testID="unplanned-month-label"
          >
            {bounds.label}
          </Text>
          <Text
            onPress={() =>
              setMonthOffset((m) => (m >= 0 ? m : m + 1))
            }
            style={[
              styles.cyclerBtn,
              {
                color: monthOffset >= 0 ? colors.mutedForeground : colors.foreground,
                borderColor: colors.border,
                opacity: monthOffset >= 0 ? 0.4 : 1,
              },
            ]}
            accessibilityLabel="Next month"
            testID="unplanned-next-month"
          >
            ›
          </Text>
        </View>
      </View>
      <Text
        style={[styles.weeklyValue, { color: colors.foreground }]}
        testID="unplanned-total"
      >
        {formatCurrency(total)}
      </Text>
      {recent.length === 0 ? (
        <Text
          style={{
            color: colors.mutedForeground,
            paddingVertical: 12,
            textAlign: "center",
          }}
        >
          Nothing tagged Unplanned this month.
        </Text>
      ) : (
        <View style={{ marginTop: 8 }}>
          {recent.map((t, i) => (
            <View
              key={t.id}
              style={[
                styles.billRow,
                {
                  borderBottomColor: colors.border,
                  borderBottomWidth:
                    i === recent.length - 1 ? 0 : StyleSheet.hairlineWidth,
                },
              ]}
              testID={`unplanned-row-${t.id}`}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={[styles.billName, { color: colors.foreground }]}
                >
                  {t.description}
                </Text>
                <Text
                  style={[styles.billMeta, { color: colors.mutedForeground }]}
                >
                  {String(t.occurredOn ?? "").slice(0, 10)}
                </Text>
              </View>
              <Text style={[styles.billAmount, { color: colors.foreground }]}>
                {formatCurrency(Math.abs(Number(t.amount) || 0))}
              </Text>
            </View>
          ))}
        </View>
      )}
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
  unplannedHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    gap: 8,
  },
  monthCycler: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cyclerBtn: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    minWidth: 28,
    textAlign: "center",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderRadius: 999,
    overflow: "hidden",
  },
  cyclerLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    minWidth: 110,
    textAlign: "center",
  },
});


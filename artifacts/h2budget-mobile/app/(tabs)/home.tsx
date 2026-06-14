import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth, useUser } from "@clerk/clerk-expo";
import {
  createApi,
  type Dashboard,
  type Nudge,
  type Settings,
  type Txn,
} from "@/lib/api";
import {
  computeStatus,
  sundayOf,
  firstOfMonth,
  lastOfMonth,
  iso,
  type BucketStatus,
} from "@/lib/allowances";
import { colors, radius, fonts, formatCurrency } from "@/lib/theme";

function greetingFor(h: number): string {
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Burning the midnight oil";
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}) {
  const c =
    tone === "good"
      ? colors.positive
      : tone === "bad"
        ? colors.negative
        : colors.text;
  return (
    <View style={s.statCard}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.statNum, fonts.tabular, { color: c }]}>{value}</Text>
    </View>
  );
}

function PaceBar({ st }: { st: BucketStatus }) {
  const over = st.spent > st.planned;
  const pct = st.planned > 0 ? Math.min(1, st.spent / st.planned) : 0;
  const c = over ? colors.negative : colors.positive;
  return (
    <View style={s.card}>
      <View style={s.paceHead}>
        <Text style={s.label}>{st.label}</Text>
        <Text style={[s.paceAmt, fonts.tabular]}>
          <Text style={{ color: c }}>{formatCurrency(st.spent)}</Text>
          <Text style={{ color: colors.muted }}>
            {" "}
            / {formatCurrency(st.planned)}
          </Text>
        </Text>
      </View>
      <View style={s.track}>
        <View
          style={[s.fill, { width: `${Math.round(pct * 100)}%`, backgroundColor: c }]}
        />
      </View>
      <Text style={s.sub}>
        {st.planned <= 0
          ? "No allowance set"
          : over
            ? `${formatCurrency(st.variance)} over — ease up.`
            : `${formatCurrency(-st.variance)} left.`}
      </Text>
    </View>
  );
}

export default function HomeScreen() {
  const { getToken } = useAuth();
  const { user } = useUser();
  const api = useMemo(() => createApi(getToken), [getToken]);

  const [dash, setDash] = useState<Dashboard | undefined>();
  const [nudge, setNudge] = useState<Nudge | undefined>();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const now = new Date();
      const weekStart = sundayOf(now);
      const mStart = firstOfMonth(now);
      const mEnd = lastOfMonth(now);
      const from = iso(weekStart < mStart ? weekStart : mStart);
      const to = iso(mEnd);
      const [d, n, s, t] = await Promise.all([
        api.getDashboard(),
        api.getNudge().catch(() => undefined),
        api.getSettings(),
        api.getTransactions(from, to),
      ]);
      setDash(d);
      setNudge(n);
      setSettings(s);
      setTxns(t);
    } catch {
      /* surfaced on next pull */
    } finally {
      setLoading(false);
    }
  }, [api]);

  const status = useMemo(
    () => computeStatus(settings, txns),
    [settings, txns],
  );

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const who = user?.firstName?.trim() || "Hubeles";
  const greeting = greetingFor(new Date().getHours());
  const net = dash ? Number(dash.netCashflow) : 0;
  const income = dash ? Number(dash.monthlyIncome) : 0;
  const spend = dash ? Number(dash.monthlySpend) : 0;
  const debt = dash ? Number(dash.totalDebt) : 0;
  const paid = dash ? Number(dash.paidThisMonth) : 0;
  const topCat = dash?.topCategories?.[0];

  if (loading) {
    return (
      <SafeAreaView style={s.center}>
        <ActivityIndicator color={colors.navy} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.navy}
          />
        }
      >
        <Text style={s.greeting}>
          {greeting}, {who}.
        </Text>

        {nudge?.enabled && nudge.message ? (
          <View style={s.nudge}>
            <Text style={s.nudgeText}>✨ {nudge.message}</Text>
          </View>
        ) : null}

        <PaceBar st={status.weekly} />
        <PaceBar st={status.monthly} />

        <View style={s.netCard}>
          <Text style={s.label}>Net this month</Text>
          <Text
            style={[
              s.netNum,
              fonts.tabular,
              { color: net >= 0 ? colors.positive : colors.negative },
            ]}
          >
            {net >= 0 ? "+" : ""}
            {formatCurrency(net)}
          </Text>
          <Text style={s.sub}>
            {formatCurrency(income)} in · {formatCurrency(spend)} out
          </Text>
        </View>

        <View style={s.row}>
          <Stat
            label="Total debt"
            value={formatCurrency(debt)}
            tone={debt > 0 ? "bad" : "good"}
          />
          <Stat
            label="Paid to debt"
            value={formatCurrency(paid)}
            tone={paid > 0 ? "good" : "neutral"}
          />
        </View>

        {topCat ? (
          <View style={s.card}>
            <Text style={s.label}>Top category this month</Text>
            <View style={s.catRow}>
              <Text style={s.catName}>{topCat.categoryName}</Text>
              <Text style={[s.catAmt, fonts.tabular]}>
                {formatCurrency(Number(topCat.total) || 0)}
              </Text>
            </View>
          </View>
        ) : null}

        <Text style={s.tip}>
          💡 Check this before you spend, not after. Revolutionary, I know.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { padding: 16, paddingBottom: 40, gap: 14 },
  greeting: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginTop: 4,
  },
  nudge: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
  },
  nudgeText: { color: colors.text, fontSize: 15, fontWeight: "600", lineHeight: 21 },
  netCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 18,
  },
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  netNum: { fontSize: 40, fontWeight: "800", marginTop: 6, letterSpacing: -1 },
  sub: { color: colors.muted, fontSize: 13, marginTop: 6 },
  row: { flexDirection: "row", gap: 12 },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
  },
  statNum: { fontSize: 22, fontWeight: "800", marginTop: 6 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
  },
  catRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
  },
  catName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  catAmt: { color: colors.text, fontSize: 16, fontWeight: "700" },
  tip: { color: colors.faint, fontSize: 13, marginTop: 4, lineHeight: 19 },
  paceHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 8,
  },
  paceAmt: { fontSize: 14, fontWeight: "700" },
  track: {
    height: 9,
    borderRadius: 999,
    backgroundColor: colors.trackBg,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 999 },
});

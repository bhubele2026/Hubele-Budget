import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Pressable,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@clerk/clerk-expo";
import { createApi, type Settings, type Txn } from "@/lib/api";
import {
  computeStatus,
  sundayOf,
  firstOfMonth,
  lastOfMonth,
  iso,
  type BucketStatus,
} from "@/lib/allowances";
import { colors, radius, formatCurrency } from "@/lib/theme";

export default function AllowancesScreen() {
  const { getToken, signOut } = useAuth();
  const api = useMemo(() => createApi(getToken), [getToken]);

  const [settings, setSettings] = useState<Settings | undefined>();
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const now = new Date();
      const weekStart = sundayOf(now);
      const weekEnd = new Date(weekStart.getTime() + 6 * 86_400_000);
      const mStart = firstOfMonth(now);
      const mEnd = lastOfMonth(now);
      const from = iso(weekStart < mStart ? weekStart : mStart);
      const to = iso(weekEnd > mEnd ? weekEnd : mEnd);
      const [s, t] = await Promise.all([
        api.getSettings(),
        api.getTransactions(from, to),
      ]);
      setSettings(s);
      setTxns(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const status = useMemo(() => computeStatus(settings, txns), [settings, txns]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>H2 Budget</Text>
          <Text style={styles.title}>Allowances</Text>
        </View>
        <Pressable onPress={() => signOut()} hitSlop={12}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.navy} />
        }
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.navy} />
          </View>
        ) : error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Couldn&rsquo;t load</Text>
            <Text style={styles.errorBody}>{error}</Text>
            <Text style={styles.errorHint}>Pull down to retry.</Text>
          </View>
        ) : (
          <>
            <AllowanceCard status={status.weekly} pace />
            <AllowanceCard status={status.monthly} pace />
            <AllowanceCard status={status.unplanned} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function paceLabel(s: BucketStatus): { text: string; color: string } {
  const threshold = Math.max(5, s.planned * 0.05);
  if (s.pace > threshold) {
    return { text: `${formatCurrency(s.pace)} ahead of pace`, color: colors.negative };
  }
  if (s.pace < -threshold) {
    return { text: `${formatCurrency(-s.pace)} under pace`, color: colors.positive };
  }
  return { text: "On pace", color: colors.muted };
}

function AllowanceCard({ status, pace }: { status: BucketStatus; pace?: boolean }) {
  const over = status.variance > 0;
  const noPlan = status.planned <= 0;
  const pct = Math.max(0, Math.min(1, status.pct));
  const elapsedPct = Math.max(0, Math.min(1, status.elapsed));
  const p = paceLabel(status);

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardLabel}>{status.label.toUpperCase()} ALLOWANCE</Text>
        <Text style={styles.cardRange}>{status.rangeLabel}</Text>
      </View>

      <Text style={styles.bigNumber}>{formatCurrency(status.spent)}</Text>
      <Text style={styles.planned}>of {formatCurrency(status.planned)} planned</Text>

      <View style={styles.track}>
        {/* Pace marker — where you'd be at an even pace */}
        {pace && !noPlan && (
          <View style={[styles.paceMarker, { left: `${elapsedPct * 100}%` }]} />
        )}
        <View
          style={[
            styles.fill,
            { width: `${pct * 100}%`, backgroundColor: over ? colors.negative : colors.navy },
          ]}
        />
      </View>

      {noPlan ? (
        <Text style={styles.noPlan}>No allowance set</Text>
      ) : (
        <View style={styles.statusRow}>
          <Text style={[styles.variance, { color: over ? colors.negative : colors.positive }]}>
            {formatCurrency(Math.abs(status.variance))} {over ? "over" : "under"}
          </Text>
          {pace && (
            <Text style={[styles.pace, { color: p.color }]}>
              {p.text}
              {status.daysLeft > 0 ? ` · ${status.daysLeft}d left` : ""}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  brand: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  title: { color: "#fff", fontSize: 28, fontWeight: "700", letterSpacing: -0.5, marginTop: 2 },
  signOut: { color: "rgba(255,255,255,0.85)", fontSize: 14, fontWeight: "600", paddingBottom: 4 },
  scroll: { padding: 16, gap: 14 },
  center: { paddingTop: 60, alignItems: "center" },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
  },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardLabel: { color: colors.muted, fontSize: 11.5, fontWeight: "700", letterSpacing: 1 },
  cardRange: { color: colors.faint, fontSize: 12 },
  bigNumber: {
    color: colors.text,
    fontSize: 40,
    fontWeight: "700",
    letterSpacing: -1,
    marginTop: 10,
    fontVariant: ["tabular-nums"],
  },
  planned: { color: colors.muted, fontSize: 14, marginTop: 2, fontVariant: ["tabular-nums"] },
  track: {
    height: 8,
    backgroundColor: colors.trackBg,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 16,
    position: "relative",
  },
  fill: { height: 8, borderRadius: 999 },
  paceMarker: {
    position: "absolute",
    top: -3,
    width: 2,
    height: 14,
    backgroundColor: colors.faint,
    zIndex: 2,
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
    gap: 8,
  },
  variance: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  pace: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  noPlan: { fontSize: 14, color: colors.negative, fontWeight: "600", marginTop: 12 },
  errorCard: {
    backgroundColor: colors.negativeBg,
    borderRadius: radius.md,
    padding: 18,
    gap: 6,
  },
  errorTitle: { color: colors.negative, fontWeight: "700", fontSize: 15 },
  errorBody: { color: colors.text, fontSize: 13 },
  errorHint: { color: colors.muted, fontSize: 12, marginTop: 4 },
});

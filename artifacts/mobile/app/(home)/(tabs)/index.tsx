import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import {
  getListTransactionsQueryKey,
  type Transaction,
  useListTransactions,
} from "@workspace/api-client-react";
import { Stack, useRouter, type Href } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { formatCurrency, formatDayShort, formatMonthLabel, monthKey } from "@/lib/format";

type Row =
  | { kind: "header"; key: string; label: string; net: number; count: number }
  | { kind: "txn"; key: string; txn: Transaction };

function buildRows(txns: Transaction[]): Row[] {
  const sorted = [...txns].sort((a, b) =>
    a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0,
  );
  const rows: Row[] = [];
  let currentMonth = "";
  let monthBuf: Transaction[] = [];

  const flush = () => {
    if (!currentMonth) return;
    const net = monthBuf.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    rows.push({
      kind: "header",
      key: `h-${currentMonth}`,
      label: formatMonthLabel(currentMonth),
      net,
      count: monthBuf.length,
    });
    for (const t of monthBuf) {
      rows.push({ kind: "txn", key: t.id, txn: t });
    }
  };

  for (const t of sorted) {
    const mk = monthKey(t.occurredOn);
    if (mk !== currentMonth) {
      flush();
      currentMonth = mk;
      monthBuf = [];
    }
    monthBuf.push(t);
  }
  flush();
  return rows;
}

export default function TransactionsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { signOut } = useAuth();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(200);

  const { data, isLoading, isError, error, refetch, isRefetching } =
    useListTransactions(
      { limit },
      {
        query: {
          queryKey: getListTransactionsQueryKey({ limit }),
          gcTime: 5 * 60_000,
        },
      },
    );

  const filtered = useMemo<Transaction[]>(() => {
    const all = (data ?? []) as Transaction[];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) =>
        t.description.toLowerCase().includes(q) ||
        (t.notes ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  const rows = useMemo(() => buildRows(filtered), [filtered]);

  const handleSignOut = () => {
    Alert.alert("Sign out", "Sign out of H2 Budget?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => signOut(),
      },
    ]);
  };

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.headerRow}>
        <Text style={[styles.h1, { color: colors.foreground }]}>Transactions</Text>
        <Pressable
          onPress={handleSignOut}
          hitSlop={12}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Feather name="log-out" size={20} color={colors.mutedForeground} />
        </Pressable>
      </View>
      <View
        style={[
          styles.searchBox,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <Feather name="search" size={16} color={colors.mutedForeground} />
        <TextInput
          style={[styles.searchInput, { color: colors.foreground }]}
          placeholder="Search description or notes"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <Feather name="x" size={16} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>
            Couldn't load transactions
          </Text>
          <Text
            style={{
              color: colors.mutedForeground,
              textAlign: "center",
              marginTop: 6,
              paddingHorizontal: 24,
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
            <Text
              style={{
                color: colors.primaryForeground,
                fontWeight: "600",
              }}
            >
              Retry
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ paddingBottom: 120 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if ((data?.length ?? 0) >= limit) {
              setLimit((n) => n + 200);
            }
          }}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={{ color: colors.mutedForeground }}>
                No transactions yet
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            if (item.kind === "header") {
              return (
                <View
                  style={[
                    styles.monthHeader,
                    {
                      backgroundColor: colors.background,
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[styles.monthLabel, { color: colors.foreground }]}
                  >
                    {item.label}
                  </Text>
                  <Text
                    style={[
                      styles.monthNet,
                      {
                        color:
                          item.net >= 0 ? colors.success : colors.destructive,
                      },
                    ]}
                  >
                    {formatCurrency(item.net)}
                  </Text>
                </View>
              );
            }
            const t = item.txn;
            const amt = Number(t.amount) || 0;
            return (
              <Pressable
                onPress={() =>
                  router.push(`/(home)/transaction/${t.id}` as Href)
                }
                style={({ pressed }) => [
                  styles.txnRow,
                  {
                    backgroundColor: pressed ? colors.accent : "transparent",
                    borderBottomColor: colors.border,
                  },
                ]}
              >
                <View style={styles.txnLeft}>
                  <Text
                    numberOfLines={1}
                    style={[styles.txnDesc, { color: colors.foreground }]}
                  >
                    {t.description}
                  </Text>
                  <Text
                    style={[styles.txnMeta, { color: colors.mutedForeground }]}
                  >
                    {formatDayShort(t.occurredOn)} · {t.source}
                    {t.isTransfer ? " · transfer" : ""}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.txnAmount,
                    {
                      color: amt >= 0 ? colors.success : colors.foreground,
                    },
                  ]}
                >
                  {formatCurrency(amt)}
                </Text>
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  h1: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginVertical: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    paddingVertical: 0,
  },
  center: {
    paddingTop: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  monthHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  monthLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  monthNet: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  txnRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  txnLeft: {
    flex: 1,
    minWidth: 0,
  },
  txnDesc: {
    fontFamily: "Inter_500Medium",
    fontSize: 15,
    marginBottom: 2,
  },
  txnMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  txnAmount: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    fontVariant: ["tabular-nums"],
  },
});

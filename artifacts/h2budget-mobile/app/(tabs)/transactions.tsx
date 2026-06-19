import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@clerk/clerk-expo";
import { createApi, type Category, type Txn } from "@/lib/api";
import { firstOfMonth, lastOfMonth, iso } from "@/lib/allowances";
import { colors, radius, formatCurrency } from "@/lib/theme";
import { Skeleton } from "@/components/Skeleton";

export default function CategorizeScreen() {
  const { getToken } = useAuth();
  const api = useMemo(() => createApi(getToken), [getToken]);

  const [txns, setTxns] = useState<Txn[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<Txn | null>(null);
  const [onlyUncat, setOnlyUncat] = useState(true);
  const [catQuery, setCatQuery] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const now = new Date();
      const from = iso(firstOfMonth(now));
      const to = iso(lastOfMonth(now));
      const [t, c] = await Promise.all([
        api.getTransactions(from, to),
        api.getCategories(),
      ]);
      setTxns(
        t
          .filter((x) => Number(x.amount) < 0 && !x.isTransfer)
          .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1)),
      );
      setCats(c);
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

  const catName = useMemo(() => {
    const m = new Map(cats.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? m.get(id) ?? "Uncategorized" : "Uncategorized");
  }, [cats]);

  const setCategory = async (tx: Txn, categoryId: string) => {
    setPicking(null);
    // optimistic
    setTxns((prev) => prev.map((x) => (x.id === tx.id ? { ...x, categoryId } : x)));
    try {
      await api.setCategory(tx.id, categoryId);
    } catch {
      load(); // revert by reloading on failure
    }
  };

  const uncatCount = useMemo(
    () => txns.filter((t) => !t.categoryId).length,
    [txns],
  );
  const visible = onlyUncat ? txns.filter((t) => !t.categoryId) : txns;

  // Filter the picker's category list by the search box. Mirrors the web
  // transactions page's category search so a long list stays usable on phone.
  const pickerCats = useMemo(() => {
    const q = catQuery.trim().toLowerCase();
    if (!q) return cats;
    return cats.filter((c) => c.name.toLowerCase().includes(q));
  }, [cats, catQuery]);

  const openPicker = (tx: Txn) => {
    setCatQuery("");
    setPicking(tx);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.brand}>H2 Budget</Text>
        <Text style={styles.title}>Categorize</Text>
      </View>

      <View style={styles.filterRow}>
        <Pressable
          onPress={() => setOnlyUncat(true)}
          style={[styles.chip, onlyUncat && styles.chipOn]}
        >
          <Text style={[styles.chipText, onlyUncat && styles.chipTextOn]}>
            Needs a category{uncatCount > 0 ? ` (${uncatCount})` : ""}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setOnlyUncat(false)}
          style={[styles.chip, !onlyUncat && styles.chipOn]}
        >
          <Text style={[styles.chipText, !onlyUncat && styles.chipTextOn]}>All</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ padding: 16, gap: 10 }}>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} style={{ height: 62 }} />
          ))}
        </View>
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.navy} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>All caught up — nothing to categorize.</Text>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => openPicker(item)}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.merchant} numberOfLines={1}>
                  {item.displayName || item.description}
                </Text>
                <Text style={styles.cat}>{catName(item.categoryId)}</Text>
              </View>
              <Text style={styles.amount}>{formatCurrency(Math.abs(Number(item.amount)))}</Text>
            </Pressable>
          )}
        />
      )}

      <Modal visible={!!picking} animationType="slide" transparent onRequestClose={() => setPicking(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPicking(null)}>
          <Pressable style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {picking?.displayName || picking?.description}
            </Text>
            <TextInput
              style={styles.search}
              placeholder="Search categories"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              value={catQuery}
              onChangeText={setCatQuery}
            />
            <FlatList
              data={pickerCats}
              keyExtractor={(c) => c.id}
              keyboardShouldPersistTaps="handled"
              style={{ maxHeight: 380 }}
              ListEmptyComponent={
                <Text style={styles.noMatch}>No categories match.</Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={styles.catRow}
                  onPress={() => picking && setCategory(picking, item.id)}
                >
                  <Text style={styles.catRowText}>{item.name}</Text>
                </Pressable>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 18,
  },
  brand: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  title: { color: "#fff", fontSize: 28, fontWeight: "700", letterSpacing: -0.5, marginTop: 2 },
  filterRow: { flexDirection: "row", gap: 8, padding: 16, paddingBottom: 4 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipOn: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: "#fff" },
  center: { paddingTop: 60, alignItems: "center" },
  error: { color: colors.negative, padding: 16 },
  empty: { color: colors.muted, textAlign: "center", paddingTop: 40 },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  merchant: { color: colors.text, fontSize: 15, fontWeight: "600" },
  cat: { color: colors.muted, fontSize: 12.5, marginTop: 2 },
  amount: { color: colors.text, fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    paddingBottom: 32,
  },
  sheetTitle: { fontSize: 16, fontWeight: "700", color: colors.text, marginBottom: 8 },
  search: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    marginBottom: 8,
  },
  noMatch: { color: colors.muted, paddingVertical: 16, textAlign: "center" },
  catRow: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  catRowText: { fontSize: 16, color: colors.text },
});

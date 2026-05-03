import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListTransactions,
  useUpdateTransaction,
  useListCategories,
  useListDebts,
  getListTransactionsQueryKey,
  getGetBudgetMonthQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { CreditCard } from "lucide-react";
import { CategoryPicker } from "@/components/category-picker";
import { TransactionWeeklyBucket } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { useWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import {
  AccountPageHeader,
  AccountFilterBar,
  BalanceTrendChart,
  DayGroup,
  MonthNavigator,
  StatChip,
  StatChipUnavailable,
  monthKeyOf,
  monthKeyFromISO,
  compareMonth,
  shiftMonth,
  monthFirstISO,
  monthLastISO,
  type MonthKey,
  type TrendPoint,
} from "@/components/account-page";

const AMEX_SOURCE = "amex";

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function parseAbs(amount: string) {
  return Math.abs(parseFloat(amount) || 0);
}

function parseSigned(amount: string) {
  return parseFloat(amount) || 0;
}

function defaultWeeklyBucketFor(categoryName: string): typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] {
  const n = categoryName.toLowerCase();
  if (n.includes("grocer")) return TransactionWeeklyBucket.groceries;
  if (n.includes("dining") || n.includes("restaurant") || n.includes("food")) return TransactionWeeklyBucket.dining;
  if (n.includes("entertain")) return TransactionWeeklyBucket.entertainment;
  return TransactionWeeklyBucket.misc;
}

function currentBucket(t: Pick<Transaction, "weeklyAllowance" | "monthlyAllowance" | "unplannedAllowance">): "" | "weekly" | "monthly" | "unplanned" {
  if (t.weeklyAllowance) return "weekly";
  if (t.monthlyAllowance) return "monthly";
  if (t.unplannedAllowance) return "unplanned";
  return "";
}

export default function AmexPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Filters
  const [sourceFilter, setSourceFilter] = useState<string>(AMEX_SOURCE);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");

  const currentMonth = useMemo<MonthKey>(() => monthKeyOf(new Date()), []);
  const [selectedMonth, setSelectedMonth] = useState<MonthKey>(currentMonth);

  // Server query: fetch the union of [selected month] ∪ [selected month →
  // current month] so we have everything needed for the month's rows AND
  // for rolling the ending balance between the anchor and the selected
  // month. Per-row From/To narrows further client-side.
  const queryParams = useMemo(() => {
    // Widen window to cover the trailing-12-month trend chart, which
    // anchors at currentMonth and rolls back to (selectedMonth - 11).
    const trendStart = shiftMonth(selectedMonth, -11);
    const candidates = [selectedMonth, currentMonth, trendStart];
    let earlier = candidates[0];
    let later = candidates[0];
    for (const c of candidates) {
      if (compareMonth(c, earlier) < 0) earlier = c;
      if (compareMonth(c, later) > 0) later = c;
    }
    const p: { source?: string; limit?: number; from?: string; to?: string } = {
      limit: 5000,
      from: monthFirstISO(earlier),
      to: monthLastISO(later),
    };
    if (sourceFilter && sourceFilter !== "all") p.source = sourceFilter;
    return p;
  }, [sourceFilter, selectedMonth, currentMonth]);

  const { data: txns, isLoading } = useListTransactions(queryParams);
  const { data: categories } = useListCategories();
  const { data: debts } = useListDebts();
  const updateTx = useUpdateTransaction();
  const weeklyLabels = useWeeklyBucketLabels();

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // All visible Amex/source-filtered txns (server-filtered).
  const all = txns ?? [];

  // Members from server-returned set so the dropdown reflects current source.
  const members = useMemo(() => {
    const s = new Set<string>();
    for (const t of all) if (t.member) s.add(t.member);
    return Array.from(s).sort();
  }, [all]);

  // Restrict to the selected calendar month before any other client-side
  // filtering. The From/To inputs further narrow within the month.
  const monthScoped = useMemo(() => {
    return all.filter((t) => {
      const mk = monthKeyFromISO(t.occurredOn);
      return compareMonth(mk, selectedMonth) === 0;
    });
  }, [all, selectedMonth]);

  // Apply client-side filters.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return monthScoped.filter((t) => {
      const k = t.occurredOn.slice(0, 10);
      if (from && k < from) return false;
      if (to && k > to) return false;
      if (memberFilter !== "all" && (t.member ?? "") !== memberFilter)
        return false;
      if (categoryFilter !== "all") {
        if (categoryFilter === "uncategorized") {
          if (t.categoryId) return false;
        } else if (t.categoryId !== categoryFilter) return false;
      }
      if (q) {
        const hay = `${t.description} ${categoryById.get(t.categoryId ?? "") ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [monthScoped, search, memberFilter, categoryFilter, categoryById, from, to]);

  // Group by day (descending).
  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of filtered) {
      const k = t.occurredOn.slice(0, 10);
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  // Per-month totals: split by sign of `amount`. Charges are positive
  // (expenses on the card), payments/credits are negative.
  const monthTotals = useMemo(() => {
    let charges = 0;
    let paymentsAndCredits = 0;
    for (const t of filtered) {
      const a = parseSigned(t.amount);
      if (a >= 0) charges += a;
      else paymentsAndCredits += a; // negative
    }
    const netChange = charges + paymentsAndCredits; // charges - |payments|
    return { charges, paymentsAndCredits, netChange };
  }, [filtered]);

  // Net change per month for the entire visible (source-filtered) set —
  // used to roll the latest known account balance backward/forward to give
  // each month a consistent ending balance.
  const netChangeByMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of all) {
      const mk = monthKeyFromISO(t.occurredOn);
      const k = `${mk.year}-${mk.month}`;
      m.set(k, (m.get(k) ?? 0) + parseSigned(t.amount));
    }
    return m;
  }, [all]);

  // Distinct Plaid account IDs present on the Amex-source transactions.
  // These identify the actual Amex card account(s) feeding this page.
  const amexPlaidAccountIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of all) {
      if (t.plaidAccountId) s.add(t.plaidAccountId);
    }
    return s;
  }, [all]);

  // Find the linked Amex debt (if any) for the anchor balance. Prefer
  // matching by the Plaid account that actually feeds this page's
  // transactions so renaming the debt doesn't break the link. Fall back
  // to the legacy name regex when no Plaid link exists on either side.
  const amexDebt = useMemo(() => {
    if (!debts) return null;
    if (amexPlaidAccountIds.size > 0) {
      const byAccount = debts.find(
        (d) => d.plaidAccountId && amexPlaidAccountIds.has(d.plaidAccountId),
      );
      if (byAccount) return byAccount;
    }
    return (
      debts.find((d) => /amex|american\s*express/i.test(d.name)) ?? null
    );
  }, [debts, amexPlaidAccountIds]);

  const endingBalance = useMemo(() => {
    if (!amexDebt) {
      // No linked Amex debt — we have no opening-balance anchor and the
      // server query is scoped, so we can't honestly compute a running
      // sum here. Fail loudly in the UI rather than show a misleading
      // number.
      return { value: null as number | null, source: "missing" as const };
    }
    const anchor = parseSigned(amexDebt.balance);
    const cmp = compareMonth(selectedMonth, currentMonth);
    if (cmp === 0) return { value: anchor, source: "debt" as const };
    let bal = anchor;
    if (cmp < 0) {
      // Past month: undo every month after selectedMonth, up to and
      // including currentMonth (those net changes happened after the end
      // of the selected month).
      let cursor = currentMonth;
      while (compareMonth(cursor, selectedMonth) > 0) {
        const k = `${cursor.year}-${cursor.month}`;
        bal -= netChangeByMonth.get(k) ?? 0;
        cursor = shiftMonth(cursor, -1);
      }
    } else {
      // Future month: add net change for every month strictly after
      // currentMonth, up to and including selectedMonth.
      let cursor = shiftMonth(currentMonth, 1);
      while (compareMonth(cursor, selectedMonth) <= 0) {
        const k = `${cursor.year}-${cursor.month}`;
        bal += netChangeByMonth.get(k) ?? 0;
        cursor = shiftMonth(cursor, 1);
      }
    }
    return { value: bal, source: "debt" as const };
  }, [amexDebt, netChangeByMonth, selectedMonth, currentMonth]);

  // Trailing 12-month ending-balance series, anchored at the current
  // month's known Amex debt balance and rolled month-by-month using the
  // same net-change math as `endingBalance` above.
  const balanceTrend = useMemo<TrendPoint[]>(() => {
    if (!amexDebt) return [];
    const anchor = parseSigned(amexDebt.balance);
    // Compute the ending balance for any given month by rolling from the
    // currentMonth anchor.
    const balanceAt = (mk: MonthKey): number => {
      const cmp = compareMonth(mk, currentMonth);
      if (cmp === 0) return anchor;
      let bal = anchor;
      if (cmp < 0) {
        let cursor = currentMonth;
        while (compareMonth(cursor, mk) > 0) {
          const k = `${cursor.year}-${cursor.month}`;
          bal -= netChangeByMonth.get(k) ?? 0;
          cursor = shiftMonth(cursor, -1);
        }
      } else {
        let cursor = shiftMonth(currentMonth, 1);
        while (compareMonth(cursor, mk) <= 0) {
          const k = `${cursor.year}-${cursor.month}`;
          bal += netChangeByMonth.get(k) ?? 0;
          cursor = shiftMonth(cursor, 1);
        }
      }
      return bal;
    };
    const points: TrendPoint[] = [];
    for (let i = 11; i >= 0; i--) {
      const mk = shiftMonth(selectedMonth, -i);
      const d = new Date(mk.year, mk.month, 1);
      points.push({
        key: `${mk.year}-${mk.month}`,
        label: d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        shortLabel: d.toLocaleDateString("en-US", { month: "short" }),
        balance: balanceAt(mk),
        isSelected: compareMonth(mk, selectedMonth) === 0,
      });
    }
    return points;
  }, [amexDebt, netChangeByMonth, selectedMonth, currentMonth]);

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleDay = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());
  useEffect(() => {
    // Drop selections that are no longer visible.
    setSelected((prev) => {
      const visible = new Set(filtered.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filtered]);

  const invalidateTxns = () =>
    qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });

  const monthStartOf = (occurredOn: string): string =>
    `${occurredOn.slice(0, 7)}-01`;

  const invalidateBudgetMonths = (monthStarts: Iterable<string>) => {
    const seen = new Set<string>();
    for (const m of monthStarts) {
      if (seen.has(m)) continue;
      seen.add(m);
      qc.invalidateQueries({ queryKey: getGetBudgetMonthQueryKey(m) });
    }
  };

  const setRowCategory = async (
    id: string,
    categoryId: string | null,
    rememberPattern?: string | null,
  ) => {
    const tx = all.find((t) => t.id === id);
    try {
      await updateTx.mutateAsync({
        id,
        data: {
          categoryId,
          ...(rememberPattern ? { rememberPattern } : {}),
        },
      });
      invalidateTxns();
      if (tx) invalidateBudgetMonths([monthStartOf(tx.occurredOn)]);
      if (rememberPattern && categoryId) {
        toast({
          title: "Categorized & remembered",
          description: `Future "${rememberPattern}" will auto-categorize.`,
        });
      }
    } catch (e) {
      toast({
        title: "Couldn't update category",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const setRowBucket = async (
    t: Transaction,
    bucket: "" | "weekly" | "monthly" | "unplanned",
    weeklyBucket?: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] | null,
  ) => {
    let wb: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] | null | undefined = null;
    if (bucket === "weekly") {
      wb =
        weeklyBucket ??
        t.weeklyBucket ??
        defaultWeeklyBucketFor(categoryById.get(t.categoryId ?? "") ?? "");
    }
    try {
      await updateTx.mutateAsync({
        id: t.id,
        data: {
          weeklyAllowance: bucket === "weekly",
          monthlyAllowance: bucket === "monthly",
          unplannedAllowance: bucket === "unplanned",
          weeklyBucket: wb,
        },
      });
      invalidateTxns();
    } catch (e) {
      toast({
        title: "Couldn't update bucket",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const setRowReimbursable = async (t: Transaction, next: boolean) => {
    try {
      await updateTx.mutateAsync({
        id: t.id,
        data: { reimbursable: next, ...(next ? {} : { reimbursed: false }) },
      });
      invalidateTxns();
    } catch (e) {
      toast({
        title: "Couldn't update reimbursable",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const setRowOwedBy = async (t: Transaction, raw: string) => {
    const trimmed = raw.trim();
    const next: string | null = trimmed.length === 0 ? null : trimmed;
    if ((t.owedBy ?? null) === next) return;
    try {
      await updateTx.mutateAsync({ id: t.id, data: { owedBy: next } });
      invalidateTxns();
    } catch (e) {
      toast({
        title: "Couldn't update owed by",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const onBubbleToggle = (t: Transaction, bucket: BucketKey, next: boolean) => {
    if (bucket === "reimbursable") {
      setRowReimbursable(t, next);
      return;
    }
    if (next) {
      setRowBucket(t, bucket);
    } else {
      // Toggling off — only clear if this bubble was the active bucket.
      if (currentBucket(t) === bucket) setRowBucket(t, "");
    }
  };

  const setRowSource = async (id: string, source: string) => {
    try {
      await updateTx.mutateAsync({ id, data: { source } });
      invalidateTxns();
    } catch (e) {
      toast({
        title: "Couldn't update source",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const bulkSetBucket = async (
    bucket: "" | "weekly" | "monthly" | "unplanned",
    weeklyBucket?: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket],
  ) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(filtered.map((t) => [t.id, t] as const));
    const CONCURRENCY = 6;
    const results: { id: string; ok: boolean; err?: string }[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        const t = byId.get(id);
        if (!t) {
          results.push({ id, ok: false, err: "missing" });
          continue;
        }
        let wb: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] | null = null;
        if (bucket === "weekly") {
          wb =
            weeklyBucket ??
            t.weeklyBucket ??
            defaultWeeklyBucketFor(categoryById.get(t.categoryId ?? "") ?? "");
        }
        try {
          await updateTx.mutateAsync({
            id,
            data: {
              weeklyAllowance: bucket === "weekly",
              monthlyAllowance: bucket === "monthly",
              unplannedAllowance: bucket === "unplanned",
              weeklyBucket: wb,
            },
          });
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, err: (e as Error).message });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
    );
    invalidateTxns();
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      toast({ title: `Tagged ${okCount} transaction${okCount === 1 ? "" : "s"}` });
    } else {
      toast({
        title: `Tagged ${okCount}, ${failed.length} failed`,
        description: failed[0].err,
        variant: "destructive",
      });
    }
  };

  const bulkSetCategory = async (categoryId: string | null) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(all.map((t) => [t.id, t] as const));
    const CONCURRENCY = 6;
    const results: { id: string; ok: boolean; err?: string }[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        try {
          await updateTx.mutateAsync({ id, data: { categoryId } });
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, err: (e as Error).message });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
    );
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
    const failed = results.filter((r) => !r.ok);
    invalidateTxns();
    invalidateBudgetMonths(
      Array.from(okIds)
        .map((id) => byId.get(id)?.occurredOn)
        .filter((d): d is string => !!d)
        .map(monthStartOf),
    );
    setSelected((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (!okIds.has(id)) next.add(id);
      return next;
    });
    if (failed.length === 0) {
      toast({
        title: `Updated ${okIds.size} transaction${okIds.size === 1 ? "" : "s"}`,
      });
    } else {
      toast({
        title: `Updated ${okIds.size}, ${failed.length} failed`,
        description: failed[0].err,
        variant: "destructive",
      });
    }
  };

  // Smooth scroll to today on first load.
  const todayRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || isLoading) return;
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      scrolledRef.current = true;
    }
  }, [isLoading, groups.length]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const todayKey = ymd(new Date());

  return (
    <div className="space-y-6">
      <AccountPageHeader
        title="American Express"
        subtitle="Day-by-day card spending — categorized into your budget."
        icon={<CreditCard className="h-7 w-7 text-blue-600" />}
        actions={<PlaidLinkButton label="Connect a card" />}
      />

      <BalanceTrendChart
        caption="Ending balance · trailing 12 months"
        data={balanceTrend}
        color="#2563eb"
        valueLabel="Ending balance"
      />

      <div className="flex items-stretch gap-4 flex-wrap">
        <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1 min-w-[280px]">
          {endingBalance.source === "missing" ? (
            <StatChipUnavailable
              label="Ending balance"
              hint="Link an Amex debt in Debts to see the balance."
              testId="stat-ending-balance"
            />
          ) : (
            <StatChip
              label="Ending balance"
              value={endingBalance.value ?? 0}
              accent="bg-blue-50 text-blue-900 border-blue-200"
              testId="stat-ending-balance"
            />
          )}
          <StatChip
            label="Charges"
            value={monthTotals.charges}
            testId="stat-charges"
          />
          <StatChip
            label="Payments & credits"
            value={Math.abs(monthTotals.paymentsAndCredits)}
            valueClassName="text-emerald-700"
            testId="stat-payments-credits"
          />
          <StatChip
            label="Net change"
            value={monthTotals.netChange}
            valueClassName={
              monthTotals.netChange > 0
                ? "text-rose-700"
                : monthTotals.netChange < 0
                  ? "text-emerald-700"
                  : undefined
            }
            signed
            testId="stat-net-change"
          />
        </div>
      </div>

      <AccountFilterBar
        search={search}
        onSearchChange={setSearch}
        from={from}
        onFromChange={setFrom}
        to={to}
        onToChange={setTo}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
        sourceOptions={[
          { value: AMEX_SOURCE, label: "amex" },
          { value: "manual", label: "manual" },
          { value: "import", label: "import" },
          { value: "all", label: "All sources" },
        ]}
        categoryFilter={categoryFilter}
        onCategoryFilterChange={setCategoryFilter}
        categories={categories ?? []}
        members={members}
        memberFilter={memberFilter}
        onMemberFilterChange={setMemberFilter}
        rightSlot={
          <div className="text-xs text-muted-foreground ml-auto" data-testid="text-row-count">
            {filtered.length} of {monthScoped.length} txns
          </div>
        }
      />

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-20 flex items-center gap-3 rounded-md border border-blue-300 bg-blue-50 px-4 py-2 shadow-sm">
          <span className="text-sm font-medium text-blue-900">
            {selected.size} selected
          </span>
          <BulkCategoryPicker
            categories={categories ?? []}
            onPick={bulkSetCategory}
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-blue-900 mr-1">Bucket:</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("")}>
              —
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("weekly")}>
              Weekly
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("monthly")}>
              Monthly
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("unplanned")}>
              Unplanned
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={clearSelection} className="ml-auto">
            Clear
          </Button>
        </div>
      )}
      {/* Day groups */}
      {groups.length === 0 && (
        <Card><CardContent className="p-8 text-center text-muted-foreground">
          No transactions match these filters.
        </CardContent></Card>
      )}
      {groups.map(([dayKey, items]) => {
        const dayTotal = items.reduce((s, t) => s + parseAbs(t.amount), 0);
        const ids = items.map((t) => t.id);
        const allSelected = ids.every((id) => selected.has(id));
        const someSelected = !allSelected && ids.some((id) => selected.has(id));
        const isToday = dayKey === todayKey;
        return (
          <DayGroup
            key={dayKey}
            dayKey={dayKey}
            count={items.length}
            isToday={isToday}
            todayAccent="blue"
            containerRef={(el) => {
              if (isToday) todayRef.current = el;
            }}
            selectionState={allSelected ? true : someSelected ? "indeterminate" : false}
            onToggleAll={(on) => toggleDay(ids, on)}
            totalNode={formatCurrency(dayTotal)}
          >
                <table className="w-full text-sm">
                  <tbody>
                    {items.map((t) => (
                      <tr key={t.id} className="border-t hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2 w-8">
                          <Checkbox
                            checked={selected.has(t.id)}
                            onCheckedChange={() => toggleOne(t.id)}
                            aria-label="Select"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium truncate max-w-[420px]" title={t.description}>
                            {t.description}
                          </div>
                          {t.notes && (
                            <div className="text-[11px] text-muted-foreground truncate" title={t.notes}>
                              {t.notes}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {t.member ?? "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Input
                            key={t.owedBy ?? ""}
                            defaultValue={t.owedBy ?? ""}
                            placeholder="Owed by…"
                            aria-label={`Owed by for ${t.description}`}
                            className="h-7 w-32 text-xs"
                            onBlur={(e) => {
                              if ((e.currentTarget.value.trim() || null) !== (t.owedBy ?? null)) {
                                setRowOwedBy(t, e.currentTarget.value);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                (e.currentTarget as HTMLInputElement).blur();
                              } else if (e.key === "Escape") {
                                (e.currentTarget as HTMLInputElement).value = t.owedBy ?? "";
                                (e.currentTarget as HTMLInputElement).blur();
                              }
                            }}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <CategoryPicker
                            value={t.categoryId ?? null}
                            categories={categories ?? []}
                            description={t.description}
                            onChange={(id, remember) =>
                              setRowCategory(t.id, id, remember)
                            }
                          />
                          {t.isTransfer && (
                            <Badge
                              variant="outline"
                              className="mt-1 text-[10px] border-slate-300 text-slate-700 bg-slate-50"
                              title="Excluded from budget actuals"
                              data-testid={`badge-transfer-${t.id}`}
                            >
                              Transfer
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            value={t.source}
                            onValueChange={(v) => setRowSource(t.id, v)}
                          >
                            <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={AMEX_SOURCE}>amex</SelectItem>
                              <SelectItem value="manual">manual</SelectItem>
                              <SelectItem value="import">import</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <BucketBubbles
                              flags={{
                                weekly: t.weeklyAllowance,
                                monthly: t.monthlyAllowance,
                                unplanned: t.unplannedAllowance,
                                reimbursable: t.reimbursable,
                              }}
                              onToggle={(b, next) => onBubbleToggle(t, b, next)}
                            />
                            {t.weeklyAllowance && (
                              <Select
                                value={t.weeklyBucket ?? TransactionWeeklyBucket.misc}
                                onValueChange={(v) =>
                                  setRowBucket(t, "weekly", v as typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket])
                                }
                              >
                                <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={TransactionWeeklyBucket.groceries}>{weeklyLabels.groceries}</SelectItem>
                                  <SelectItem value={TransactionWeeklyBucket.dining}>{weeklyLabels.dining}</SelectItem>
                                  <SelectItem value={TransactionWeeklyBucket.entertainment}>{weeklyLabels.entertainment}</SelectItem>
                                  <SelectItem value={TransactionWeeklyBucket.misc}>{weeklyLabels.misc}</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatCurrency(parseAbs(t.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          </DayGroup>
        );
      })}
    </div>
  );
}

function BulkCategoryPicker({
  categories,
  onPick,
}: {
  categories: { id: string; name: string }[];
  onPick: (categoryId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
          Set category
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              <CommandItem onSelect={() => { onPick(null); setOpen(false); }}>
                Uncategorized
              </CommandItem>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  onSelect={() => {
                    onPick(c.id);
                    setOpen(false);
                  }}
                >
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

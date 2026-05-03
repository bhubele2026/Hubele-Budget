import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListTransactions,
  useCreateTransaction,
  useUpdateTransaction,
  useDeleteTransaction,
  useListCategories,
  useGetForecast,
  useRefreshForecastBank,
  useSeedAprilChase,
  getListTransactionsQueryKey,
  getGetForecastQueryKey,
  getGetBudgetMonthQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Edit2,
  Trash2,
  Send,
  Inbox,
  Wand2,
  Landmark,
  RefreshCw,
} from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
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
  type MonthKey,
  type TrendPoint,
} from "@/components/account-page";

const formSchema = z.object({
  occurredOn: z.string().min(1, "Date is required"),
  description: z.string().min(1, "Description is required"),
  amount: z.string().min(1, "Amount is required"),
  kind: z.enum(["expense", "income"]).default("expense"),
  weeklyAllowance: z.boolean().default(false),
  monthlyAllowance: z.boolean().default(false),
  unplannedAllowance: z.boolean().default(false),
  reimbursable: z.boolean().default(false),
  reimbursed: z.boolean().default(false),
});

type FormValues = z.infer<typeof formSchema>;

function normalizeAmount(raw: string, kind: "expense" | "income"): string {
  const num = Math.abs(parseFloat(raw));
  if (Number.isNaN(num)) return raw;
  return (kind === "income" ? num : -num).toFixed(2);
}

function parseSigned(amount: string | number): number {
  return Number(amount) || 0;
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function TransactionsPage() {
  const { data: transactions, isLoading } = useListTransactions({ limit: 5000 });
  const { data: categories } = useListCategories();
  const { data: forecastData } = useGetForecast();
  const refreshBank = useRefreshForecastBank();
  const seedAprilChase = useSeedAprilChase();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // One-shot seed of the user's April 2026 Chase activity. Idempotent on the
  // server (skips rows whose plaid_transaction_id already exists), so it's
  // safe to fire on every initial mount.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (isLoading) return;
    seededRef.current = true;
    seedAprilChase.mutate(undefined, {
      onSuccess: (res) => {
        if (res.inserted > 0 || res.rulesAdded > 0) {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          queryClient.invalidateQueries({
            queryKey: getGetBudgetMonthQueryKey("2026-04-01"),
          });
          if (res.inserted > 0) {
            toast({
              title: `Loaded ${res.inserted} April Chase transactions`,
              description: `Ending balance ${formatCurrency(res.endingBalance)}`,
            });
          }
        }
      },
      onError: (e) => {
        // Non-fatal — page still renders whatever the user already has.
        // eslint-disable-next-line no-console
        console.warn("April Chase seed failed:", (e as Error).message);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const bankSnapshot = forecastData?.bankSnapshot ?? null;
  const chasePlaidAccountId = useMemo(() => {
    if (!bankSnapshot?.accountId) return null;
    const acct = (forecastData?.plaidCheckingAccounts ?? []).find(
      (a) => a.id === bankSnapshot.accountId,
    );
    return acct?.accountId ?? null;
  }, [bankSnapshot?.accountId, forecastData?.plaidCheckingAccounts]);

  // Scope to the linked checking account (or manual rows when nothing linked).
  const chaseTransactions = useMemo(() => {
    const all = transactions ?? [];
    if (chasePlaidAccountId) {
      return all.filter((t) => t.plaidAccountId === chasePlaidAccountId);
    }
    return all.filter((t) => !t.plaidAccountId);
  }, [transactions, chasePlaidAccountId]);

  // ---- Filters & month navigation ----
  const currentMonth = useMemo<MonthKey>(() => monthKeyOf(new Date()), []);
  const [selectedMonth, setSelectedMonth] = useState<MonthKey>(currentMonth);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const sourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of chaseTransactions) if (t.source) set.add(t.source);
    return [
      { value: "all", label: "All sources" },
      ...Array.from(set)
        .sort()
        .map((s) => ({ value: s, label: s })),
    ];
  }, [chaseTransactions]);

  const members = useMemo(() => {
    const s = new Set<string>();
    for (const t of chaseTransactions) if (t.member) s.add(t.member);
    return Array.from(s).sort();
  }, [chaseTransactions]);

  const monthScoped = useMemo(() => {
    return chaseTransactions.filter((t) => {
      const mk = monthKeyFromISO(t.occurredOn);
      return compareMonth(mk, selectedMonth) === 0;
    });
  }, [chaseTransactions, selectedMonth]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return monthScoped.filter((t) => {
      const k = t.occurredOn.slice(0, 10);
      if (from && k < from) return false;
      if (to && k > to) return false;
      if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
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
  }, [monthScoped, search, from, to, sourceFilter, memberFilter, categoryFilter, categoryById]);

  // ---- Per-month money in/out & balance math ----
  const monthTotals = useMemo(() => {
    let moneyIn = 0;
    let moneyOut = 0;
    for (const t of filtered) {
      const a = parseSigned(t.amount);
      if (a >= 0) moneyIn += a;
      else moneyOut += a; // negative
    }
    const netChange = moneyIn + moneyOut;
    return { moneyIn, moneyOut: Math.abs(moneyOut), netChange };
  }, [filtered]);

  // Net change per month for the entire scoped set (for rolling balance).
  const netChangeByMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of chaseTransactions) {
      const mk = monthKeyFromISO(t.occurredOn);
      const k = `${mk.year}-${mk.month}`;
      m.set(k, (m.get(k) ?? 0) + parseSigned(t.amount));
    }
    return m;
  }, [chaseTransactions]);

  const anchorBalance = bankSnapshot ? Number(bankSnapshot.balance) || 0 : null;

  const balanceAtEndOf = useMemo(() => {
    return (mk: MonthKey): number | null => {
      if (anchorBalance === null) return null;
      const cmp = compareMonth(mk, currentMonth);
      if (cmp === 0) return anchorBalance;
      let bal = anchorBalance;
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
  }, [anchorBalance, currentMonth, netChangeByMonth]);

  const endingBalance = useMemo(
    () => balanceAtEndOf(selectedMonth),
    [balanceAtEndOf, selectedMonth],
  );
  const startingBalance = useMemo(
    () => balanceAtEndOf(shiftMonth(selectedMonth, -1)),
    [balanceAtEndOf, selectedMonth],
  );

  const balanceTrend = useMemo<TrendPoint[]>(() => {
    if (anchorBalance === null) return [];
    const points: TrendPoint[] = [];
    for (let i = 11; i >= 0; i--) {
      const mk = shiftMonth(selectedMonth, -i);
      const d = new Date(mk.year, mk.month, 1);
      points.push({
        key: `${mk.year}-${mk.month}`,
        label: d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        shortLabel: d.toLocaleDateString("en-US", { month: "short" }),
        balance: balanceAtEndOf(mk) ?? 0,
        isSelected: compareMonth(mk, selectedMonth) === 0,
      });
    }
    return points;
  }, [anchorBalance, balanceAtEndOf, selectedMonth]);

  // ---- Day grouping ----
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

  // ---- Mutations & dialog ----
  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const deleteTx = useDeleteTransaction();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      occurredOn: new Date().toISOString().split("T")[0],
      description: "",
      amount: "",
      kind: "expense",
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reimbursable: false,
      reimbursed: false,
    },
  });

  const handleOpenNew = () => {
    setEditingTx(null);
    form.reset({
      occurredOn: new Date().toISOString().split("T")[0],
      description: "",
      amount: "",
      kind: "expense",
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reimbursable: false,
      reimbursed: false,
    });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (tx: Transaction) => {
    setEditingTx(tx);
    const numeric = parseFloat(tx.amount);
    form.reset({
      occurredOn: tx.occurredOn.split("T")[0],
      description: tx.description,
      amount: Math.abs(numeric).toFixed(2),
      kind: numeric >= 0 ? "income" : "expense",
      weeklyAllowance: tx.weeklyAllowance,
      monthlyAllowance: tx.monthlyAllowance,
      unplannedAllowance: tx.unplannedAllowance,
      reimbursable: tx.reimbursable,
      reimbursed: tx.reimbursed,
    });
    setIsDialogOpen(true);
  };

  const onSubmit = (values: FormValues) => {
    const { kind, ...rest } = values;
    const payload = { ...rest, amount: normalizeAmount(values.amount, kind) };
    if (editingTx) {
      updateTx.mutate(
        { id: editingTx.id, data: payload },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            setIsDialogOpen(false);
            toast({ title: "Transaction updated" });
          },
        },
      );
    } else {
      createTx.mutate(
        { data: payload },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            setIsDialogOpen(false);
            toast({ title: "Transaction created" });
          },
        },
      );
    }
  };

  const handleDelete = (id: string) => {
    if (confirm("Delete this transaction?")) {
      deleteTx.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            toast({ title: "Transaction deleted" });
          },
        },
      );
    }
  };

  const handleToggleForecast = (tx: Transaction) => {
    const next = !tx.forecastFlag;
    if (next && !tx.categoryId) {
      toast({
        title: "Categorize this transaction first",
        description: "Pick a category before sending it to Forecast.",
        variant: "destructive",
      });
      return;
    }
    updateTx.mutate(
      { id: tx.id, data: { forecastFlag: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          toast({ title: next ? "Sent to Forecast" : "Removed from Forecast" });
        },
      },
    );
  };

  const handleQuickCategorize = async (tx: Transaction, categoryId: string) => {
    try {
      await updateTx.mutateAsync({ id: tx.id, data: { categoryId } });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetBudgetMonthQueryKey(`${tx.occurredOn.slice(0, 7)}-01`),
      });
      toast({
        title: "Categorized",
        description: "Future similar transactions will auto-categorize.",
      });
    } catch (e) {
      toast({
        title: "Couldn't categorize",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleRefreshBank = () => {
    refreshBank.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        toast({ title: "Refreshed from Plaid" });
      },
      onError: (e) => {
        toast({
          title: "Couldn't refresh",
          description: (e as Error).message,
          variant: "destructive",
        });
      },
    });
  };

  // ---- Bulk selection ----
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

  const bulkSetForecast = async (next: boolean) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(filtered.map((t) => [t.id, t] as const));
    const candidates = ids
      .map((id) => byId.get(id))
      .filter((t): t is Transaction => !!t && t.forecastFlag !== next);
    const targets = next
      ? candidates.filter((t) => !!t.categoryId)
      : candidates;
    const skippedUncat = next ? candidates.length - targets.length : 0;
    if (!targets.length) {
      toast({
        title: next
          ? skippedUncat > 0
            ? "Categorize these first to send them to Forecast"
            : "Selected items already in Forecast"
          : "Selected items not in Forecast",
      });
      return;
    }
    const CONCURRENCY = 6;
    let cursor = 0;
    let okCount = 0;
    const failures: string[] = [];
    const worker = async () => {
      while (cursor < targets.length) {
        const i = cursor++;
        const id = targets[i].id;
        try {
          await updateTx.mutateAsync({ id, data: { forecastFlag: next } });
          okCount += 1;
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker),
    );
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    clearSelection();
    if (!failures.length) {
      const suffix = skippedUncat > 0 ? ` · ${skippedUncat} skipped (uncategorized)` : "";
      toast({
        title: next
          ? `Sent ${okCount} to Forecast${suffix}`
          : `Removed ${okCount} from Forecast`,
      });
    } else {
      toast({
        title: `${okCount} updated, ${failures.length} failed`,
        description: failures[0],
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

  // Measure the pinned top pane so day-group headers (and the bulk bar)
  // can stick directly beneath it via a CSS variable.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneH, setPaneH] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPaneH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLoading]);

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
  const hasLinkedChecking = !!bankSnapshot;
  const isPlaidLinked = bankSnapshot?.source === "plaid";

  return (
    <div
      className="space-y-6"
      style={{ ["--pinned-pane-h" as string]: `${paneH}px` } as React.CSSProperties}
    >
      <div
        ref={paneRef}
        className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-4 md:pt-8 pb-4 bg-background border-b shadow-sm space-y-4"
      >
      <AccountPageHeader
        title="Chase"
        subtitle="Your checking activity, day by day."
        icon={<Landmark className="h-7 w-7 text-primary" />}
        accentBorderClass="border-primary"
        actions={
          <>
            {isPlaidLinked && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshBank}
                disabled={refreshBank.isPending}
                data-testid="button-refresh-bank"
              >
                <RefreshCw
                  className={cn(
                    "w-4 h-4 mr-1.5",
                    refreshBank.isPending && "animate-spin",
                  )}
                />
                Refresh from Plaid
              </Button>
            )}
            <Button onClick={handleOpenNew} variant="outline" size="sm" data-testid="button-add-transaction">
              <Plus className="w-4 h-4 mr-1.5" /> Add transaction
            </Button>
            <PlaidLinkButton label="Connect a bank" />
          </>
        }
      />

      <div className="flex items-stretch gap-4 flex-wrap">
        <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 flex-1 min-w-[280px]">
          {hasLinkedChecking ? (
            <StatChip
              label="Starting balance"
              value={startingBalance ?? 0}
              testId="stat-starting-balance"
            />
          ) : (
            <StatChipUnavailable
              label="Starting balance"
              hint="Connect a checking account to see the balance."
              testId="stat-starting-balance"
            />
          )}
          <StatChip
            label="Money in"
            value={monthTotals.moneyIn}
            valueClassName="text-emerald-700"
            testId="stat-money-in"
          />
          <StatChip
            label="Money out"
            value={monthTotals.moneyOut}
            valueClassName="text-rose-700"
            testId="stat-money-out"
          />
          {hasLinkedChecking ? (
            <StatChip
              label="Ending balance"
              value={endingBalance ?? 0}
              accent="bg-emerald-50 text-emerald-900 border-emerald-200"
              testId="stat-ending-balance"
            />
          ) : (
            <StatChipUnavailable
              label="Ending balance"
              hint="Connect a checking account to see the balance."
              testId="stat-ending-balance"
            />
          )}
          <StatChip
            label="Net change"
            value={monthTotals.netChange}
            valueClassName={
              monthTotals.netChange > 0
                ? "text-emerald-700"
                : monthTotals.netChange < 0
                  ? "text-rose-700"
                  : undefined
            }
            signed
            testId="stat-net-change"
          />
        </div>
      </div>

      {bankSnapshot && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="text-snapshot-meta"
        >
          {bankSnapshot.source === "plaid" ? "Plaid" : "Manual"} ·{" "}
          {bankSnapshot.name ?? "Checking"}
          {bankSnapshot.mask ? ` ••${bankSnapshot.mask}` : ""} · Updated{" "}
          {formatDate(bankSnapshot.at.slice(0, 10))} · Current balance{" "}
          {formatCurrency(bankSnapshot.balance)}
        </div>
      )}

      <AccountFilterBar
        search={search}
        onSearchChange={setSearch}
        from={from}
        onFromChange={setFrom}
        to={to}
        onToChange={setTo}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
        sourceOptions={sourceOptions}
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
      </div>

      <BalanceTrendChart
        caption="Checking balance · trailing 12 months"
        data={balanceTrend}
        color="hsl(var(--chart-1))"
        valueLabel="Ending balance"
      />

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{editingTx ? "Edit Transaction" : "New Transaction"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="occurredOn" render={({ field }) => (
                <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Input placeholder="Trader Joe's" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-3 gap-3">
                <FormField control={form.control} name="kind" render={({ field }) => (
                  <FormItem className="col-span-1"><FormLabel>Kind</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="expense">Expense</SelectItem>
                        <SelectItem value="income">Income</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Amount</FormLabel><FormControl><Input type="number" step="0.01" min="0" placeholder="42.50" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="reimbursable" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursable</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="reimbursed" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursed</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="weeklyAllowance" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Weekly Allow</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="monthlyAllowance" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Monthly Allow</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="unplannedAllowance" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Unplanned Allow</FormLabel></FormItem>
                )} />
              </div>
              <div className="flex justify-end pt-4">
                <Button type="submit" disabled={createTx.isPending || updateTx.isPending}>Save</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {selected.size > 0 && (
        <div
          className="sticky z-20 flex items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 shadow-sm"
          style={{ top: "var(--pinned-pane-h, 0px)" }}
          data-testid="bulk-bar"
        >
          <span className="text-sm font-medium text-emerald-900">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            onClick={() => bulkSetForecast(true)}
            disabled={updateTx.isPending}
            data-testid="bulk-send-forecast"
          >
            <Send className="w-3.5 h-3.5 mr-1.5" /> Send to Forecast
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => bulkSetForecast(false)}
            disabled={updateTx.isPending}
            data-testid="bulk-remove-forecast"
          >
            Remove from Forecast
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection} className="ml-auto">
            Clear
          </Button>
        </div>
      )}

      {groups.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No transactions match these filters.
          </CardContent>
        </Card>
      )}

      {groups.map(([dayKey, items]) => {
        const ids = items.map((t) => t.id);
        const allSelected = ids.every((id) => selected.has(id));
        const someSelected = !allSelected && ids.some((id) => selected.has(id));
        const isToday = dayKey === todayKey;
        const dayNet = items.reduce((s, t) => s + parseSigned(t.amount), 0);
        const dayNetNode = (
          <span
            className={cn(
              "tabular-nums",
              dayNet > 0 && "text-emerald-700",
              dayNet < 0 && "text-rose-700",
            )}
            data-testid={`day-net-${dayKey}`}
          >
            {dayNet > 0 ? `+${formatCurrency(dayNet)}` : formatCurrency(dayNet)}
          </span>
        );
        return (
          <DayGroup
            key={dayKey}
            dayKey={dayKey}
            count={items.length}
            isToday={isToday}
            todayAccent="emerald"
            containerRef={(el) => {
              if (isToday) todayRef.current = el;
            }}
            selectionState={
              allSelected ? true : someSelected ? "indeterminate" : false
            }
            onToggleAll={(on) => toggleDay(ids, on)}
            totalNode={dayNetNode}
          >
            <div className="divide-y divide-border">
              {items.map((tx) => (
                <div
                  key={tx.id}
                  className={cn(
                    "p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-muted/30 transition-colors",
                    tx.forecastFlag && "opacity-60 bg-muted/20",
                  )}
                  data-testid={`row-tx-${tx.id}`}
                  data-sent={tx.forecastFlag ? "true" : "false"}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <Checkbox
                      checked={selected.has(tx.id)}
                      onCheckedChange={() => toggleOne(tx.id)}
                      aria-label="Select"
                      className="mt-1"
                      data-testid={`select-${tx.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-medium text-foreground truncate">
                          {tx.description}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {tx.source}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {tx.categoryId && categoryById.get(tx.categoryId) && (
                          <Badge variant="outline" className="text-xs border-violet-200 text-violet-700 bg-violet-50">
                            {categoryById.get(tx.categoryId)}
                          </Badge>
                        )}
                        {!tx.categoryId && !tx.isTransfer && (
                          <CategorizeChip
                            tx={tx}
                            categories={categories ?? []}
                            onPick={(catId) => handleQuickCategorize(tx, catId)}
                          />
                        )}
                        {tx.isTransfer && (
                          <Badge
                            variant="outline"
                            className="text-xs border-slate-300 text-slate-700 bg-slate-50"
                            data-testid={`badge-transfer-${tx.id}`}
                          >
                            Transfer
                          </Badge>
                        )}
                        {tx.forecastFlag && (
                          <Badge
                            variant="outline"
                            className="text-xs border-emerald-200 text-emerald-700 bg-emerald-50"
                            data-testid={`badge-sent-${tx.id}`}
                          >
                            <Inbox className="w-3 h-3 mr-1" /> Sent · pending in Forecast
                          </Badge>
                        )}
                        {tx.weeklyAllowance && <Badge variant="outline" className="text-xs border-blue-200 text-blue-700 bg-blue-50">Weekly</Badge>}
                        {tx.monthlyAllowance && <Badge variant="outline" className="text-xs border-indigo-200 text-indigo-700 bg-indigo-50">Monthly</Badge>}
                        {tx.unplannedAllowance && <Badge variant="outline" className="text-xs border-amber-200 text-amber-700 bg-amber-50">Unplanned</Badge>}
                        {tx.reimbursable && <Badge variant="outline" className="text-xs border-orange-200 text-orange-700 bg-orange-50">Reimbursable</Badge>}
                        {tx.reimbursed && <Badge variant="outline" className="text-xs border-green-200 text-green-700 bg-green-50">Reimbursed</Badge>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-end">
                      <span
                        className={cn(
                          "font-medium tabular-nums whitespace-nowrap",
                          parseSigned(tx.amount) > 0 && "text-emerald-700",
                          parseSigned(tx.amount) < 0 && "text-foreground",
                        )}
                      >
                        {formatCurrency(tx.amount)}
                      </span>
                    </div>
                    <div className="flex gap-1 items-center">
                      {tx.forecastFlag ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleToggleForecast(tx)}
                          disabled={updateTx.isPending}
                          title="Remove from Forecast"
                          data-testid={`button-remove-forecast-${tx.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          Remove
                        </Button>
                      ) : tx.categoryId ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleToggleForecast(tx)}
                          disabled={updateTx.isPending}
                          title="Send to Forecast"
                          data-testid={`button-send-forecast-${tx.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          Send
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled
                          title="Categorize this transaction first"
                          data-testid={`button-send-forecast-${tx.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          Categorize first
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(tx)}>
                        <Edit2 className="w-4 h-4 text-muted-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(tx.id)}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </DayGroup>
        );
      })}
    </div>
  );
}

// Keyword → list of category-name substrings to surface as suggestions when a
// transaction is uncategorized. The first existing category whose name matches
// any of the substrings (case-insensitive) wins. Designed to cover the
// debt-bearing April Chase rows (Synchrony, Chase autopay, Upstart, Dept of
// Education) plus a handful of common merchants.
const SUGGESTION_RULES: { match: string[]; targets: string[] }[] = [
  { match: ["synchrony"], targets: ["Synchrony", "Ashley", "Mattress", "PayPal Credit", "Misc / Buffer"] },
  { match: ["upstart"], targets: ["Upstart", "Misc / Buffer"] },
  { match: ["chase credit", "chase autopay"], targets: ["Chase Sapphire", "Chase Freedom", "Chase", "Misc / Buffer"] },
  { match: ["dept education", "dept of ed", "nelnet"], targets: ["Student Loan", "Nelnet", "Dept of Ed", "Misc / Buffer"] },
  { match: ["intuit"], targets: ["Intuit", "Misc / Buffer"] },
  { match: ["affirm"], targets: ["Affirm", "Misc / Buffer"] },
  { match: ["american express", "amex"], targets: ["American Express", "Amex", "Misc / Buffer"] },
  { match: ["discover"], targets: ["Discover", "Misc / Buffer"] },
  { match: ["capital one"], targets: ["Capital One", "Misc / Buffer"] },
  { match: ["paymthly", "pypl paymthly", "paypal credit"], targets: ["PayPal Credit", "Synchrony", "Misc / Buffer"] },
  { match: ["applecard", "apple card"], targets: ["Apple Card", "Misc / Buffer"] },
  { match: ["credit one"], targets: ["Credit One", "Misc / Buffer"] },
  { match: ["figure"], targets: ["Figure", "HELOC", "Misc / Buffer"] },
  { match: ["uw credit union"], targets: ["Hannah", "Car Payments", "Misc / Buffer"] },
  { match: ["toyota"], targets: ["Toyota", "Car Payments"] },
  { match: ["lakeview"], targets: ["Mortgage", "Lakeview"] },
  { match: ["madison gas", "city of madison"], targets: ["Utilities", "MGE"] },
  { match: ["verizon"], targets: ["Phone", "Utilities", "Verizon"] },
  { match: ["state farm"], targets: ["Insurance", "State Farm"] },
  { match: ["trustage"], targets: ["Insurance", "TruStage"] },
  { match: ["metro market", "costco", "walmart"], targets: ["Groceries", "Shopping"] },
  { match: ["kwik trip"], targets: ["Gas", "Transportation"] },
  { match: ["starbucks", "dunkin", "doordash", "mooyah"], targets: ["Dining", "Coffee", "Restaurants"] },
  { match: ["paypal purchase", "stitchfix", "aldo", "shen zhen", "brghtwhl"], targets: ["Shopping"] },
  { match: ["paramount", "adobe", "ancestry", "playstation", "nintendo"], targets: ["Subscriptions"] },
];

function suggestCategories(
  description: string,
  categories: { id: string; name: string }[],
): { id: string; name: string }[] {
  const hay = (description ?? "").toLowerCase();
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const rule of SUGGESTION_RULES) {
    if (!rule.match.some((m) => hay.includes(m))) continue;
    for (const target of rule.targets) {
      const needle = target.toLowerCase();
      const hit = categories.find(
        (c) => c.name.toLowerCase().includes(needle) && !seen.has(c.id),
      );
      if (hit) {
        out.push(hit);
        seen.add(hit.id);
        if (out.length >= 3) return out;
      }
    }
  }
  return out;
}

function CategorizeChip({
  tx,
  categories,
  onPick,
}: {
  tx: Transaction;
  categories: { id: string; name: string }[];
  onPick: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(
    () => suggestCategories(tx.description, categories),
    [tx.description, categories],
  );
  const top = suggestions[0];
  if (top) {
    return (
      <span className="inline-flex items-center gap-1">
        <Badge
          variant="outline"
          className="cursor-pointer text-xs border-violet-300 text-violet-700 bg-violet-50 hover:bg-violet-100"
          onClick={() => onPick(top.id)}
          title="Categorize and remember this merchant"
          data-testid={`badge-suggest-${tx.id}`}
        >
          <Wand2 className="w-3 h-3 mr-1" /> Categorize as {top.name}
        </Badge>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Badge
              variant="outline"
              className="cursor-pointer text-xs border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
              data-testid={`badge-uncategorized-${tx.id}`}
            >
              Other…
            </Badge>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search category…" />
              <CommandList>
                <CommandEmpty>No category</CommandEmpty>
                {suggestions.length > 1 && (
                  <CommandGroup heading="Suggested">
                    {suggestions.slice(1).map((c) => (
                      <CommandItem
                        key={`s-${c.id}`}
                        onSelect={() => {
                          onPick(c.id);
                          setOpen(false);
                        }}
                      >
                        {c.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandGroup heading="All categories">
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
              <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
                Picking a category will remember this merchant.
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          className="cursor-pointer text-xs border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
          data-testid={`badge-uncategorized-${tx.id}`}
        >
          <Wand2 className="w-3 h-3 mr-1" /> Categorize
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search category…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
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
          <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
            Picking a category will remember this merchant.
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

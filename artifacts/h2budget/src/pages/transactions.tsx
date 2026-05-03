import { useEffect, useMemo, useRef, useState } from "react";
import { useListTransactions, useCreateTransaction, useUpdateTransaction, useDeleteTransaction, useListCategories, useGetForecast, useRefreshForecastBank, useSeedAprilChase, getListTransactionsQueryKey, getGetForecastQueryKey, getGetBudgetMonthQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Edit2, Trash2, Send, Inbox, Wand2, Landmark, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import type { Transaction } from "@workspace/api-client-react";
import { computeRunningBalances } from "@/lib/runningBalance";

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

const MIN_MONTH = "2026-04-01";

function thisMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function addMonths(monthStart: string, offset: number): string {
  const d = new Date(monthStart + "T00:00:00");
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function endOfMonth(monthStart: string): string {
  const next = addMonths(monthStart, 1);
  const d = new Date(next + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TransactionsPage() {
  const { data: transactions, isLoading } = useListTransactions({ limit: 5000 });
  const { data: categories } = useListCategories();
  const { data: forecastData } = useGetForecast();
  const refreshBank = useRefreshForecastBank();
  const seedAprilChase = useSeedAprilChase();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [currentMonth, setCurrentMonth] = useState(() => {
    const tm = thisMonthStart();
    return tm < MIN_MONTH ? MIN_MONTH : tm;
  });
  const atFloor = currentMonth <= MIN_MONTH;
  const changeMonth = (offset: number) => {
    const next = addMonths(currentMonth, offset);
    setCurrentMonth(next < MIN_MONTH ? MIN_MONTH : next);
  };
  const monthName = useMemo(() => {
    const d = new Date(currentMonth + "T00:00:00");
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(d);
  }, [currentMonth]);
  const monthEnd = useMemo(() => endOfMonth(currentMonth), [currentMonth]);

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
  // Resolve the linked Chase checking account: bankSnapshot.accountId is the
  // internal plaid_accounts UUID; cross-ref it to the Plaid account_id text
  // that lives on transactionsTable.plaidAccountId.
  const chasePlaidAccountId = useMemo(() => {
    if (!bankSnapshot?.accountId) return null;
    const acct = (forecastData?.plaidCheckingAccounts ?? []).find(
      (a) => a.id === bankSnapshot.accountId,
    );
    return acct?.accountId ?? null;
  }, [bankSnapshot?.accountId, forecastData?.plaidCheckingAccounts]);

  // Scope the Chase page strictly to the linked checking account so the
  // running balance reconciles to bankSnapshot. When nothing is linked yet
  // (manual snapshot or no snapshot at all), fall back to manual rows so
  // the page still has something to show.
  const chaseTransactions = useMemo(() => {
    const all = transactions ?? [];
    const inMonth = (t: Transaction) =>
      t.occurredOn >= currentMonth && t.occurredOn <= monthEnd;
    if (chasePlaidAccountId) {
      return all.filter(
        (t) => t.plaidAccountId === chasePlaidAccountId && inMonth(t),
      );
    }
    return all.filter((t) => !t.plaidAccountId && inMonth(t));
  }, [transactions, chasePlaidAccountId, currentMonth, monthEnd]);

  const runningBalances = useMemo(() => {
    if (!bankSnapshot) return new Map<string, number>();
    return computeRunningBalances(
      chaseTransactions,
      Number(bankSnapshot.balance) || 0,
    );
  }, [chaseTransactions, bankSnapshot]);

  const handleRefreshBank = () => {
    refreshBank.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
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

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const deleteTx = useDeleteTransaction();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      occurredOn: new Date().toISOString().split('T')[0],
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
      occurredOn: new Date().toISOString().split('T')[0],
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
      occurredOn: tx.occurredOn.split('T')[0],
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
      updateTx.mutate({ id: editingTx.id, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          setIsDialogOpen(false);
          toast({ title: "Transaction updated" });
        }
      });
    } else {
      createTx.mutate({ data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          setIsDialogOpen(false);
          toast({ title: "Transaction created" });
        }
      });
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

  const handleQuickCategorize = async (
    tx: Transaction,
    categoryId: string,
  ) => {
    try {
      await updateTx.mutateAsync({
        id: tx.id,
        data: { categoryId },
      });
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

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visibleIds = useMemo(
    () => new Set(chaseTransactions.map((t) => t.id)),
    [chaseTransactions],
  );
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleIds]);
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(visibleIds) : new Set());
  const clearSelection = () => setSelected(new Set());

  const bulkSetForecast = async (next: boolean) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(chaseTransactions.map((t) => [t.id, t] as const));
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

  const handleDelete = (id: string) => {
    if (confirm("Delete this transaction?")) {
      deleteTx.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          toast({ title: "Transaction deleted" });
        }
      });
    }
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Chase</h1>
          <p className="text-muted-foreground mt-1">Your checking activity, reconciled.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-card px-3 py-1.5 rounded-md shadow-sm border border-border">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => changeMonth(-1)}
              disabled={atFloor}
              aria-disabled={atFloor}
              title={atFloor ? "April 2026 is the earliest month" : undefined}
              data-testid="button-prev-month"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span
              className="font-medium text-sm w-32 text-center"
              data-testid="text-current-month"
            >
              {monthName}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => changeMonth(1)}
              data-testid="button-next-month"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
          <Button onClick={handleOpenNew}><Plus className="w-4 h-4 mr-2" /> Add Transaction</Button>
        </div>
      </div>

      <Card data-testid="card-chase-balance">
        <CardHeader className="pb-2 flex-row items-center justify-between">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <Landmark className="w-4 h-4" /> Chase checking balance
          </CardTitle>
          {bankSnapshot && bankSnapshot.source === "plaid" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={handleRefreshBank}
              disabled={refreshBank.isPending}
              title="Refresh from Plaid"
              data-testid="button-refresh-bank"
            >
              <RefreshCw className={`w-4 h-4 ${refreshBank.isPending ? "animate-spin" : ""}`} />
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="text-2xl font-bold tabular-nums" data-testid="text-chase-balance">
            {bankSnapshot ? formatCurrency(bankSnapshot.balance) : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {bankSnapshot ? (
              <>
                {bankSnapshot.source === "plaid" ? "Plaid" : "Manual"} ·{" "}
                {bankSnapshot.name ?? "Checking"}
                {bankSnapshot.mask ? ` ••${bankSnapshot.mask}` : ""} ·{" "}
                Updated {formatDate(bankSnapshot.at.slice(0, 10))}
              </>
            ) : (
              <>Link a Chase checking account on the Forecast page to see a live balance.</>
            )}
          </div>
        </CardContent>
      </Card>

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
          className="sticky top-0 z-20 flex items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 shadow-sm"
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

      <Card>
        <CardContent className="p-0">
          {chaseTransactions.length > 0 && (
            <div className="px-4 py-2 flex items-center gap-3 border-b bg-muted/30 text-xs text-muted-foreground">
              <Checkbox
                checked={
                  visibleIds.size > 0 && selected.size === visibleIds.size
                    ? true
                    : selected.size > 0
                      ? "indeterminate"
                      : false
                }
                onCheckedChange={(v) => toggleAll(!!v)}
                aria-label="Select all"
                data-testid="select-all"
              />
              <span>Select all on page</span>
            </div>
          )}
          <div className="divide-y divide-border">
            {chaseTransactions.map((tx) => (
              <div
                key={tx.id}
                className={`p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-muted/50 transition-colors ${tx.forecastFlag ? "opacity-60 bg-muted/30" : ""}`}
                data-testid={`row-tx-${tx.id}`}
                data-sent={tx.forecastFlag ? "true" : "false"}
              >
                <div className="flex items-start gap-3 flex-1">
                  <Checkbox
                    checked={selected.has(tx.id)}
                    onCheckedChange={() => toggleOne(tx.id)}
                    aria-label="Select"
                    className="mt-1"
                    data-testid={`select-${tx.id}`}
                  />
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-foreground">{tx.description}</span>
                    <span className="text-sm text-muted-foreground">{formatDate(tx.occurredOn)}</span>
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
                        title="Excluded from budget actuals"
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
                <div className="flex items-center gap-4">
                  <div className="flex flex-col items-end">
                    <span className="font-medium text-foreground whitespace-nowrap tabular-nums">{formatCurrency(tx.amount)}</span>
                    {runningBalances.has(tx.id) && (
                      <span
                        className="text-xs text-muted-foreground tabular-nums"
                        data-testid={`text-running-balance-${tx.id}`}
                        title="Running balance after this transaction"
                      >
                        Bal {formatCurrency(runningBalances.get(tx.id)!)}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2 items-center">
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
                        Remove from Forecast
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
                        Send to Forecast
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
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(tx)}><Edit2 className="w-4 h-4 text-muted-foreground" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(tx.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                  </div>
                </div>
              </div>
            ))}
            {chaseTransactions.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">No transactions found.</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
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

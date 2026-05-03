import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListTransactions,
  useUpdateTransaction,
  useListCategories,
  getListTransactionsQueryKey,
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
import { Search, Check, ChevronsUpDown, CreditCard } from "lucide-react";
import { TransactionWeeklyBucket } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, cn } from "@/lib/utils";
import { useWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";

const AMEX_SOURCE = "amex";

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function startOfMonth(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(1);
  return x;
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function parseAbs(amount: string) {
  return Math.abs(parseFloat(amount) || 0);
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

function formatDayHeader(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

  const queryParams = useMemo(() => {
    const p: { from?: string; to?: string; source?: string; limit?: number } = {
      limit: 1000,
    };
    if (from) p.from = from;
    if (to) p.to = to;
    if (sourceFilter && sourceFilter !== "all") p.source = sourceFilter;
    return p;
  }, [from, to, sourceFilter]);

  const { data: txns, isLoading } = useListTransactions(queryParams);
  const { data: categories } = useListCategories();
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

  // Apply client-side filters.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((t) => {
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
  }, [all, search, memberFilter, categoryFilter, categoryById]);

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

  // Top totals (across visible/filtered set).
  const totals = useMemo(() => {
    const today = new Date();
    const weekStart = startOfWeek(today);
    const monthStart = startOfMonth(today);
    const todayKey = ymd(today);
    const weekKey = ymd(weekStart);
    const monthKey = ymd(monthStart);
    let day = 0,
      week = 0,
      month = 0,
      shown = 0;
    for (const t of filtered) {
      const a = parseAbs(t.amount);
      shown += a;
      const k = t.occurredOn.slice(0, 10);
      if (k === todayKey) day += a;
      if (k >= weekKey) week += a;
      if (k >= monthKey) month += a;
    }
    return { day, week, month, shown };
  }, [filtered]);

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

  const setRowCategory = async (id: string, categoryId: string | null) => {
    try {
      await updateTx.mutateAsync({ id, data: { categoryId } });
      invalidateTxns();
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
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap border-l-4 border-blue-600 pl-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground flex items-center gap-2">
            <CreditCard className="h-7 w-7 text-blue-600" /> Amex Daily
          </h1>
          <p className="text-muted-foreground mt-1">
            Day-by-day card spending — categorized into your budget.
          </p>
        </div>
      </div>

      {/* Stat chips */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatChip label="Today" value={totals.day} accent="bg-blue-50 text-blue-900 border-blue-200" />
        <StatChip label="This week" value={totals.week} accent="bg-blue-50 text-blue-900 border-blue-200" />
        <StatChip label="This month" value={totals.month} accent="bg-blue-50 text-blue-900 border-blue-200" />
        <StatChip label="Shown" value={totals.shown} />
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search description or category…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Source</label>
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AMEX_SOURCE}>amex</SelectItem>
                <SelectItem value="manual">manual</SelectItem>
                <SelectItem value="import">import</SelectItem>
                <SelectItem value="all">All sources</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Category</label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                <SelectItem value="uncategorized">Uncategorized</SelectItem>
                {(categories ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {members.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Member</label>
              <Select value={memberFilter} onValueChange={setMemberFilter}>
                <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All members</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="text-xs text-muted-foreground ml-auto">
            {filtered.length} of {all.length} txns
          </div>
        </CardContent>
      </Card>

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
          <div
            key={dayKey}
            ref={isToday ? todayRef : undefined}
            className="space-y-2"
          >
            <div className={cn(
              "sticky top-0 z-10 flex items-center justify-between gap-3 rounded-md border bg-background/95 backdrop-blur px-3 py-2",
              isToday && "border-blue-300 bg-blue-50/80",
            )}>
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(v) => toggleDay(ids, !!v)}
                  aria-label="Select day"
                />
                <div className="font-semibold text-sm">{formatDayHeader(dayKey)}</div>
                {isToday && (
                  <Badge variant="outline" className="text-[10px] border-blue-300 text-blue-700 bg-blue-50">
                    Today
                  </Badge>
                )}
                <Badge variant="secondary" className="text-[10px]">
                  {items.length} txn{items.length === 1 ? "" : "s"}
                </Badge>
              </div>
              <div className="text-sm font-mono tabular-nums font-semibold">
                {formatCurrency(dayTotal)}
              </div>
            </div>
            <Card>
              <CardContent className="p-0">
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
                            onChange={(id) => setRowCategory(t.id, id)}
                          />
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
              </CardContent>
            </Card>
          </div>
        );
      })}
    </div>
  );
}

function StatChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <div className={cn("rounded-md border px-3 py-2", accent ?? "bg-card")}>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="font-mono tabular-nums font-semibold text-base">
        {formatCurrency(value)}
      </div>
    </div>
  );
}

function CategoryPicker({
  value,
  categories,
  onChange,
}: {
  value: string | null;
  categories: { id: string; name: string }[];
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = value
    ? categories.find((c) => c.id === value)?.name ?? "Unknown"
    : "Uncategorized";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="h-7 text-xs w-52 justify-between font-normal"
        >
          <span className="truncate">{current}</span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-3 w-3", value === null ? "opacity-100" : "opacity-0")}
                />
                Uncategorized
              </CommandItem>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  onSelect={() => {
                    onChange(c.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-3 w-3", value === c.id ? "opacity-100" : "opacity-0")}
                  />
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

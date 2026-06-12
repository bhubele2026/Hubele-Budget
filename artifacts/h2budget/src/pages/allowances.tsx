import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Pencil } from "lucide-react";
import {
  useListTransactions,
  useGetSettings,
  useListCategories,
  useGetWeeklyDebrief,
  useUpdateTransaction,
  useUpdateSettings,
  getListTransactionsQueryKey,
  getGetSettingsQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, cn } from "@/lib/utils";
import {
  SUB_BUCKETS,
  type SubBucket,
  useWeeklyBucketLabels,
} from "@/lib/weeklyBuckets";

// ----- date helpers ---------------------------------------------------

function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function sundayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function lastOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function daysInMonthOf(d: Date): number {
  return lastOfMonth(d).getDate();
}
function formatWeekRange(sun: Date): string {
  const sat = addDays(sun, 6);
  const sameMonth = sun.getMonth() === sat.getMonth();
  const left = sun.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const right = sat.toLocaleDateString("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
  });
  return `${left} – ${right}, ${sat.getFullYear()}`;
}
function formatMonth(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function formatTxnDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Spend convention matches the rest of the app: charges are stored as a
// negative `amount`; this returns the positive spend magnitude (and 0 for
// credits/refunds), exactly like the Dashboard's `expenseAmount`.
function expenseAmount(t: Transaction): number {
  const a = Number(t.amount) || 0;
  return a < 0 ? -a : 0;
}

// ----- bucket config --------------------------------------------------

type BucketKey = "weekly" | "monthly" | "unplanned";
type Mode = "week" | "month";

const BUCKETS: { key: BucketKey; name: string; noun: string }[] = [
  { key: "weekly", name: "Weekly allowance", noun: "weekly allowance" },
  { key: "monthly", name: "Monthly allowance", noun: "monthly allowance" },
  { key: "unplanned", name: "Unplanned allowance", noun: "unplanned allowance" },
];

function hasBucketFlag(t: Transaction, key: BucketKey): boolean {
  if (key === "weekly") return !!t.weeklyAllowance;
  if (key === "monthly") return !!t.monthlyAllowance;
  return !!t.unplannedAllowance;
}

type Group = {
  key: string;
  label: string;
  amount: number;
  txns: Transaction[];
};

// ----- drill-down rows ------------------------------------------------

function TxnRow({
  t,
  subLabels,
  onChangeBucket,
}: {
  t: Transaction;
  subLabels?: Record<SubBucket, string>;
  onChangeBucket?: (t: Transaction, sub: SubBucket) => void;
}) {
  const current: SubBucket = SUB_BUCKETS.includes(t.weeklyBucket as SubBucket)
    ? (t.weeklyBucket as SubBucket)
    : "misc";
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-1.5 pl-9 text-sm"
      data-testid={`allowance-txn-${t.id}`}
    >
      <div className="flex items-baseline gap-3 min-w-0">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground w-12 shrink-0 tabular-nums">
          {formatTxnDate(t.occurredOn)}
        </span>
        <span className="truncate">{t.description}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {onChangeBucket && subLabels && (
          <Select
            value={current}
            onValueChange={(v) => onChangeBucket(t, v as SubBucket)}
          >
            <SelectTrigger
              className="h-7 w-[120px] text-xs"
              aria-label="Allowance bucket"
              data-testid={`allowance-bucket-select-${t.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUB_BUCKETS.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {subLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="tabular-nums whitespace-nowrap font-mono">
          {formatCurrency(expenseAmount(t))}
        </span>
      </div>
    </div>
  );
}

function CategoryGroupRow({
  group,
  subLabels,
  onChangeBucket,
}: {
  group: Group;
  subLabels?: Record<SubBucket, string>;
  onChangeBucket?: (t: Transaction, sub: SubBucket) => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable = group.txns.length > 0;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild disabled={!expandable}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-sm focus:outline-none",
            expandable ? "hover:bg-muted/50 cursor-pointer" : "cursor-default",
          )}
          data-testid={`allowance-group-${group.key}`}
        >
          <span className="flex min-w-0 items-center gap-1 font-medium">
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform",
                open ? "" : "-rotate-90",
                !expandable && "opacity-0",
              )}
            />
            <span className="truncate">{group.label}</span>
            <span className="text-[11px] text-muted-foreground">
              ({group.txns.length})
            </span>
          </span>
          <span className="tabular-nums whitespace-nowrap">
            {formatCurrency(group.amount)}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {group.txns.map((t) => (
          <TxnRow
            key={t.id}
            t={t}
            subLabels={subLabels}
            onChangeBucket={onChangeBucket}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ----- bucket summary card --------------------------------------------

function BucketCard({
  name,
  actual,
  planned,
  expanded,
  onToggle,
  onSavePlanned,
}: {
  name: string;
  actual: number;
  planned: number;
  expanded: boolean;
  onToggle: () => void;
  onSavePlanned?: (amount: number) => void;
}) {
  const variance = actual - planned;
  const over = variance > 0;
  const pct = planned > 0 ? Math.min(100, (actual / planned) * 100) : 0;
  const slug = name.split(" ")[0].toLowerCase();
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const save = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0) {
      onSavePlanned?.(Math.round(n * 100) / 100);
      setEditOpen(false);
    }
  };
  return (
    <Card className={cn("transition-colors", expanded && "ring-2 ring-primary/40")}>
      <CardContent className="p-5 space-y-3">
        {/* Header + actual are the expand toggle. The planned line below
            stays outside the button so the edit popover isn't nested in it. */}
        <button
          type="button"
          onClick={onToggle}
          className="w-full text-left focus:outline-none"
          data-testid={`allowance-card-${slug}`}
          aria-expanded={expanded}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              {name}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                expanded ? "" : "-rotate-90",
              )}
            />
          </div>
          <div className="text-3xl font-bold tracking-tight tabular-nums mt-2">
            {formatCurrency(actual)}
          </div>
        </button>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <span>of {formatCurrency(planned)} planned</span>
          {onSavePlanned && (
            <Popover
              open={editOpen}
              onOpenChange={(o) => {
                setEditOpen(o);
                if (o) setDraft(planned > 0 ? planned.toFixed(2) : "");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-foreground"
                  title="Edit planned amount"
                  data-testid={`allowance-edit-planned-${slug}`}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-3" align="start">
                <div className="space-y-2">
                  <div className="text-xs font-medium">
                    Planned {name.toLowerCase()}
                  </div>
                  <Input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        save();
                      }
                    }}
                    placeholder="450.00"
                    autoFocus
                    data-testid={`input-planned-${slug}`}
                  />
                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={save} disabled={!draft.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <Progress value={pct} className={over ? "[&>div]:bg-destructive" : ""} />
        <div
          className={cn(
            "text-sm font-medium tabular-nums",
            over ? "text-destructive" : "text-emerald-700",
          )}
          data-testid={`allowance-variance-${slug}`}
        >
          {planned <= 0
            ? "No allowance set"
            : over
              ? `${formatCurrency(variance)} over`
              : `${formatCurrency(Math.abs(variance))} under`}
        </div>
      </CardContent>
    </Card>
  );
}

// ----- page -----------------------------------------------------------

export default function AllowancesPage() {
  const today = useMemo(() => new Date(), []);
  const [mode, setMode] = useState<Mode>("week");
  const [weekStart, setWeekStart] = useState<Date>(() => sundayOf(new Date()));
  const [monthStart, setMonthStart] = useState<Date>(() =>
    firstOfMonth(new Date()),
  );

  const currentWeekStart = useMemo(() => sundayOf(today), [today]);
  const currentMonthStart = useMemo(() => firstOfMonth(today), [today]);

  // Window for the selected period.
  const { windowStart, windowEnd, windowDays, windowStartDate, isCurrent } =
    useMemo(() => {
      if (mode === "week") {
        return {
          windowStart: fmtISO(weekStart),
          windowEnd: fmtISO(addDays(weekStart, 6)),
          windowDays: 7,
          windowStartDate: weekStart,
          isCurrent: fmtISO(weekStart) === fmtISO(currentWeekStart),
        };
      }
      return {
        windowStart: fmtISO(firstOfMonth(monthStart)),
        windowEnd: fmtISO(lastOfMonth(monthStart)),
        windowDays: daysInMonthOf(monthStart),
        windowStartDate: firstOfMonth(monthStart),
        isCurrent: fmtISO(monthStart) === fmtISO(currentMonthStart),
      };
    }, [mode, weekStart, monthStart, currentWeekStart, currentMonthStart]);

  const atOrAfterCurrent =
    mode === "week"
      ? weekStart >= currentWeekStart
      : monthStart >= currentMonthStart;

  const goPrev = () => {
    if (mode === "week") setWeekStart((w) => addDays(w, -7));
    else setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  };
  const goNext = () => {
    if (atOrAfterCurrent) return;
    if (mode === "week") setWeekStart((w) => addDays(w, 7));
    else setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
  };

  const { data: settings } = useGetSettings();
  const { data: categories } = useListCategories();
  const SUB_LABEL = useWeeklyBucketLabels();
  const updateTx = useUpdateTransaction();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateSettings = useUpdateSettings();

  // Edit a bucket's PLANNED allowance amount inline (the "of $X planned"
  // line). PATCHes the matching settings field.
  const savePlanned = async (key: BucketKey, amount: number) => {
    const val = amount.toFixed(2);
    const data =
      key === "weekly"
        ? { weeklyAllowanceAmount: val }
        : key === "monthly"
          ? { monthlyAllowanceAmount: val }
          : { unplannedAllowanceAmount: val };
    try {
      await updateSettings.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      toast({ title: "Allowance updated" });
    } catch (e) {
      toast({
        title: "Couldn't update",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Move a transaction between the weekly sub-buckets (Groceries / Dining /
  // Entertainment / Misc) straight from the breakdown.
  const changeWeeklyBucket = async (t: Transaction, sub: SubBucket) => {
    const current = SUB_BUCKETS.includes(t.weeklyBucket as SubBucket)
      ? (t.weeklyBucket as SubBucket)
      : "misc";
    if (current === sub) return;
    try {
      await updateTx.mutateAsync({ id: t.id, data: { weeklyBucket: sub } });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({ title: `Moved to ${SUB_LABEL[sub]}` });
    } catch (e) {
      toast({
        title: "Couldn't move",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const txnsQ = useListTransactions({
    from: windowStart,
    to: windowEnd,
    limit: 5000,
  });
  const txns = txnsQ.data ?? [];

  // (#spec) A locked weekly debrief freezes that week's transactions, so a
  // live recompute equals the locked snapshot's numbers. We surface a
  // "Locked" badge when the debrief for this week is locked. Only relevant
  // in WEEK mode.
  const weekStartISO = fmtISO(weekStart);
  const debriefQ = useGetWeeklyDebrief(weekStartISO, {
    query: { enabled: mode === "week" } as any,
  });
  const isLocked = mode === "week" && debriefQ.data?.status === "locked";

  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // Planned allowance for the window. Each allowance is held at its native
  // cadence (weekly vs monthly) and pro-rated by day count to the selected
  // window, so a weekly card in WEEK mode reads the raw weekly allowance and
  // a monthly card in MONTH mode reads the raw monthly allowance, while
  // cross-cadence views (e.g. monthly allowance scoped to one week) get a
  // fair, deterministic slice. Monthly-cadence allowances are summed per day
  // using each day's own month length, so a week straddling a month boundary
  // is prorated exactly across both months.
  const planned = useMemo<Record<BucketKey, number>>(() => {
    const weeklyAmt = Number(settings?.weeklyAllowanceAmount) || 0;
    const monthlyAmt = Number(settings?.monthlyAllowanceAmount) || 0;
    const unplannedAmt = Number(settings?.unplannedAllowanceAmount) || 0;
    let monthly = 0;
    let unplanned = 0;
    for (let i = 0; i < windowDays; i++) {
      const d = addDays(windowStartDate, i);
      const dimD = daysInMonthOf(d);
      monthly += monthlyAmt / dimD;
      unplanned += unplannedAmt / dimD;
    }
    return {
      weekly: (weeklyAmt / 7) * windowDays,
      monthly,
      unplanned,
    };
  }, [settings, windowStartDate, windowDays]);

  // Window-scoped transactions split per bucket.
  const windowTxns = useMemo(
    () =>
      txns.filter(
        (t) => t.occurredOn >= windowStart && t.occurredOn <= windowEnd,
      ),
    [txns, windowStart, windowEnd],
  );

  const actual = useMemo(() => {
    const out: Record<BucketKey, number> = {
      weekly: 0,
      monthly: 0,
      unplanned: 0,
    };
    for (const t of windowTxns) {
      const amt = expenseAmount(t);
      for (const b of BUCKETS) {
        if (hasBucketFlag(t, b.key)) out[b.key] += amt;
      }
    }
    return out;
  }, [windowTxns]);

  // Per-bucket drill-down groups. Weekly groups by its sub-bucket enum
  // (all four shown); monthly/unplanned group by category.
  const groupsByBucket = useMemo(() => {
    const result: Record<BucketKey, Group[]> = {
      weekly: [],
      monthly: [],
      unplanned: [],
    };

    // Weekly — fixed sub-buckets.
    const weeklyTxns = windowTxns.filter((t) => hasBucketFlag(t, "weekly"));
    result.weekly = SUB_BUCKETS.map((sub) => {
      const list = weeklyTxns
        .filter((t) => {
          const b = (t.weeklyBucket as SubBucket | null | undefined) ?? "misc";
          const resolved = SUB_BUCKETS.includes(b) ? b : "misc";
          return resolved === sub;
        })
        .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
      return {
        key: sub,
        label: SUB_LABEL[sub],
        amount: list.reduce((s, t) => s + expenseAmount(t), 0),
        txns: list,
      };
    });

    // Monthly / Unplanned — group by category.
    for (const key of ["monthly", "unplanned"] as const) {
      const buckets = new Map<string, Transaction[]>();
      for (const t of windowTxns) {
        if (!hasBucketFlag(t, key)) continue;
        const cid = t.categoryId ?? "_uncat";
        const arr = buckets.get(cid);
        if (arr) arr.push(t);
        else buckets.set(cid, [t]);
      }
      result[key] = Array.from(buckets.entries())
        .map(([cid, list]) => ({
          key: cid,
          label:
            cid === "_uncat"
              ? "Uncategorized"
              : catNameById.get(cid) ?? "Uncategorized",
          amount: list.reduce((s, t) => s + expenseAmount(t), 0),
          txns: list.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1)),
        }))
        .sort((a, b) => b.amount - a.amount);
    }

    return result;
  }, [windowTxns, SUB_LABEL, catNameById]);

  const [expanded, setExpanded] = useState<Set<BucketKey>>(new Set());
  const toggle = (key: BucketKey) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const periodLabel =
    mode === "week"
      ? isCurrent
        ? "This week"
        : `Week of ${formatWeekRange(weekStart)}`
      : isCurrent
        ? "This month"
        : formatMonth(monthStart);

  const rangeLabel =
    mode === "week"
      ? `Week of ${formatWeekRange(weekStart)}`
      : `Month of ${formatMonth(monthStart)}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Allowances
        </h1>
        <p className="text-muted-foreground">
          Weekly, monthly, and unplanned spend — reviewed.
        </p>
      </div>

      {/* Time-range selector */}
      <div className="flex flex-col items-center gap-3">
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList>
            <TabsTrigger value="week" data-testid="tab-week">
              Week
            </TabsTrigger>
            <TabsTrigger value="month" data-testid="tab-month">
              Month
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={goPrev}
            data-testid="button-period-prev"
            aria-label="Previous period"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex flex-col items-center text-center min-w-[12rem]">
            <div className="text-sm font-medium tabular-nums flex items-center gap-2">
              {rangeLabel}
              {isLocked && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-5"
                  data-testid="badge-locked"
                >
                  Locked
                </Badge>
              )}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {isCurrent ? `Current ${mode}` : `Past ${mode}`}
            </div>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={goNext}
            disabled={atOrAfterCurrent}
            data-testid="button-period-next"
            aria-label="Next period"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Bucket summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {BUCKETS.map((b) => (
          <BucketCard
            key={b.key}
            name={b.name}
            actual={actual[b.key]}
            planned={planned[b.key]}
            expanded={expanded.has(b.key)}
            onToggle={() => toggle(b.key)}
            onSavePlanned={(amount) => savePlanned(b.key, amount)}
          />
        ))}
      </div>

      {/* Drill-down breakdown — one collapsible group per bucket, driven by
          the card's expanded state. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Transaction breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {BUCKETS.map((b) => {
            const open = expanded.has(b.key);
            const groups = groupsByBucket[b.key];
            const total = actual[b.key];
            return (
              <Collapsible
                key={b.key}
                open={open}
                onOpenChange={() => toggle(b.key)}
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2 py-2 text-sm font-medium hover:bg-muted/50 rounded-md focus:outline-none"
                    data-testid={`allowance-bucket-${b.key}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 shrink-0 transition-transform",
                          open ? "" : "-rotate-90",
                        )}
                      />
                      {b.name}
                    </span>
                    <span className="tabular-nums">{formatCurrency(total)}</span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-l ml-4 pl-1 py-1">
                    {groups.length === 0 ||
                    groups.every((g) => g.txns.length === 0) ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No {b.noun} transactions in this {mode}.
                      </div>
                    ) : (
                      groups.map((g) => (
                        <CategoryGroupRow
                          key={g.key}
                          group={g}
                          subLabels={b.key === "weekly" ? SUB_LABEL : undefined}
                          onChangeBucket={
                            b.key === "weekly" ? changeWeeklyBucket : undefined
                          }
                        />
                      ))
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </CardContent>
      </Card>

      {/* Over/under summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Over/under summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {BUCKETS.map((b) => {
            const a = actual[b.key];
            const p = planned[b.key];
            const variance = a - p;
            let text: string;
            if (p <= 0) {
              text = `${periodLabel} you spent ${formatCurrency(a)} (no ${b.noun} set).`;
            } else if (variance === 0) {
              text = `${periodLabel} you spent exactly your ${formatCurrency(p)} ${b.noun}.`;
            } else if (variance < 0) {
              text = `${periodLabel} you came in ${formatCurrency(Math.abs(variance))} under your ${formatCurrency(p)} ${b.noun}.`;
            } else {
              text = `${periodLabel} you went ${formatCurrency(variance)} over your ${formatCurrency(p)} ${b.noun}.`;
            }
            return (
              <p
                key={b.key}
                className="text-sm text-muted-foreground"
                data-testid={`allowance-summary-${b.key}`}
              >
                {text}
              </p>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

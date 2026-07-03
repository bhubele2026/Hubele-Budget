import { useState, useMemo, useEffect } from "react";
import { useLocation, useSearch, Link } from "wouter";
import { useQueryClient, useQueries } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Lock,
  Unlock,
  Calendar as CalendarIcon,
  CheckCircle2,
  AlertCircle,
  RefreshCcw,
  X,
  Plus,
  Send,
  Loader2,
  Sparkles,
  MessageSquare,
  Flame,
  ArrowRight,
} from "lucide-react";
import {
  useListWeeklyDebriefs,
  useGetWeeklyDebrief,
  useLockWeeklyDebrief,
  useUnlockWeeklyDebrief,
  useGenerateWeeklyDebriefSummary,
  useUpsertForecastResolution,
  useCreateRecurringItem,
  useSendTransactionsToReview,
  useUpdateTransaction,
  useListTransactions,
  useListCategories,
  getGetWeeklyDebriefQueryKey,
  getGetWeeklyDebriefQueryOptions,
  getListWeeklyDebriefsQueryKey,
  getGetForecastQueryKey,
  getListTransactionsQueryKey,
  getListRecurringItemsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import type {
  WeeklyDebriefDetail,
  WeeklyDebriefListItem,
  WeeklyDebriefPlanItem,
  WeeklyDebriefTxnItem,
  WeeklyDebriefCategoryBucket,
  WeeklyDebriefSnapshot,
  WeeklyDebriefAdvisorSummary,
} from "@workspace/api-client-react";
import { openAdvisorChatWithContext } from "@/lib/advisorChatBridge";
import type { RecurringItemInput } from "@workspace/api-zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { CategoryPicker } from "@/components/category-picker";
import { SectionHeader } from "@/components/stat/section-header";
import { Callout } from "@/components/stat/callout";
import { StatTile, StatTileRow } from "@/components/stat-tile";
import { MiniBars, MoneyText, DeltaPill } from "@/components/viz";
import { cn } from "@/lib/utils";

// ----- date helpers ---------------------------------------------------

function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function parseISO(s: string): Date {
  // Treat YYYY-MM-DD as local midnight to avoid TZ drift on date math.
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDaysISO(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return fmtISO(d);
}
function weekStartFor(iso: string): string {
  // Sunday of the week containing iso.
  const d = parseISO(iso);
  const dow = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - dow);
  return fmtISO(d);
}
function monthKey(iso: string): string {
  return iso.slice(0, 7);
}
function monthLabel(monthIso: string): string {
  const [y, m] = monthIso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
}
function weekRangeLabel(weekStart: string, weekEnd: string): string {
  const s = parseISO(weekStart);
  const e = parseISO(weekEnd);
  const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const sameYear = s.getFullYear() === e.getFullYear();
  const left = s.toLocaleDateString(undefined, fmt);
  const right = e.toLocaleDateString(undefined, {
    ...fmt,
    year: sameYear ? undefined : "numeric",
  });
  return `${left} – ${right}, ${e.getFullYear()}`;
}
function shortWeekChipLabel(weekStart: string): string {
  const d = parseISO(weekStart);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ----- money helpers --------------------------------------------------

function money(n: number | string, opts: { signed?: boolean } = {}): string {
  const v = typeof n === "string" ? Number(n) : n;
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
  if (!opts.signed) return v < 0 ? `-${formatted}` : formatted;
  if (v > 0) return `+${formatted}`;
  if (v < 0) return `-${formatted}`;
  return formatted;
}

// (#M47) The "freed for the avalanche" figure lives on the snapshot's
// totals (computed server-side: max(0, actualIncome − actualExpenses −
// reserved weekly allowance)). The generated `WeeklyDebriefTotals` type
// predates this field, so read it defensively — fall back to deriving
// it from the cash-flow totals (no allowance reserved) when an older
// snapshot lacks it.
function freedForAvalanche(
  totals: WeeklyDebriefSnapshot["totals"],
): number {
  const raw = (totals as { freedForAvalanche?: string }).freedForAvalanche;
  if (raw != null) return Number(raw) || 0;
  return Math.max(
    0,
    Number(totals.actualIncome) - Number(totals.actualExpenses),
  );
}

// ----- aggregate view model -------------------------------------------
// One shape the graphics consume for BOTH a single week and a whole month.
// Every number is summed from the SAME precomputed snapshot(s) — no
// recompute of any financial figure, just addition across weeks (the
// byCategory arrays already sum exactly to totals, so a merge keeps the
// invariant intact).

type AggView = {
  plannedIncome: number;
  actualIncome: number;
  plannedExpenses: number;
  actualExpenses: number;
  plannedNet: number;
  actualNet: number;
  varianceNet: number;
  freed: number;
  byCategory: WeeklyDebriefCategoryBucket[];
};

function weekAggView(snap: WeeklyDebriefSnapshot): AggView {
  const t = snap.totals;
  return {
    plannedIncome: Number(t.plannedIncome),
    actualIncome: Number(t.actualIncome),
    plannedExpenses: Number(t.plannedExpenses),
    actualExpenses: Number(t.actualExpenses),
    plannedNet: Number(t.plannedNet),
    actualNet: Number(t.actualNet),
    varianceNet: Number(t.varianceNet),
    freed: freedForAvalanche(t),
    byCategory: snap.byCategory,
  };
}

function mergeByCategory(
  snaps: WeeklyDebriefSnapshot[],
): WeeklyDebriefCategoryBucket[] {
  const map = new Map<string, WeeklyDebriefCategoryBucket>();
  for (const s of snaps) {
    for (const b of s.byCategory) {
      const key = b.categoryId ?? "_uncat";
      const ex = map.get(key);
      if (!ex) {
        map.set(key, {
          categoryId: b.categoryId ?? null,
          plannedAmount: b.plannedAmount,
          actualAmount: b.actualAmount,
          varianceAmount: b.varianceAmount,
          plannedItems: [...b.plannedItems],
          actualTxns: [...b.actualTxns],
        });
      } else {
        ex.plannedAmount = String(
          Number(ex.plannedAmount) + Number(b.plannedAmount),
        );
        ex.actualAmount = String(
          Number(ex.actualAmount) + Number(b.actualAmount),
        );
        ex.varianceAmount = String(
          Number(ex.varianceAmount) + Number(b.varianceAmount),
        );
        ex.plannedItems = [...ex.plannedItems, ...b.plannedItems];
        ex.actualTxns = [...ex.actualTxns, ...b.actualTxns];
      }
    }
  }
  return [...map.values()];
}

function monthAggView(snaps: WeeklyDebriefSnapshot[]): AggView {
  const acc: AggView = {
    plannedIncome: 0,
    actualIncome: 0,
    plannedExpenses: 0,
    actualExpenses: 0,
    plannedNet: 0,
    actualNet: 0,
    varianceNet: 0,
    freed: 0,
    byCategory: [],
  };
  for (const s of snaps) {
    const t = s.totals;
    acc.plannedIncome += Number(t.plannedIncome);
    acc.actualIncome += Number(t.actualIncome);
    acc.plannedExpenses += Number(t.plannedExpenses);
    acc.actualExpenses += Number(t.actualExpenses);
    acc.plannedNet += Number(t.plannedNet);
    acc.actualNet += Number(t.actualNet);
    acc.varianceNet += Number(t.varianceNet);
    acc.freed += freedForAvalanche(t);
  }
  acc.byCategory = mergeByCategory(snaps);
  return acc;
}

// ----- page -----------------------------------------------------------

type ViewMode = "week" | "month";

export default function DebriefPage() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const qc = useQueryClient();

  // 180-day backwards window — same as the sidebar badge hook so they
  // share a cache key.
  const today = useMemo(() => new Date(), []);
  const fromISO = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 180);
    return fmtISO(d);
  }, [today]);
  const toISO = useMemo(() => fmtISO(today), [today]);

  // (#823) Always-fresh: the weeks list reflects new transactions and
  // edits the user expects to see without a hard refresh.
  const weeksQ = useListWeeklyDebriefs(
    { from: fromISO, to: toISO },
    {
      query: {
        queryKey: getListWeeklyDebriefsQueryKey({ from: fromISO, to: toISO }),
        staleTime: 0,
        refetchOnMount: "always",
        refetchOnWindowFocus: true,
      },
    },
  );
  const weeks: WeeklyDebriefListItem[] = useMemo(
    () => weeksQ.data?.weeks ?? [],
    [weeksQ.data],
  );

  // ----- URL state: active week + view mode ---------------------------
  const queryWeek = useMemo(() => {
    const sp = new URLSearchParams(search);
    return sp.get("week");
  }, [search]);
  const viewMode: ViewMode = useMemo(() => {
    const sp = new URLSearchParams(search);
    return sp.get("view") === "month" ? "month" : "week";
  }, [search]);

  const activeWeekStart = useMemo<string | null>(() => {
    if (queryWeek && /^\d{4}-\d{2}-\d{2}$/.test(queryWeek)) return queryWeek;
    if (!weeks.length) return null;
    const inProgress = weeks.find((w) => w.status === "in_progress");
    if (inProgress) return inProgress.weekStart;
    const sortedAwaiting = weeks
      .filter((w) => w.status === "awaiting_review")
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    if (sortedAwaiting.length) return sortedAwaiting[0].weekStart;
    const sorted = [...weeks].sort((a, b) =>
      b.weekStart.localeCompare(a.weekStart),
    );
    return sorted[0]?.weekStart ?? null;
  }, [queryWeek, weeks]);

  // If no ?week= and we picked one, push it into the URL so deep-link
  // sharing always reflects what the user is looking at.
  useEffect(() => {
    if (!activeWeekStart) return;
    if (queryWeek === activeWeekStart) return;
    const sp = new URLSearchParams(search);
    sp.set("week", activeWeekStart);
    setLocation(`${location.split("?")[0]}?${sp.toString()}`, {
      replace: !queryWeek,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWeekStart]);

  const selectWeek = (weekStart: string) => {
    const sp = new URLSearchParams(search);
    sp.set("week", weekStart);
    setLocation(`/debrief?${sp.toString()}`);
  };
  const setViewMode = (mode: ViewMode) => {
    const sp = new URLSearchParams(search);
    sp.set("view", mode);
    setLocation(`/debrief?${sp.toString()}`);
  };

  // ----- Empty: no weeks at all --------------------------------------
  if (weeksQ.isSuccess && weeks.length === 0) {
    return (
      <div className="space-y-6" data-testid="page-debrief">
        <PageHeader viewMode={viewMode} onSetView={setViewMode} />
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-3">
            <CalendarIcon className="w-10 h-10 mx-auto opacity-40" />
            <div>
              No weekly debriefs yet — once Chase transactions sync in, weeks
              will appear here for review.
            </div>
            <Link href="/transactions">
              <Button variant="outline" size="sm">
                Go to Chase
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!activeWeekStart) {
    return (
      <div className="space-y-6" data-testid="page-debrief">
        <PageHeader viewMode={viewMode} onSetView={setViewMode} />
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            Loading…
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <DebriefPageActive
      activeWeekStart={activeWeekStart}
      viewMode={viewMode}
      weeks={weeks}
      onSelectWeek={selectWeek}
      onSetView={setViewMode}
      qc={qc}
      toast={toast}
    />
  );
}

function PageHeader({
  viewMode,
  onSetView,
}: {
  viewMode: ViewMode;
  onSetView: (m: ViewMode) => void;
}) {
  return (
    <SectionHeader
      eyebrow="Forecast vs actual"
      title="Debrief"
      sub="Your week — and month — against what the forecast said. Drill any bar to see what blew the budget, then move a charge to where it belongs."
      action={<ViewToggle value={viewMode} onChange={onSetView} />}
    />
  );
}

// Segmented Week / Month control.
function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-full border border-card-border bg-muted/40 p-0.5"
      data-testid="debrief-view-toggle"
    >
      {(["week", "month"] as ViewMode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          data-testid={`debrief-view-${m}`}
          className={cn(
            "rounded-full px-3.5 py-1 text-xs font-semibold capitalize transition-colors",
            value === m
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// =====================================================================
// Active view (host for all data + mutations)
// =====================================================================

function DebriefPageActive({
  activeWeekStart,
  viewMode,
  weeks,
  onSelectWeek,
  onSetView,
  qc,
  toast,
}: {
  activeWeekStart: string;
  viewMode: ViewMode;
  weeks: WeeklyDebriefListItem[];
  onSelectWeek: (w: string) => void;
  onSetView: (m: ViewMode) => void;
  qc: ReturnType<typeof useQueryClient>;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  // (#823) Always-fresh per-week detail (Week view).
  const detailQ = useGetWeeklyDebrief(activeWeekStart, {
    query: {
      queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart),
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  });
  const detail: WeeklyDebriefDetail | undefined = detailQ.data;

  // ----- The month's weeks (for Month view + the weeks strip) ---------
  const month = monthKey(activeWeekStart);
  const monthWeeks = useMemo(
    () =>
      weeks
        .filter((w) => monthKey(w.weekStart) === month)
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    [weeks, month],
  );
  const monthWeekStarts = useMemo(
    () => monthWeeks.map((w) => w.weekStart),
    [monthWeeks],
  );

  // Month view aggregates every week's precomputed snapshot. We only
  // pull these when Month view is active (enabled guard) so Week view
  // stays a single fetch. useQueries is one hook call over a dynamic
  // array — safe across month changes.
  const monthDetailResults = useQueries({
    queries: monthWeekStarts.map((ws) =>
      getGetWeeklyDebriefQueryOptions(ws, {
        query: {
          queryKey: getGetWeeklyDebriefQueryKey(ws),
          staleTime: 60_000,
          enabled: viewMode === "month",
        },
      }),
    ),
  });
  const monthSnaps = useMemo(
    () =>
      monthDetailResults
        .map((r) => r.data?.varianceSnapshot)
        .filter((s): s is WeeklyDebriefSnapshot => !!s),
    [monthDetailResults],
  );
  const monthLoading =
    viewMode === "month" &&
    monthDetailResults.some((r) => r.isLoading) &&
    monthSnaps.length < monthWeekStarts.length;

  // The weeks whose caches a recategorize should refresh. In Week view
  // that's just the active week; in Month view it's every week we merged.
  const relevantWeekStarts = useMemo(
    () => (viewMode === "month" ? monthWeekStarts : [activeWeekStart]),
    [viewMode, monthWeekStarts, activeWeekStart],
  );

  // Pull Plaid txns for this week — needed for the "Pending Bank
  // Transactions" section (Week view only).
  const txnQ = useListTransactions(
    detail
      ? {
          from: detail.weekStart,
          to: detail.weekEnd,
          source: "plaid",
          limit: 500,
        }
      : undefined,
    { query: { enabled: !!detail } as any },
  );

  const { data: categories } = useListCategories();
  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    (categories ?? []).forEach((c) => m.set(c.id, c.name));
    return m;
  }, [categories]);
  // Income variance colors flip (more income = good = green); expense
  // keeps the default (over = red). Unknown/null → expense semantics.
  const catKindById = useMemo(() => {
    const m = new Map<string, "income" | "expense">();
    (categories ?? []).forEach((c) =>
      m.set(c.id, c.kind === "income" ? "income" : "expense"),
    );
    return m;
  }, [categories]);

  // ----- Mutations ---------------------------------------------------
  const upsertResolution = useUpsertForecastResolution();
  const createRecurring = useCreateRecurringItem();
  const sendToReview = useSendTransactionsToReview();
  const lockWeek = useLockWeeklyDebrief();
  const unlockWeek = useUnlockWeeklyDebrief();
  const updateTxn = useUpdateTransaction();

  const invalidateAfterResolution = () => {
    qc.invalidateQueries({
      queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart),
    });
    qc.invalidateQueries({ queryKey: getListWeeklyDebriefsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
  };

  // (#801) Recategorize a single transaction from the drill-down, without
  // leaving /debrief. Mirrors the /chase + /forecast PATCH
  // `{ categoryId, rememberPattern? }`. On success we invalidate every
  // relevant week's debrief (so the bars + drill repaint with the txn in
  // its new bucket — in Month view that can be any week we merged), plus
  // the transactions list and forecast. The drill stays open so the user
  // can keep editing.
  const handleChangeTxnCategory = (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => {
    updateTxn.mutate(
      {
        id: txnId,
        data: {
          categoryId: newCategoryId,
          ...(rememberPattern ? { rememberPattern } : {}),
        },
      },
      {
        onSuccess: () => {
          for (const ws of relevantWeekStarts) {
            qc.invalidateQueries({
              queryKey: getGetWeeklyDebriefQueryKey(ws),
            });
          }
          qc.invalidateQueries({ queryKey: getListWeeklyDebriefsQueryKey() });
          qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          toast({ title: "Recategorized" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't recategorize",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleMatchPlan = (plan: WeeklyDebriefPlanItem, txnId: string) => {
    if (!plan.recurringItemId) return;
    upsertResolution.mutate(
      {
        data: {
          recurringItemId: plan.recurringItemId,
          occurrenceDate: plan.forecastDate,
          status: "matched",
          matchedTxnId: txnId,
        },
      },
      {
        onSuccess: () => {
          invalidateAfterResolution();
          toast({ title: `Matched "${plan.name}"` });
        },
        onError: (err) =>
          toast({
            title: "Couldn't match",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleReschedule = (
    plan: WeeklyDebriefPlanItem,
    targetSunday: string,
  ) => {
    if (!plan.recurringItemId) return;
    upsertResolution.mutate(
      {
        data: {
          recurringItemId: plan.recurringItemId,
          occurrenceDate: plan.forecastDate,
          status: "rescheduled",
          rescheduledTo: targetSunday,
        },
      },
      {
        onSuccess: () => {
          invalidateAfterResolution();
          toast({ title: `Rescheduled "${plan.name}" to ${targetSunday}` });
        },
        onError: (err) =>
          toast({
            title: "Couldn't reschedule",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const handlePlanStatus = (
    plan: WeeklyDebriefPlanItem,
    status: "missed" | "skipped",
  ) => {
    if (!plan.recurringItemId) return;
    upsertResolution.mutate(
      {
        data: {
          recurringItemId: plan.recurringItemId,
          occurrenceDate: plan.forecastDate,
          status,
        },
      },
      {
        onSuccess: () => {
          invalidateAfterResolution();
          toast({
            title:
              status === "missed"
                ? `Marked "${plan.name}" missed`
                : `Skipped "${plan.name}"`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't update plan",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleAcceptUnplanned = (txn: WeeklyDebriefTxnItem) => {
    upsertResolution.mutate(
      {
        data: {
          status: "ignored_unforecasted",
          matchedTxnId: txn.txnId,
        },
      },
      {
        onSuccess: () => {
          invalidateAfterResolution();
          toast({
            title: "Accepted as unplanned",
            description:
              "Drops from open items. Variance dollars stay counted so the week reports honestly.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't accept",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  // -- Convert-to-recurring (inline dialog seeded from a txn) ---------
  type AddBillSeed = {
    sourceTxnId: string;
    name: string;
    amount: string;
    kind: "bill" | "income";
    frequency: "monthly" | "biweekly" | "weekly" | "semimonthly" | "onetime";
    dayOfMonth: string;
    anchorDate: string;
  };
  const [addBillSeed, setAddBillSeed] = useState<AddBillSeed | null>(null);

  const openConvertToRecurring = (txn: WeeklyDebriefTxnItem) => {
    const amt = Number(txn.amount);
    const isIncome = amt > 0;
    const dom = Number(txn.date.slice(8, 10));
    setAddBillSeed({
      sourceTxnId: txn.txnId,
      name: (txn.description ?? "").trim() || "Untitled",
      amount: Math.abs(amt).toFixed(2),
      kind: isIncome ? "income" : "bill",
      frequency: "monthly",
      dayOfMonth:
        Number.isFinite(dom) && dom >= 1 && dom <= 31 ? String(dom) : "1",
      anchorDate: txn.date,
    });
  };

  const submitConvertToRecurring = () => {
    if (!addBillSeed) return;
    const name = addBillSeed.name.trim();
    if (!name) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const amt = parseFloat(addBillSeed.amount);
    if (!Number.isFinite(amt) || amt < 0) {
      toast({
        title: "Amount must be a positive number",
        variant: "destructive",
      });
      return;
    }
    if (addBillSeed.frequency === "onetime" && !addBillSeed.anchorDate) {
      toast({
        title: "Pick a date for the one-time item",
        variant: "destructive",
      });
      return;
    }
    const payload: RecurringItemInput = {
      name,
      kind: addBillSeed.kind,
      amount: amt.toFixed(2),
      frequency: addBillSeed.frequency,
      active: "true",
      dayOfMonth: null,
      anchorDate: null,
    };
    if (
      addBillSeed.frequency === "monthly" ||
      addBillSeed.frequency === "semimonthly"
    ) {
      const day = parseInt(addBillSeed.dayOfMonth, 10);
      payload.dayOfMonth = Number.isFinite(day) && day >= 1 && day <= 31 ? day : 1;
      payload.anchorDate = addBillSeed.anchorDate || null;
    } else {
      payload.anchorDate = addBillSeed.anchorDate || null;
    }

    createRecurring.mutate(
      { data: payload },
      {
        onSuccess: () => {
          upsertResolution.mutate(
            {
              data: {
                status: "ignored_unforecasted",
                matchedTxnId: addBillSeed.sourceTxnId,
              },
            },
            {
              onSettled: () => {
                qc.invalidateQueries({
                  queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart),
                });
                qc.invalidateQueries({
                  queryKey: getListWeeklyDebriefsQueryKey(),
                });
                qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
                qc.invalidateQueries({
                  queryKey: getListRecurringItemsQueryKey(),
                });
                qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
                qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
              },
            },
          );
          setAddBillSeed(null);
          toast({
            title: `Added "${name}" as recurring ${addBillSeed.kind}`,
            description: "Future occurrences will now appear in your forecast.",
          });
        },
        onError: (err) => {
          toast({
            title: "Couldn't add bill",
            description: (err as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  // -- Send to review -------------------------------------------------
  const handleSendToReview = (txnId: string) => {
    sendToReview.mutate(
      { data: { transactionIds: [txnId] } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          toast({ title: "Sent to Review" });
        },
        onError: (err) =>
          toast({
            title: "Send failed",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  // -- Lock / Unlock --------------------------------------------------
  const handleLock = () => {
    lockWeek.mutate(
      { weekStart: activeWeekStart },
      {
        onSuccess: () => {
          invalidateAfterResolution();
          toast({ title: `Locked week of ${activeWeekStart}` });
        },
        onError: (err) =>
          toast({
            title: "Couldn't lock",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const [unlockConfirmOpen, setUnlockConfirmOpen] = useState(false);
  const handleUnlock = () => {
    unlockWeek.mutate(
      { weekStart: activeWeekStart, data: { confirm: true } },
      {
        onSuccess: () => {
          invalidateAfterResolution();
          setUnlockConfirmOpen(false);
          toast({
            title: "Week unlocked",
            description: "Frozen snapshot cleared — variance will recompute.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't unlock",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  // -- Derived render state ------------------------------------------
  const snapshot = detail?.varianceSnapshot ?? null;
  const isLocked = detail?.status === "locked";
  const isInProgress = detail?.status === "in_progress";
  const openItemsCount = snapshot?.openItemsCount ?? 0;

  const snapshotTxnIds = useMemo(
    () => new Set((snapshot?.transactions ?? []).map((t) => t.txnId)),
    [snapshot],
  );
  const pendingBankTxns = useMemo(() => {
    if (!txnQ.data) return [];
    return txnQ.data.filter(
      (t) => t.forecastFlag && snapshotTxnIds.has(t.id),
    );
  }, [txnQ.data, snapshotTxnIds]);

  // The aggregate view the graphics read.
  const view: AggView | null = useMemo(() => {
    if (viewMode === "month") {
      return monthSnaps.length ? monthAggView(monthSnaps) : null;
    }
    return snapshot ? weekAggView(snapshot) : null;
  }, [viewMode, monthSnaps, snapshot]);

  // Net-trend series: variance per week. Month view shows this month's
  // weeks; week view shows the whole window for context.
  const trendWeeks = useMemo(
    () =>
      viewMode === "month"
        ? monthWeeks
        : [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    [viewMode, monthWeeks, weeks],
  );

  const rangeLabel =
    viewMode === "month"
      ? monthLabel(month)
      : detail
        ? `Week of ${weekRangeLabel(detail.weekStart, detail.weekEnd)}`
        : "This week";

  const isLoading = viewMode === "month" ? monthLoading : detailQ.isLoading;
  const hasData = viewMode === "month" ? monthSnaps.length > 0 : !!snapshot;

  return (
    <div className="space-y-6" data-testid="page-debrief">
      <PageHeader viewMode={viewMode} onSetView={onSetView} />

      <WeekChipRow
        weeks={weeks}
        activeWeekStart={activeWeekStart}
        activeMonth={month}
        viewMode={viewMode}
        onSelect={onSelectWeek}
      />

      {isLoading && !hasData ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            {viewMode === "month"
              ? "Aggregating this month…"
              : "Loading week…"}
          </CardContent>
        </Card>
      ) : !hasData || !view ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-3">
            <CalendarIcon className="w-10 h-10 mx-auto opacity-40" />
            <div>
              {viewMode === "month"
                ? "No locked or reviewed weeks in this month yet — open a week and work through it."
                : isInProgress
                  ? "Nothing to review yet for this week — sync Chase and check back."
                  : "No snapshot for this week."}
            </div>
            <Link href="/transactions">
              <Button variant="outline" size="sm">
                Go to Chase
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Hero: the four numbers that matter, forecast vs actual. */}
          <HeroTiles view={view} rangeLabel={rangeLabel} viewMode={viewMode} />

          {/* Net-trend graphic across weeks. */}
          <NetTrendCard
            weeks={trendWeeks}
            activeWeekStart={activeWeekStart}
            onSelectWeek={(ws) => {
              onSelectWeek(ws);
              if (viewMode === "month") onSetView("week");
            }}
          />

          {/* The centerpiece: forecast vs actual by category, drillable. */}
          <CategoryVarianceGraphic
            buckets={view.byCategory}
            catNameById={catNameById}
            catKindById={catKindById}
            categories={categories ?? []}
            onChangeTxnCategory={
              // A locked, single week is a frozen snapshot — recategorizing
              // wouldn't move its buckets, so keep it read-only. Month view
              // and any unlocked week stay editable.
              viewMode === "week" && isLocked
                ? undefined
                : handleChangeTxnCategory
            }
          />

          {/* Fable 5 — the advisor takeaway. */}
          {viewMode === "month" ? (
            <MonthTakeawaysCard
              monthLabelText={monthLabel(month)}
              results={monthDetailResults}
            />
          ) : (
            (detail!.advisorSummary || isLocked) && (
              <AdvisorTakeawayCard
                weekStart={activeWeekStart}
                summary={detail!.advisorSummary ?? null}
              />
            )
          )}

          {/* Secondary: the lock ritual + open-item resolution (Week view
              only — locking is inherently per-week). */}
          {viewMode === "week" && snapshot && (
            <>
              {!isLocked && (
                <ActionPanel
                  snapshot={snapshot}
                  pendingBankTxns={pendingBankTxns}
                  catNameById={catNameById}
                  weekStart={activeWeekStart}
                  onMatchPlan={handleMatchPlan}
                  onReschedulePlan={handleReschedule}
                  onPlanStatus={handlePlanStatus}
                  onAcceptUnplanned={handleAcceptUnplanned}
                  onConvertToRecurring={openConvertToRecurring}
                  onSendToReview={handleSendToReview}
                  upsertPending={upsertResolution.isPending}
                  sendPending={sendToReview.isPending}
                />
              )}

              {isLocked && (
                <PostLockAdditionsCard additions={detail!.postLockAdditions} />
              )}

              <LockFooter
                isLocked={isLocked}
                isInProgress={isInProgress}
                openItemsCount={openItemsCount}
                detail={detail!}
                lockPending={lockWeek.isPending}
                unlockPending={unlockWeek.isPending}
                onLock={handleLock}
                onUnlockClick={() => setUnlockConfirmOpen(true)}
              />
            </>
          )}

          {/* Month view: a compact status strip so each week's lock stays
              one click away. */}
          {viewMode === "month" && (
            <MonthWeeksStrip
              monthWeeks={monthWeeks}
              onOpenWeek={(ws) => {
                onSelectWeek(ws);
                onSetView("week");
              }}
            />
          )}
        </>
      )}

      {/* Unlock confirm */}
      <Dialog open={unlockConfirmOpen} onOpenChange={setUnlockConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unlock this week?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Unlocking clears the frozen snapshot and reopens the week for edits.
            Any post-lock activity will be folded back in on the next view.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlockConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleUnlock}
              disabled={unlockWeek.isPending}
              data-testid="button-confirm-unlock"
            >
              {unlockWeek.isPending ? "Unlocking…" : "Unlock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Convert-to-recurring dialog (inline; mirrors /forecast pattern) */}
      <Dialog
        open={addBillSeed !== null}
        onOpenChange={(o) => {
          if (!o) setAddBillSeed(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          data-testid="dialog-debrief-add-bill"
        >
          <DialogHeader>
            <DialogTitle>Convert to recurring</DialogTitle>
          </DialogHeader>
          {addBillSeed && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Name</Label>
                <Input
                  aria-label="Name"
                  value={addBillSeed.name}
                  onChange={(e) =>
                    setAddBillSeed({ ...addBillSeed, name: e.target.value })
                  }
                  data-testid="input-debrief-bill-name"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Amount</Label>
                  <Input
                    aria-label="Amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={addBillSeed.amount}
                    onChange={(e) =>
                      setAddBillSeed({ ...addBillSeed, amount: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={addBillSeed.kind}
                    onValueChange={(v) =>
                      setAddBillSeed({
                        ...addBillSeed,
                        kind: v as "bill" | "income",
                      })
                    }
                  >
                    <SelectTrigger aria-label="Type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bill">Bill (expense)</SelectItem>
                      <SelectItem value="income">Income</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Frequency</Label>
                  <Select
                    value={addBillSeed.frequency}
                    onValueChange={(v) =>
                      setAddBillSeed({
                        ...addBillSeed,
                        frequency: v as AddBillSeed["frequency"],
                      })
                    }
                  >
                    <SelectTrigger aria-label="Frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="semimonthly">Semi-monthly</SelectItem>
                      <SelectItem value="biweekly">Biweekly</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="onetime">One-time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(addBillSeed.frequency === "monthly" ||
                  addBillSeed.frequency === "semimonthly") && (
                  <div>
                    <Label className="text-xs">Day of month</Label>
                    <Input
                      aria-label="Day of month"
                      type="number"
                      min="1"
                      max="31"
                      value={addBillSeed.dayOfMonth}
                      onChange={(e) =>
                        setAddBillSeed({
                          ...addBillSeed,
                          dayOfMonth: e.target.value,
                        })
                      }
                    />
                  </div>
                )}
                {(addBillSeed.frequency === "biweekly" ||
                  addBillSeed.frequency === "weekly" ||
                  addBillSeed.frequency === "onetime") && (
                  <div>
                    <Label className="text-xs">
                      {addBillSeed.frequency === "onetime"
                        ? "Date"
                        : "Anchor date"}
                    </Label>
                    <Input
                      aria-label={
                        addBillSeed.frequency === "onetime"
                          ? "Date"
                          : "Anchor date"
                      }
                      type="date"
                      value={addBillSeed.anchorDate}
                      onChange={(e) =>
                        setAddBillSeed({
                          ...addBillSeed,
                          anchorDate: e.target.value,
                        })
                      }
                    />
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                After saving, the source charge is acknowledged so the week can
                lock, and the new{" "}
                {addBillSeed.kind === "income" ? "income" : "bill"} appears in
                your forecast going forward.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddBillSeed(null)}
              disabled={createRecurring.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={submitConvertToRecurring}
              disabled={createRecurring.isPending}
              data-testid="button-debrief-bill-save"
            >
              {createRecurring.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =====================================================================
// Graphics — hero, trend, category
// =====================================================================

// The four numbers that matter, as command-center StatTiles. Every figure
// comes straight from the aggregate (which sums the precomputed snapshot).
function HeroTiles({
  view,
  rangeLabel,
  viewMode,
}: {
  view: AggView;
  rangeLabel: string;
  viewMode: ViewMode;
}) {
  const variancePct =
    view.plannedNet !== 0
      ? (view.varianceNet / Math.abs(view.plannedNet)) * 100
      : 0;
  const netAhead = view.varianceNet >= 0;
  const freedHot = view.freed > 0;
  return (
    <div className="space-y-2" data-testid="debrief-hero">
      <div className="text-xs uppercase tracking-widest text-muted-foreground font-medium">
        {viewMode === "month" ? "Month" : "Week"} · {rangeLabel}
      </div>
      <StatTileRow>
        <StatTile
          label="Planned net"
          value={<MoneyText amount={view.plannedNet} />}
          sub="what the forecast said"
          icon={<CalendarIcon />}
        />
        <StatTile
          label="Actual net"
          value={<MoneyText amount={view.actualNet} colored />}
          sub={`${money(view.actualIncome)} in · ${money(
            view.actualExpenses,
          )} out`}
          icon={<CheckCircle2 />}
        />
        <StatTile
          label="Variance"
          value={
            <MoneyText amount={view.varianceNet} colored signed />
          }
          sub={
            <span className="inline-flex items-center gap-1.5">
              <DeltaPill value={variancePct} />
              <span>{netAhead ? "ahead of plan" : "behind plan"}</span>
            </span>
          }
          icon={netAhead ? <CheckCircle2 /> : <AlertCircle />}
        />
        <StatTile
          label="Freed for avalanche"
          value={
            <span className={freedHot ? "text-[hsl(var(--positive))]" : ""}>
              {money(view.freed)}
            </span>
          }
          sub={freedHot ? "ammo to bury a balance" : "no ammo this period"}
          icon={<Flame />}
        />
      </StatTileRow>
    </div>
  );
}

// Variance-per-week bars. Over (net below plan) = red, ahead = green.
// Click a bar to jump into that week.
function NetTrendCard({
  weeks,
  activeWeekStart,
  onSelectWeek,
}: {
  weeks: WeeklyDebriefListItem[];
  activeWeekStart: string;
  onSelectWeek: (ws: string) => void;
}) {
  const sorted = weeks; // already ascending
  const data = sorted.map((w) => {
    const v = Number(w.netSummary.varianceNet);
    return {
      value: v,
      label: `${shortWeekChipLabel(w.weekStart)}: ${money(v, {
        signed: true,
      })}`,
      color:
        v >= 0 ? "hsl(var(--positive))" : "hsl(var(--negative))",
    };
  });
  const activeIndex = sorted.findIndex((w) => w.weekStart === activeWeekStart);
  const total = sorted.reduce(
    (s, w) => s + Number(w.netSummary.varianceNet),
    0,
  );
  if (sorted.length === 0) return null;
  return (
    <Card data-testid="debrief-net-trend">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Net vs plan, week by week</CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>net variance</span>
            <MoneyText
              amount={total}
              colored
              signed
              className="font-semibold"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <MiniBars
          data={data}
          height={56}
          signed
          activeIndex={activeIndex >= 0 ? activeIndex : undefined}
          onBarClick={(i) => {
            const w = sorted[i];
            if (w) onSelectWeek(w.weekStart);
          }}
        />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>{shortWeekChipLabel(sorted[0].weekStart)}</span>
          <span className="uppercase tracking-widest">
            green = ahead · red = over
          </span>
          <span>
            {shortWeekChipLabel(sorted[sorted.length - 1].weekStart)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// The centerpiece — forecast vs actual per category, sorted by |variance|.
// Each row shows a planned-vs-actual bar (OVER in red) and drills open to
// the actual transactions that made it, each with an inline CategoryPicker
// to move the charge to another category.
function CategoryVarianceGraphic({
  buckets,
  catNameById,
  catKindById,
  categories,
  onChangeTxnCategory,
}: {
  buckets: WeeklyDebriefCategoryBucket[];
  catNameById: Map<string, string>;
  catKindById: Map<string, "income" | "expense">;
  categories: { id: string; name: string }[];
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
}) {
  const sorted = useMemo(
    () =>
      [...buckets].sort(
        (a, b) =>
          Math.abs(Number(b.varianceAmount)) -
          Math.abs(Number(a.varianceAmount)),
      ),
    [buckets],
  );
  const [showAll, setShowAll] = useState(false);
  const OVERSHOW = 8;
  const visible = showAll ? sorted : sorted.slice(0, OVERSHOW);

  const overCount = sorted.filter((b) => {
    const kind = b.categoryId
      ? catKindById.get(b.categoryId) ?? "expense"
      : "expense";
    const v = Number(b.varianceAmount);
    return kind === "income" ? v < 0 : v > 0;
  }).length;

  return (
    <Card data-testid="debrief-category-graphic">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Where the plan met reality</CardTitle>
          <span className="text-xs text-muted-foreground">
            {overCount > 0
              ? `${overCount} categor${overCount === 1 ? "y" : "ies"} over`
              : "all within plan"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {sorted.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No category activity this period.
          </div>
        ) : (
          <>
            {visible.map((b) => (
              <CategoryRow
                key={b.categoryId ?? "_uncat"}
                bucket={b}
                catNameById={catNameById}
                catKindById={catKindById}
                categories={categories}
                onChangeTxnCategory={onChangeTxnCategory}
              />
            ))}
            {sorted.length > OVERSHOW && (
              <div className="pt-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setShowAll((s) => !s)}
                  data-testid="debrief-category-showall"
                >
                  {showAll
                    ? "Show fewer"
                    : `Show all ${sorted.length} categories`}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CategoryRow({
  bucket,
  catNameById,
  catKindById,
  categories,
  onChangeTxnCategory,
}: {
  bucket: WeeklyDebriefCategoryBucket;
  catNameById: Map<string, string>;
  catKindById: Map<string, "income" | "expense">;
  categories: { id: string; name: string }[];
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = bucket.categoryId
    ? catNameById.get(bucket.categoryId) ?? "Uncategorized"
    : "Uncategorized";
  const kind = bucket.categoryId
    ? catKindById.get(bucket.categoryId) ?? "expense"
    : "expense";
  const planned = Math.abs(Number(bucket.plannedAmount));
  const actual = Math.abs(Number(bucket.actualAmount));
  const v = Number(bucket.varianceAmount);
  // Income: under-earning is bad. Expense: over-spending is bad.
  const bad = kind === "income" ? v < 0 : v > 0;
  const neutral = v === 0;
  const barColor = neutral
    ? "hsl(var(--muted-foreground))"
    : bad
      ? "hsl(var(--negative))"
      : "hsl(var(--positive))";
  const max = Math.max(planned, actual, 1);
  const txns = bucket.actualTxns ?? [];
  const drillable = txns.length > 0 && !!onChangeTxnCategory;

  return (
    <div
      className="rounded-lg border border-card-border bg-card"
      data-testid={`debrief-cat-${name.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        aria-expanded={open}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="truncate text-sm font-medium">{name}</span>
            {kind === "income" && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                income
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <MoneyText
              amount={v}
              colored={false}
              signed
              className={cn(
                "text-sm font-semibold",
                neutral
                  ? "text-muted-foreground"
                  : bad
                    ? "text-[hsl(var(--negative))]"
                    : "text-[hsl(var(--positive))]",
              )}
            />
          </div>
        </div>
        {/* Planned vs actual bars — the taller track is the reference. */}
        <div className="mt-2 space-y-1 pl-5">
          <BarLine
            caption="Planned"
            amount={planned}
            pct={(planned / max) * 100}
            color="hsl(var(--muted-foreground)/0.55)"
          />
          <BarLine
            caption="Actual"
            amount={actual}
            pct={(actual / max) * 100}
            color={barColor}
          />
        </div>
      </button>

      {open && (
        <div className="border-t border-card-border px-2 py-1.5">
          {txns.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              No transactions landed in this category
              {Number(bucket.plannedAmount) !== 0
                ? " — it was planned but never spent."
                : "."}
            </div>
          ) : (
            <>
              <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                {txns.length} transaction{txns.length === 1 ? "" : "s"} ·
                includes Amex, so this can exceed Chase-only cash flow
              </div>
              {txns.map((t, i) => (
                <ActualTxnRow
                  key={t.txnId + i}
                  txn={t}
                  categoryId={bucket.categoryId}
                  categories={onChangeTxnCategory ? categories : undefined}
                  onChangeTxnCategory={onChangeTxnCategory}
                  testIdPrefix="debrief-cat-drill"
                />
              ))}
              {!drillable && onChangeTxnCategory == null && (
                <div className="px-2 py-1 text-[11px] italic text-muted-foreground">
                  Locked snapshot — unlock the week to move a charge.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// A single labelled progress bar (BudgetSection idiom).
function BarLine({
  caption,
  amount,
  pct,
  color,
}: {
  caption: string;
  amount: number;
  pct: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
        {caption}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/50">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: color }}
        />
      </div>
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {money(amount)}
      </span>
    </div>
  );
}

// =====================================================================
// Week selector chip row
// =====================================================================

function WeekChipRow({
  weeks,
  activeWeekStart,
  activeMonth,
  viewMode,
  onSelect,
}: {
  weeks: WeeklyDebriefListItem[];
  activeWeekStart: string;
  activeMonth: string;
  viewMode: ViewMode;
  onSelect: (w: string) => void;
}) {
  const sorted = useMemo(
    () => [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    [weeks],
  );
  return (
    <div
      className="border rounded-lg bg-card p-2 overflow-x-auto"
      data-testid="week-chip-row"
    >
      <div className="flex items-center gap-2">
        {sorted.map((w) => {
          const isActive =
            viewMode === "month"
              ? monthKey(w.weekStart) === activeMonth
              : w.weekStart === activeWeekStart;
          const statusColor =
            w.status === "locked"
              ? "bg-positive/10 text-positive border-positive/30"
              : w.status === "awaiting_review"
                ? "bg-warning/10 text-warning border-warning/30"
                : "bg-primary/10 text-primary border-primary/30";
          return (
            <button
              key={w.weekStart}
              onClick={() => onSelect(w.weekStart)}
              data-testid={`chip-week-${w.weekStart}`}
              className={cn(
                "shrink-0 px-3 py-1.5 rounded-md border text-xs whitespace-nowrap tabular-nums transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground border-primary font-semibold"
                  : `${statusColor} hover:opacity-80`,
              )}
            >
              <div className="flex items-center gap-1.5">
                <span>{shortWeekChipLabel(w.weekStart)}</span>
                {w.status === "locked" && <Lock className="w-3 h-3" />}
                {w.status === "awaiting_review" && w.openItemsCount > 0 && (
                  <span className="text-[10px] opacity-75">
                    ·{w.openItemsCount}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =====================================================================
// Drill-down row — the actual transaction with an inline recategorize
// =====================================================================

// (#866) Category actuals blend Chase checking + Amex, so tag each row by
// its card. Mirrors the backend `isAmexRow` predicate.
function sourceCardLabel(source: string | null | undefined): "Amex" | "Chase" {
  const s = (source ?? "").toLowerCase().replace(/^plaid:/, "");
  return s === "amex" ? "Amex" : "Chase";
}

function ActualTxnRow({
  txn,
  categoryId,
  categories,
  onChangeTxnCategory,
  testIdPrefix,
  className,
}: {
  txn: NonNullable<WeeklyDebriefCategoryBucket["actualTxns"]>[number];
  categoryId?: string | null;
  categories?: { id: string; name: string }[];
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
  testIdPrefix: string;
  className?: string;
}) {
  return (
    <div className={cn("px-3 py-1.5 text-sm", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{txn.description}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{txn.date}</span>
            {(() => {
              const card = sourceCardLabel(txn.source);
              return (
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[9px] uppercase"
                  data-testid={`${testIdPrefix}-source-${txn.txnId}`}
                >
                  {card}
                </Badge>
              );
            })()}
            {!txn.matchedToPlan && (
              <Badge
                variant="secondary"
                className="h-4 px-1 text-[9px] uppercase"
              >
                unplanned
              </Badge>
            )}
          </div>
        </div>
        <div className="tabular-nums whitespace-nowrap">
          {money(Math.abs(txn.amount), { signed: false })}
        </div>
      </div>
      {/* Inline recategorization — same picker as /chase. Hidden when
          editing is disabled (e.g. a locked week). */}
      {categories && onChangeTxnCategory && (
        <div className="mt-1">
          <CategoryPicker
            value={categoryId ?? null}
            categories={categories}
            description={txn.description}
            onChange={(newId, rememberPattern) =>
              onChangeTxnCategory(txn.txnId, newId, rememberPattern)
            }
            testId={`${testIdPrefix}-${txn.txnId}`}
          />
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Action panel — open-item resolution (Week view only)
// =====================================================================

function ActionPanel({
  snapshot,
  pendingBankTxns,
  catNameById,
  weekStart,
  onMatchPlan,
  onReschedulePlan,
  onPlanStatus,
  onAcceptUnplanned,
  onConvertToRecurring,
  onSendToReview,
  upsertPending,
  sendPending,
}: {
  snapshot: WeeklyDebriefSnapshot;
  pendingBankTxns: Array<{
    id: string;
    description: string;
    amount: string;
    occurredOn: string;
    categoryId?: string | null;
  }>;
  catNameById: Map<string, string>;
  weekStart: string;
  onMatchPlan: (plan: WeeklyDebriefPlanItem, txnId: string) => void;
  onReschedulePlan: (plan: WeeklyDebriefPlanItem, targetSunday: string) => void;
  onPlanStatus: (
    plan: WeeklyDebriefPlanItem,
    status: "missed" | "skipped",
  ) => void;
  onAcceptUnplanned: (txn: WeeklyDebriefTxnItem) => void;
  onConvertToRecurring: (txn: WeeklyDebriefTxnItem) => void;
  onSendToReview: (txnId: string) => void;
  upsertPending: boolean;
  sendPending: boolean;
}) {
  const unmatchedPlans = snapshot.unmatchedPlans;
  const openUnplanned = snapshot.unplannedTxns.filter(
    (t) => t.status === "unplanned",
  );
  const acknowledgedUnplanned = snapshot.unplannedTxns.filter(
    (t) => t.status === "acknowledged_unplanned",
  );
  const candidateTxns = openUnplanned;

  const openItemsCount = unmatchedPlans.length + openUnplanned.length;
  const [openPlans, setOpenPlans] = useState(unmatchedPlans.length > 0);
  const [openUnp, setOpenUnp] = useState(openUnplanned.length > 0);
  const [openPending, setOpenPending] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span>Decisions to make</span>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 h-5 tabular-nums",
              openItemsCount > 0
                ? "bg-warning/10 text-warning border-warning/30"
                : "bg-positive/10 text-positive border-positive/30",
            )}
            data-testid="action-panel-open-count"
          >
            {openItemsCount} open
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {openItemsCount === 0 && (
          <div
            className="flex items-center gap-2 rounded-md border border-positive/30 bg-positive/10 px-3 py-2 text-sm text-positive"
            data-testid="action-panel-all-clear"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Nothing needs a decision — every plan is resolved and every charge
            triaged. Lock the week.
          </div>
        )}
        <SectionShell
          title="Unmatched plans"
          count={unmatchedPlans.length}
          open={openPlans}
          onOpenChange={setOpenPlans}
          emptyText="All planned items resolved."
        >
          {unmatchedPlans.map((plan) => (
            <UnmatchedPlanRow
              key={(plan.recurringItemId ?? "_") + plan.forecastDate}
              plan={plan}
              candidateTxns={candidateTxns}
              catNameById={catNameById}
              weekStart={weekStart}
              onMatch={onMatchPlan}
              onReschedule={onReschedulePlan}
              onStatus={onPlanStatus}
              busy={upsertPending}
            />
          ))}
        </SectionShell>

        <SectionShell
          title="Unplanned charges"
          count={openUnplanned.length}
          open={openUnp}
          onOpenChange={setOpenUnp}
          emptyText="No surprise charges this week."
        >
          {openUnplanned.map((txn) => (
            <UnplannedTxnRow
              key={txn.txnId}
              txn={txn}
              catNameById={catNameById}
              onAccept={onAcceptUnplanned}
              onConvert={onConvertToRecurring}
              busy={upsertPending}
            />
          ))}
          {acknowledgedUnplanned.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Acknowledged ({acknowledgedUnplanned.length}) — still counted in
                variance
              </div>
              <div className="space-y-1">
                {acknowledgedUnplanned.map((txn) => (
                  <div
                    key={txn.txnId}
                    className="flex items-center justify-between gap-3 text-sm py-1 px-2 rounded bg-muted/30"
                    data-testid={`row-acknowledged-${txn.txnId}`}
                  >
                    <div className="flex-1 truncate">
                      <span className="text-muted-foreground tabular-nums text-xs mr-2">
                        {txn.date}
                      </span>
                      {txn.description}
                    </div>
                    <span className="tabular-nums text-muted-foreground">
                      {money(txn.amount, { signed: true })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionShell>

        <SectionShell
          title="Pending bank transactions"
          count={pendingBankTxns.length}
          open={openPending}
          onOpenChange={setOpenPending}
          emptyText="All bank transactions for this week have been sent to Review."
        >
          {pendingBankTxns.map((tx) => (
            <div
              key={tx.id}
              className="flex items-center gap-3 py-2 border-b last:border-0"
              data-testid={`row-pending-${tx.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{tx.description}</div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {tx.occurredOn} · {money(tx.amount, { signed: true })}
                  {tx.categoryId && catNameById.get(tx.categoryId) && (
                    <span className="ml-2">
                      · {catNameById.get(tx.categoryId)}
                    </span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSendToReview(tx.id)}
                disabled={sendPending}
                data-testid={`button-send-review-${tx.id}`}
              >
                <Send className="w-3 h-3 mr-1" /> Send to Review
              </Button>
            </div>
          ))}
        </SectionShell>
      </CardContent>
    </Card>
  );
}

function SectionShell({
  title,
  count,
  open,
  onOpenChange,
  emptyText,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onOpenChange: (b: boolean) => void;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="border rounded-md"
    >
      <CollapsibleTrigger className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/40">
        <div className="flex items-center gap-2 text-sm font-medium">
          {open ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          {title}
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 h-5 tabular-nums",
              count > 0
                ? "bg-warning/10 text-warning border-warning/30"
                : "bg-positive/10 text-positive border-positive/30",
            )}
          >
            {count}
          </Badge>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3">
          {count === 0 ? (
            <div className="text-xs text-muted-foreground py-2 italic">
              {emptyText}
            </div>
          ) : (
            children
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function UnmatchedPlanRow({
  plan,
  candidateTxns,
  catNameById,
  weekStart,
  onMatch,
  onReschedule,
  onStatus,
  busy,
}: {
  plan: WeeklyDebriefPlanItem;
  candidateTxns: WeeklyDebriefTxnItem[];
  catNameById: Map<string, string>;
  weekStart: string;
  onMatch: (plan: WeeklyDebriefPlanItem, txnId: string) => void;
  onReschedule: (plan: WeeklyDebriefPlanItem, targetSunday: string) => void;
  onStatus: (plan: WeeklyDebriefPlanItem, status: "missed" | "skipped") => void;
  busy: boolean;
}) {
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchQuery, setMatchQuery] = useState("");
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [customDate, setCustomDate] = useState("");

  const filtered = useMemo(() => {
    const q = matchQuery.trim().toLowerCase();
    if (!q) return candidateTxns;
    return candidateTxns.filter((t) => t.description.toLowerCase().includes(q));
  }, [candidateTxns, matchQuery]);

  const catName = plan.categoryId
    ? catNameById.get(plan.categoryId) ?? null
    : null;
  const sign = plan.kind === "income" ? 1 : -1;

  return (
    <div
      className="py-2 border-b last:border-0 space-y-2"
      data-testid={`row-plan-${plan.recurringItemId ?? "noid"}-${plan.forecastDate}`}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{plan.name}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {plan.forecastDate} ·{" "}
            {money(sign * Number(plan.forecastAmount), { signed: true })}
            {catName && <span className="ml-2">· {catName}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setMatchOpen((v) => !v)}
            data-testid={`button-match-${plan.recurringItemId}`}
          >
            <CheckCircle2 className="w-3 h-3 mr-1" /> Match
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setRescheduleOpen((v) => !v)}
            data-testid={`button-reschedule-${plan.recurringItemId}`}
          >
            <RefreshCcw className="w-3 h-3 mr-1" /> Reschedule
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onStatus(plan, "missed")}
            data-testid={`button-missed-${plan.recurringItemId}`}
          >
            <X className="w-3 h-3 mr-1" /> Missed
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onStatus(plan, "skipped")}
            data-testid={`button-skip-${plan.recurringItemId}`}
          >
            Skip
          </Button>
        </div>
      </div>

      {matchOpen && (
        <div className="ml-2 pl-3 border-l-2 border-primary/30 space-y-2">
          <Input
            placeholder="Search bank transactions…"
            value={matchQuery}
            onChange={(e) => setMatchQuery(e.target.value)}
            className="h-8 text-xs"
            autoFocus
          />
          {filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground py-1">
              No open unplanned bank transactions in this week.
            </div>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1">
              {filtered.map((t) => (
                <button
                  key={t.txnId}
                  onClick={() => {
                    setMatchOpen(false);
                    setMatchQuery("");
                    onMatch(plan, t.txnId);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs hover:bg-muted text-left"
                  data-testid={`match-candidate-${t.txnId}`}
                >
                  <span className="flex-1 truncate">
                    <span className="text-muted-foreground tabular-nums mr-2">
                      {t.date}
                    </span>
                    {t.description}
                  </span>
                  <span className="tabular-nums">
                    {money(t.amount, { signed: true })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {rescheduleOpen && (
        <div className="ml-2 pl-3 border-l-2 border-primary/30 flex flex-wrap items-center gap-2">
          {[1, 2, 3].map((n) => {
            const target = addDaysISO(weekStart, 7 * n);
            return (
              <Button
                key={n}
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setRescheduleOpen(false);
                  onReschedule(plan, target);
                }}
                data-testid={`button-reschedule-${plan.recurringItemId}-${n}w`}
              >
                {n === 1 ? "Next week" : `In ${n} weeks`}
              </Button>
            );
          })}
          <span className="text-xs text-muted-foreground">or</span>
          <Input
            type="date"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            className="h-8 text-xs w-auto"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !customDate}
            onClick={() => {
              if (!customDate) return;
              const sunday = weekStartFor(customDate);
              setRescheduleOpen(false);
              setCustomDate("");
              onReschedule(plan, sunday);
            }}
          >
            Go
          </Button>
        </div>
      )}
    </div>
  );
}

function UnplannedTxnRow({
  txn,
  catNameById,
  onAccept,
  onConvert,
  busy,
}: {
  txn: WeeklyDebriefTxnItem;
  catNameById: Map<string, string>;
  onAccept: (txn: WeeklyDebriefTxnItem) => void;
  onConvert: (txn: WeeklyDebriefTxnItem) => void;
  busy: boolean;
}) {
  const catName = txn.categoryId
    ? catNameById.get(txn.categoryId) ?? null
    : null;
  return (
    <div
      className="flex items-center gap-3 py-2 border-b last:border-0"
      data-testid={`row-unplanned-${txn.txnId}`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{txn.description}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {txn.date} · {money(txn.amount, { signed: true })}
          {catName && <span className="ml-2">· {catName}</span>}
        </div>
      </div>
      <div className="flex gap-1.5 justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onAccept(txn)}
          data-testid={`button-accept-unplanned-${txn.txnId}`}
        >
          <CheckCircle2 className="w-3 h-3 mr-1" /> Accept unplanned
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onConvert(txn)}
          data-testid={`button-convert-recurring-${txn.txnId}`}
        >
          <Plus className="w-3 h-3 mr-1" /> Convert to recurring
        </Button>
      </div>
    </div>
  );
}

// =====================================================================
// Lock / Unlock footer
// =====================================================================

function LockFooter({
  isLocked,
  isInProgress,
  openItemsCount,
  detail,
  lockPending,
  unlockPending,
  onLock,
  onUnlockClick,
}: {
  isLocked: boolean;
  isInProgress: boolean;
  openItemsCount: number;
  detail: WeeklyDebriefDetail;
  lockPending: boolean;
  unlockPending: boolean;
  onLock: () => void;
  onUnlockClick: () => void;
}) {
  if (isLocked) {
    return (
      <Card>
        <CardContent className="py-4 flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm">
            <span className="font-medium">Locked</span>
            {detail.lockedAt && (
              <span className="text-muted-foreground ml-2">
                on {new Date(detail.lockedAt).toLocaleString()}
              </span>
            )}
          </div>
          <Button
            variant="outline"
            onClick={onUnlockClick}
            disabled={unlockPending}
            data-testid="button-unlock"
          >
            <Unlock className="w-4 h-4 mr-1" /> Unlock
          </Button>
        </CardContent>
      </Card>
    );
  }

  const lockable = openItemsCount === 0 && !isInProgress;
  return (
    <Card>
      <CardContent className="py-4 flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-muted-foreground">
          {isInProgress
            ? "This week is still in progress — lock it from Sunday onward."
            : openItemsCount > 0
              ? `${openItemsCount} item${openItemsCount === 1 ? "" : "s"} still need a decision.`
              : "All items resolved — ready to lock."}
        </div>
        <Button
          onClick={onLock}
          disabled={!lockable || lockPending}
          data-testid="button-lock"
        >
          <Lock className="w-4 h-4 mr-1" />
          {lockPending ? "Locking…" : "Lock week"}
        </Button>
      </CardContent>
    </Card>
  );
}

function PostLockAdditionsCard({
  additions,
}: {
  additions: WeeklyDebriefDetail["postLockAdditions"];
}) {
  if (!additions || additions.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Post-lock additions ({additions.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {additions.map((a) => (
            <div
              key={a.txnId}
              className="flex items-center justify-between gap-3 py-1 text-sm"
              data-testid={`row-postlock-${a.txnId}`}
            >
              <div className="flex-1 truncate">
                <span className="text-muted-foreground tabular-nums text-xs mr-2">
                  {a.date}
                </span>
                {a.description}
              </div>
              <span className="tabular-nums text-muted-foreground">
                {money(a.amount, { signed: true })}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-3 italic">
          These transactions arrived after the week was locked. They aren't in
          the frozen snapshot — unlock and re-lock to fold them in.
        </p>
      </CardContent>
    </Card>
  );
}

// =====================================================================
// Month view: weeks status strip
// =====================================================================

function MonthWeeksStrip({
  monthWeeks,
  onOpenWeek,
}: {
  monthWeeks: WeeklyDebriefListItem[];
  onOpenWeek: (ws: string) => void;
}) {
  if (monthWeeks.length === 0) return null;
  const allLocked = monthWeeks.every((w) => w.status === "locked");
  return (
    <Card data-testid="debrief-month-weeks">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          Weeks this month
          {allLocked && (
            <Badge className="bg-positive/10 text-positive border-positive/30">
              <Lock className="w-3 h-3 mr-1" /> Reconciled
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {monthWeeks.map((w) => {
          const v = Number(w.netSummary.varianceNet);
          const statusLabel =
            w.status === "locked"
              ? "Locked"
              : w.status === "awaiting_review"
                ? "Awaiting review"
                : "In progress";
          const statusColor =
            w.status === "locked"
              ? "bg-positive/10 text-positive border-positive/30"
              : w.status === "awaiting_review"
                ? "bg-warning/10 text-warning border-warning/30"
                : "bg-primary/10 text-primary border-primary/30";
          return (
            <button
              key={w.weekStart}
              type="button"
              onClick={() => onOpenWeek(w.weekStart)}
              className="w-full flex items-center justify-between gap-3 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40"
              data-testid={`month-week-${w.weekStart}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-sm font-medium">
                  {weekRangeLabel(w.weekStart, w.weekEnd)}
                </span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] px-1.5 py-0 h-5", statusColor)}
                >
                  {statusLabel}
                </Badge>
                {w.openItemsCount > 0 && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {w.openItemsCount} open
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <MoneyText
                  amount={v}
                  colored
                  signed
                  className="text-sm font-semibold"
                />
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

// =====================================================================
// Fable 5 — advisor takeaway (Week view)
// =====================================================================

function AdvisorTakeawayCard({
  weekStart,
  summary,
}: {
  weekStart: string;
  summary: WeeklyDebriefAdvisorSummary | null;
}) {
  const queryClient = useQueryClient();
  const generate = useGenerateWeeklyDebriefSummary();
  const { toast } = useToast();

  const handleGenerate = (label: string) => {
    generate.mutate(
      { weekStart },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetWeeklyDebriefQueryKey(weekStart),
          });
          toast({ title: label });
        },
        onError: (err) =>
          toast({
            title: "Couldn't generate takeaway",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const openChat = () => {
    const contextLines = summary
      ? [
          `Locked week of ${weekStart}.`,
          `Headline: ${summary.headline}`,
          ...summary.bullets.map((b) => `- ${b}`),
        ].join("\n")
      : `Locked week of ${weekStart}. (No advisor summary stored.)`;
    openAdvisorChatWithContext({
      weekStart,
      contextBlock: contextLines,
      prompt: "Help me dig deeper into this week — what should I focus on?",
    });
  };

  if (!summary) {
    return (
      <Card data-testid="card-advisor-takeaway">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Fable 5 takeaway
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No takeaway saved for this week yet.
          </p>
          <Button
            size="sm"
            onClick={() => handleGenerate("Takeaway generated")}
            disabled={generate.isPending}
            data-testid="button-advisor-generate"
          >
            {generate.isPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                Generate takeaway
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isFallback = summary.source === "fallback";
  return (
    <Card data-testid="card-advisor-takeaway">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Fable 5 takeaway
            {isFallback && (
              <Badge variant="outline" className="text-[10px] font-normal">
                template
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleGenerate("Fresh takeaway generated")}
            disabled={generate.isPending}
            data-testid="button-advisor-regenerate"
            title="Regenerate takeaway"
          >
            {generate.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          className="text-sm font-semibold leading-snug"
          data-testid="text-advisor-headline"
        >
          {summary.headline}
        </p>
        {summary.bullets.length > 0 && (
          <ul className="text-sm space-y-1 list-disc pl-5 text-foreground/90">
            {summary.bullets.map((b, i) => (
              <li key={i} data-testid={`text-advisor-bullet-${i}`}>
                {b}
              </li>
            ))}
          </ul>
        )}
        {summary.suggestions.length > 0 && (
          <div className="border-t pt-3 space-y-1.5">
            {summary.suggestions.map((s, i) => (
              <div
                key={i}
                className="text-sm flex items-start gap-2 text-foreground/90"
                data-testid={`text-advisor-suggestion-${i}`}
              >
                <span className="text-primary mt-0.5">→</span>
                <span>{s.text}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            Generated {new Date(summary.generatedAt).toLocaleString()}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={openChat}
            data-testid="button-advisor-dig-deeper"
          >
            <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
            Dig deeper
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Month view: roll up each locked week's advisor headline (existing text,
// no new numbers) into one Fable 5 panel for the month.
function MonthTakeawaysCard({
  monthLabelText,
  results,
}: {
  monthLabelText: string;
  results: Array<{ data?: WeeklyDebriefDetail }>;
}) {
  const items = results
    .map((r) => r.data)
    .filter((d): d is WeeklyDebriefDetail => !!d?.advisorSummary)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  if (items.length === 0) {
    return (
      <div data-testid="card-month-takeaways-empty">
        <Callout icon={<Sparkles className="h-4 w-4" />} tone="info">
          Lock the weeks in {monthLabelText} to bank a Fable 5 takeaway for each
          — they'll roll up here.
        </Callout>
      </div>
    );
  }

  return (
    <Card data-testid="card-month-takeaways">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Fable 5 · {monthLabelText}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((d) => (
          <div
            key={d.weekStart}
            className="border-l-2 border-primary/30 pl-3"
            data-testid={`month-takeaway-${d.weekStart}`}
          >
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Week of {shortWeekChipLabel(d.weekStart)}
            </div>
            <p className="text-sm font-medium leading-snug">
              {d.advisorSummary!.headline}
            </p>
            {d.advisorSummary!.bullets.length > 0 && (
              <ul className="mt-1 text-xs space-y-0.5 list-disc pl-4 text-muted-foreground">
                {d.advisorSummary!.bullets.slice(0, 2).map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

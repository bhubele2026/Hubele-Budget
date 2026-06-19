import { useState, useMemo, useEffect } from "react";
import { useLocation, useSearch, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
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
  WeeklyDebriefAdvisorSummary,
} from "@workspace/api-client-react";
import { openAdvisorChatWithContext } from "@/lib/advisorChatBridge";
import { Sparkles, MessageSquare } from "lucide-react";
import type { RecurringItemInput } from "@workspace/api-zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { CategoryPicker } from "@/components/category-picker";
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

// ----- page -----------------------------------------------------------

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
  // edits the user expects to see without a hard refresh. Refetch on
  // mount and on window focus. (The list key shares the /api/debrief/weeks
  // prefix, but we set it per-call here so the intent stays local.)
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

  // ----- Active-week selection ----------------------------------------
  const queryWeek = useMemo(() => {
    const sp = new URLSearchParams(search);
    return sp.get("week");
  }, [search]);

  const activeWeekStart = useMemo<string | null>(() => {
    if (queryWeek && /^\d{4}-\d{2}-\d{2}$/.test(queryWeek)) return queryWeek;
    if (!weeks.length) return null;
    // Prefer the in_progress (current) week, else the most recent
    // awaiting_review, else the latest week we know about.
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

  // ----- Empty: no weeks at all --------------------------------------
  if (weeksQ.isSuccess && weeks.length === 0) {
    return (
      <div className="space-y-6" data-testid="page-debrief">
        <PageHeader />
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-3">
            <CalendarIcon className="w-10 h-10 mx-auto opacity-40" />
            <div>No weekly debriefs yet — once Chase transactions sync in, weeks will appear here for review.</div>
            <Link href="/transactions">
              <Button variant="outline" size="sm">Go to Chase</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!activeWeekStart) {
    return (
      <div className="space-y-6" data-testid="page-debrief">
        <PageHeader />
        <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">Loading…</CardContent></Card>
      </div>
    );
  }

  return (
    <DebriefPageActive
      activeWeekStart={activeWeekStart}
      weeks={weeks}
      onSelectWeek={selectWeek}
      qc={qc}
      toast={toast}
    />
  );
}

function PageHeader() {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Weekly Debrief</h1>
        <p className="text-sm text-muted-foreground">
          Walk through each week: match planned items, accept surprises, then
          lock the week to record a clean monthly variance.
        </p>
      </div>
    </div>
  );
}

// =====================================================================
// Active-week view
// =====================================================================

function DebriefPageActive({
  activeWeekStart,
  weeks,
  onSelectWeek,
  qc,
  toast,
}: {
  activeWeekStart: string;
  weeks: WeeklyDebriefListItem[];
  onSelectWeek: (w: string) => void;
  qc: ReturnType<typeof useQueryClient>;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  // (#823) Always-fresh per-week detail. Each week's detail uses a
  // distinct query key (/api/debrief/weeks/{weekStart}) that the
  // /api/debrief/weeks prefix default doesn't cover, so opt in here:
  // refetch on mount and focus so re-opening a week never shows a stale
  // snapshot after edits/syncs.
  const detailQ = useGetWeeklyDebrief(activeWeekStart, {
    query: {
      queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart),
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  });
  const detail: WeeklyDebriefDetail | undefined = detailQ.data;

  // Pull Plaid txns for this week — needed for the "Pending Bank
  // Transactions" section. We slice client-side to txns whose
  // sentToReviewAt is null AND that appear in the snapshot's bank-txn
  // list (so we don't show e.g. credit-card rows; the snapshot is
  // already constrained to the checking-account source-of-truth).
  const txnQ = useListTransactions(
    detail
      ? { from: detail.weekStart, to: detail.weekEnd, source: "plaid", limit: 500 }
      : undefined,
    { query: { enabled: !!detail } as any },
  );

  const { data: categories } = useListCategories();
  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    (categories ?? []).forEach((c) => m.set(c.id, c.name));
    return m;
  }, [categories]);
  // For the Category Variance table's color logic: income variance
  // colors must flip (more income = good = green, less = red), while
  // expense variance keeps the default (over = red, under = green).
  // Buckets whose categoryId isn't in this map (null or orphan) fall
  // back to expense semantics.
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
    qc.invalidateQueries({ queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart) });
    qc.invalidateQueries({ queryKey: getListWeeklyDebriefsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
  };

  // (#801) Recategorize a single transaction straight from the
  // Category-variance popover, without leaving /debrief. Mirrors the
  // /chase + /forecast PATCH: `{ categoryId, rememberPattern? }`. On
  // success we invalidate the weekly-debrief (so the variance table +
  // popover repaint with the txn in its new bucket) plus the
  // transactions list (so the round-trip shows on /chase). The popover
  // is intentionally NOT closed — the caller lets the user keep editing.
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
          qc.invalidateQueries({ queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart) });
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

  const handleReschedule = (plan: WeeklyDebriefPlanItem, targetSunday: string) => {
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
            title: status === "missed" ? `Marked "${plan.name}" missed` : `Skipped "${plan.name}"`,
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
      dayOfMonth: Number.isFinite(dom) && dom >= 1 && dom <= 31 ? String(dom) : "1",
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
      toast({ title: "Amount must be a positive number", variant: "destructive" });
      return;
    }
    if (addBillSeed.frequency === "onetime" && !addBillSeed.anchorDate) {
      toast({ title: "Pick a date for the one-time item", variant: "destructive" });
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
    if (addBillSeed.frequency === "monthly" || addBillSeed.frequency === "semimonthly") {
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
          // Also acknowledge the source txn so it drops from open
          // items in the Debrief (and counts toward
          // convertedToRecurringCount semantically via the actions
          // summary fallback).
          upsertResolution.mutate(
            {
              data: {
                status: "ignored_unforecasted",
                matchedTxnId: addBillSeed.sourceTxnId,
              },
            },
            {
              onSettled: () => {
                qc.invalidateQueries({ queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart) });
                qc.invalidateQueries({ queryKey: getListWeeklyDebriefsQueryKey() });
                qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
                qc.invalidateQueries({ queryKey: getListRecurringItemsQueryKey() });
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

  // -- Render ---------------------------------------------------------

  const isLoading = detailQ.isLoading;
  const snapshot = detail?.varianceSnapshot ?? null;
  const isLocked = detail?.status === "locked";
  const isInProgress = detail?.status === "in_progress";
  const openItemsCount = snapshot?.openItemsCount ?? 0;

  // Pending Chase txns for this week: intersect Plaid txns (this week)
  // with the snapshot's bank-txn ids. Single-flow restore — the old
  // sent_to_review gate is gone, so "pending to triage" is just the
  // week's forecast-flagged bank rows.
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

  return (
    <div className="space-y-6" data-testid="page-debrief">
      <PageHeader />

      <WeekChipRow
        weeks={weeks}
        activeWeekStart={activeWeekStart}
        onSelect={onSelectWeek}
      />

      {isLoading || !detail ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            Loading week…
          </CardContent>
        </Card>
      ) : (
        <>
          <WeekHeader detail={detail} />

          {!snapshot ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-3">
                <CalendarIcon className="w-10 h-10 mx-auto opacity-40" />
                <div>
                  {isInProgress
                    ? "Nothing to review yet for this week — sync Chase and check back."
                    : "No snapshot for this week."}
                </div>
                <Link href="/transactions">
                  <Button variant="outline" size="sm">Go to Chase</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <>
              <VarianceSummaryCard
                snapshot={snapshot}
                byCategory={snapshot.byCategory}
                catNameById={catNameById}
                catKindById={catKindById}
                categories={categories ?? []}
                onChangeTxnCategory={isLocked ? undefined : handleChangeTxnCategory}
              />

              {isLocked && (
                <AdvisorTakeawayCard
                  weekStart={activeWeekStart}
                  summary={detail.advisorSummary ?? null}
                />
              )}

              <CategoryVarianceTable
                buckets={snapshot.byCategory}
                catNameById={catNameById}
                catKindById={catKindById}
                categories={categories ?? []}
                onChangeTxnCategory={isLocked ? undefined : handleChangeTxnCategory}
              />

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
                <PostLockAdditionsCard additions={detail.postLockAdditions} />
              )}

              <LockFooter
                isLocked={isLocked}
                isInProgress={isInProgress}
                openItemsCount={openItemsCount}
                detail={detail}
                lockPending={lockWeek.isPending}
                unlockPending={unlockWeek.isPending}
                onLock={handleLock}
                onUnlockClick={() => setUnlockConfirmOpen(true)}
              />
            </>
          )}

          <MonthlySummaryCard activeWeekStart={activeWeekStart} weeks={weeks} />
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
        <DialogContent className="sm:max-w-md" data-testid="dialog-debrief-add-bill">
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
                    <SelectTrigger aria-label="Type"><SelectValue /></SelectTrigger>
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
                    <SelectTrigger aria-label="Frequency"><SelectValue /></SelectTrigger>
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
                      {addBillSeed.frequency === "onetime" ? "Date" : "Anchor date"}
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
                lock, and the new {addBillSeed.kind === "income" ? "income" : "bill"}{" "}
                appears in your forecast going forward.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddBillSeed(null)}
              disabled={createRecurring.isPending}
            >Cancel</Button>
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
// Subcomponents
// =====================================================================

function WeekHeader({ detail }: { detail: WeeklyDebriefDetail }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div>
        <div className="text-lg font-semibold">
          Week of {weekRangeLabel(detail.weekStart, detail.weekEnd)}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {detail.weekStart} → {detail.weekEnd}
        </div>
      </div>
      <StatusBadge detail={detail} />
    </div>
  );
}

function StatusBadge({ detail }: { detail: WeeklyDebriefDetail }) {
  if (detail.status === "locked") {
    return (
      <Badge className="bg-emerald-100 text-emerald-900 border-emerald-300" data-testid="badge-status-locked">
        <Lock className="w-3 h-3 mr-1" /> Locked
      </Badge>
    );
  }
  if (detail.status === "in_progress") {
    return (
      <Badge variant="outline" className="bg-sky-50 text-sky-900 border-sky-300" data-testid="badge-status-inprogress">
        In progress
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-300" data-testid="badge-status-awaiting">
      <AlertCircle className="w-3 h-3 mr-1" /> Awaiting review
    </Badge>
  );
}

function WeekChipRow({
  weeks,
  activeWeekStart,
  onSelect,
}: {
  weeks: WeeklyDebriefListItem[];
  activeWeekStart: string;
  onSelect: (w: string) => void;
}) {
  // Sort oldest → newest, so the most recent week sits on the right
  // (Amex / Chase navigator convention).
  const sorted = useMemo(
    () => [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    [weeks],
  );
  return (
    <div className="border rounded-lg bg-card p-2 overflow-x-auto" data-testid="week-chip-row">
      <div className="flex items-center gap-2">
        {sorted.map((w) => {
          const isActive = w.weekStart === activeWeekStart;
          const statusColor =
            w.status === "locked"
              ? "bg-emerald-100 text-emerald-900 border-emerald-300"
              : w.status === "awaiting_review"
                ? "bg-amber-100 text-amber-900 border-amber-300"
                : "bg-sky-50 text-sky-900 border-sky-300";
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
                  <span className="text-[10px] opacity-75">·{w.openItemsCount}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// (#805) Collapsible per-category section inside the Variance-summary
// Income/Expenses popover. Header = category name + that bucket's actual
// total; body = the bucket's actual txns, each with an inline picker
// (preselected to the bucket's category) when editing is enabled.
function SummaryCategorySection({
  bucket,
  catNameById,
  categories,
  onChangeTxnCategory,
}: {
  bucket: WeeklyDebriefCategoryBucket;
  catNameById: Map<string, string>;
  categories?: { id: string; name: string }[];
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
}) {
  const [open, setOpen] = useState(true);
  const name = bucket.categoryId
    ? catNameById.get(bucket.categoryId) ?? "Uncategorized"
    : "Uncategorized";
  const txns = bucket.actualTxns ?? [];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 focus:outline-none"
          data-testid={`summary-section-${name.replace(/\s+/g, "-").toLowerCase()}`}
        >
          <span className="flex min-w-0 items-center gap-1 font-medium">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{name}</span>
          </span>
          <span className="tabular-nums whitespace-nowrap">{money(bucket.actualAmount)}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {txns.map((t, i) => (
          <ActualTxnRow
            key={t.txnId + i}
            txn={t}
            categoryId={bucket.categoryId}
            categories={categories}
            onChangeTxnCategory={onChangeTxnCategory}
            testIdPrefix="debrief-summary-category"
            className="pl-7"
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// (#805) Grouped drill-down popover for the Variance-summary Income /
// Expenses Actual cell. Content is built client-side from the existing
// `byCategory` buckets (filtered to this row's kind) — no server change.
// Falls back to plain text when there is nothing to drill into.
function SummaryActualPopover({
  label,
  amount,
  buckets,
  catNameById,
  categories,
  onChangeTxnCategory,
}: {
  label: string;
  amount: string;
  buckets: WeeklyDebriefCategoryBucket[];
  catNameById: Map<string, string>;
  categories?: { id: string; name: string }[];
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
}) {
  const sections = buckets.filter((b) => (b.actualTxns?.length ?? 0) > 0);
  const clickable = Number(amount) !== 0 && sections.length > 0;
  if (!clickable) {
    return <div className="px-4 py-2 text-right tabular-nums">{money(amount)}</div>;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full px-4 py-2 text-right tabular-nums cursor-pointer hover:underline underline-offset-2 focus:outline-none focus:underline"
          data-testid={`variance-summary-cell-${label.toLowerCase()}`}
        >
          {money(amount)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Actual</div>
          <div className="text-sm font-medium">{label}</div>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {sections.map((b) => (
            <SummaryCategorySection
              key={b.categoryId ?? "_"}
              bucket={b}
              catNameById={catNameById}
              categories={categories}
              onChangeTxnCategory={onChangeTxnCategory}
            />
          ))}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-medium tabular-nums">{money(amount)}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function VarianceSummaryCard({
  snapshot,
  byCategory,
  catNameById,
  catKindById,
  categories,
  onChangeTxnCategory,
}: {
  snapshot: NonNullable<WeeklyDebriefDetail["varianceSnapshot"]>;
  byCategory: WeeklyDebriefCategoryBucket[];
  catNameById: Map<string, string>;
  catKindById: Map<string, "income" | "expense">;
  categories: { id: string; name: string }[];
  // (#805) Optional — omitted on a locked week so the Income/Expenses
  // popovers stay read-only (no inline pickers).
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
}) {
  const t = snapshot.totals;
  // (#805) Split the byCategory buckets by their category kind so the
  // Income/Expenses popovers list the right transactions. Buckets whose
  // categoryId is null/unknown fall back to expense semantics — matching
  // the Category-variance table's coloring logic.
  const incomeBuckets = useMemo(
    () =>
      byCategory.filter(
        (b) => b.categoryId && catKindById.get(b.categoryId) === "income",
      ),
    [byCategory, catKindById],
  );
  const expenseBuckets = useMemo(
    () =>
      byCategory.filter(
        (b) => !(b.categoryId && catKindById.get(b.categoryId) === "income"),
      ),
    [byCategory, catKindById],
  );
  const rows: Array<{
    label: string;
    planned: string;
    actual: string;
    variance: number;
    positiveIsBad: boolean;
    drillBuckets?: WeeklyDebriefCategoryBucket[];
  }> = [
    {
      label: "Income",
      planned: t.plannedIncome,
      actual: t.actualIncome,
      variance: Number(t.actualIncome) - Number(t.plannedIncome),
      positiveIsBad: false,
      drillBuckets: incomeBuckets,
    },
    {
      label: "Expenses",
      planned: t.plannedExpenses,
      actual: t.actualExpenses,
      variance: Number(t.actualExpenses) - Number(t.plannedExpenses),
      positiveIsBad: true,
      drillBuckets: expenseBuckets,
    },
    {
      label: "Net",
      planned: t.plannedNet,
      actual: t.actualNet,
      variance: Number(t.varianceNet),
      positiveIsBad: false,
    },
  ];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Variance summary</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/4"></TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const bad = r.positiveIsBad ? r.variance > 0 : r.variance < 0;
              return (
                <TableRow key={r.label}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.planned)}</TableCell>
                  {/* (#805) Income/Expenses Actual cells drill into a
                      grouped popover; Net stays plain text. */}
                  {r.drillBuckets ? (
                    <TableCell className="text-right tabular-nums p-0">
                      <SummaryActualPopover
                        label={r.label}
                        amount={r.actual}
                        buckets={r.drillBuckets}
                        catNameById={catNameById}
                        categories={categories}
                        onChangeTxnCategory={onChangeTxnCategory}
                      />
                    </TableCell>
                  ) : (
                    <TableCell className="text-right tabular-nums">{money(r.actual)}</TableCell>
                  )}
                  <TableCell
                    className={cn(
                      "text-right tabular-nums font-medium",
                      bad ? "text-red-600" : "text-emerald-700",
                    )}
                    data-testid={`variance-${r.label.toLowerCase()}`}
                  >
                    {money(r.variance, { signed: true })}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// (#805) Shared row for an actual transaction inside a drill-down
// popover (used by both the Category-variance popover and the new
// Variance-summary grouped popovers). Renders the description/date/
// amount line and, when editing is enabled, an inline CategoryPicker
// preselected to the bucket's categoryId.
// (#866) Category actuals blend Chase checking + Amex (task #856), so a
// category's Actual total can legitimately exceed the Chase-only top-line
// cash flow. Tag each drill-down row by its card so the blended number is
// self-explanatory. Mirrors the backend `isAmexRow` predicate: strip a
// leading `plaid:` and treat "amex" as Amex, everything else as Chase.
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
              <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
                unplanned
              </Badge>
            )}
          </div>
        </div>
        <div className="tabular-nums whitespace-nowrap">
          {money(Math.abs(txn.amount), { signed: false })}
        </div>
      </div>
      {/* (#801/#805) Inline recategorization — same picker as /chase,
          full category list. Initial value is the bucket's categoryId
          (shared by every txn here). Pass through rememberPattern so the
          next matching description auto-categorizes. Popover stays open.
          Hidden entirely when editing is disabled (e.g. a locked week). */}
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

// (#801) Drill-down popover for a single Planned or Actual cell in the
// Category Variance table. Click on a non-zero amount opens a list of
// the line items that compose it. The cell shows zero amounts as
// plain text (not clickable) — there is nothing to drill into.
function VarianceCellPopover({
  kind,
  categoryName,
  amount,
  plannedItems,
  actualTxns,
  categoryId,
  categories,
  onChangeTxnCategory,
}: {
  kind: "planned" | "actual";
  categoryName: string;
  amount: string;
  plannedItems?: NonNullable<WeeklyDebriefCategoryBucket["plannedItems"]>;
  actualTxns?: NonNullable<WeeklyDebriefCategoryBucket["actualTxns"]>;
  // (#801) Bucket's categoryId — used as the inline picker's initial
  // value (all txns in a bucket share the same category). Only the
  // Actual cell threads these through; the Planned side stays read-only.
  categoryId?: string | null;
  categories?: { id: string; name: string }[];
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
}) {
  const num = Number(amount);
  const hasItems =
    kind === "planned"
      ? (plannedItems?.length ?? 0) > 0
      : (actualTxns?.length ?? 0) > 0;
  const clickable = num !== 0 && hasItems;
  if (!clickable) {
    return <div className="px-4 py-2">{money(amount)}</div>;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full px-4 py-2 text-right tabular-nums cursor-pointer hover:underline underline-offset-2 focus:outline-none focus:underline"
          data-testid={`variance-cell-${kind}-${categoryName.replace(/\s+/g, "-").toLowerCase()}`}
        >
          {money(amount)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {kind === "planned" ? "Planned" : "Actual"}
          </div>
          <div className="text-sm font-medium">{categoryName}</div>
          {/* (#866) Category actuals blend Amex charges in with Chase
              checking spend, so this total can exceed the Chase-only
              top-line cash flow. Tag each row by card so it's clear. */}
          {kind === "actual" && (
            <div
              className="mt-1 text-[11px] leading-snug text-muted-foreground"
              data-testid="debrief-variance-category-source-note"
            >
              Includes Amex charges, so this can be higher than the
              Chase-only cash-flow totals above.
            </div>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {kind === "planned"
            ? plannedItems!.map((p, i) => (
                <div
                  key={(p.recurringItemId ?? "") + i}
                  className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-[11px] text-muted-foreground">{p.forecastDate}</div>
                  </div>
                  <div className="tabular-nums whitespace-nowrap">{money(p.amount)}</div>
                </div>
              ))
            : actualTxns!.map((t, i) => (
                <ActualTxnRow
                  key={t.txnId + i}
                  txn={t}
                  categoryId={categoryId}
                  categories={categories}
                  onChangeTxnCategory={onChangeTxnCategory}
                  testIdPrefix="debrief-variance-category"
                />
              ))}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-medium tabular-nums">{money(amount)}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CategoryVarianceTable({
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
  // (#801/#805) Optional — omitted when the week is locked. A locked
  // debrief is a frozen snapshot, so recategorizing wouldn't move the
  // buckets even though the PATCH would succeed. Leaving it undefined
  // hides the inline pickers and keeps the popover read-only.
  onChangeTxnCategory?: (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => void;
}) {
  const [open, setOpen] = useState(true);
  const sorted = useMemo(
    () =>
      [...buckets].sort(
        (a, b) => Math.abs(Number(b.varianceAmount)) - Math.abs(Number(a.varianceAmount)),
      ),
    [buckets],
  );

  // Per-category show/hide filter. The variance table can list 20+ rows
  // (loans, uncategorized buckets, every income line); most users only
  // track a handful. `visibleKeys === null` means "show all" (default);
  // once the user customizes, we persist the explicit set of category
  // keys to keep on this device. A row's key is its categoryId, or
  // "_uncat" for the null/unmapped bucket.
  const STORAGE_KEY = "h2:debrief:visibleCats";
  const keyOf = (b: WeeklyDebriefCategoryBucket): string =>
    b.categoryId ?? "_uncat";
  const [visibleKeys, setVisibleKeys] = useState<Set<string> | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set<string>(arr) : null;
    } catch {
      return null;
    }
  });
  const persistVisible = (next: Set<string> | null) => {
    setVisibleKeys(next);
    try {
      if (next === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore quota / disabled storage */
    }
  };
  const allKeys = useMemo(() => sorted.map(keyOf), [sorted]);
  const toggleKey = (key: string, checked: boolean) => {
    const base = visibleKeys ? new Set(visibleKeys) : new Set(allKeys);
    if (checked) base.add(key);
    else base.delete(key);
    // If everything ends up checked, drop the filter back to "show all".
    persistVisible(allKeys.every((k) => base.has(k)) ? null : base);
  };
  const visible = useMemo(
    () =>
      visibleKeys
        ? sorted.filter((b) => visibleKeys.has(keyOf(b)))
        : sorted,
    [sorted, visibleKeys],
  );
  const filterActive = visibleKeys !== null;
  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                Category variance
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {filterActive
                  ? `${visible.length} of ${sorted.length} categories`
                  : `${sorted.length} categories`}
              </span>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            {sorted.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">No category activity this week.</div>
            ) : (
              <>
              <div className="flex items-center justify-end pb-3">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      data-testid="debrief-category-filter"
                    >
                      {filterActive ? `Filtered · ${visible.length}` : "Customize"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 p-0">
                    <div className="flex items-center justify-between px-3 py-2 border-b">
                      <span className="text-xs font-medium">Show categories</span>
                      <div className="flex gap-3">
                        <button
                          type="button"
                          className="text-[11px] text-primary hover:underline"
                          onClick={() => persistVisible(null)}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          className="text-[11px] text-primary hover:underline"
                          onClick={() => persistVisible(new Set())}
                        >
                          None
                        </button>
                      </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto py-1">
                      {sorted.map((b) => {
                        const key = keyOf(b);
                        const name = b.categoryId
                          ? (catNameById.get(b.categoryId) ?? "Uncategorized")
                          : "Uncategorized";
                        const checked = !visibleKeys || visibleKeys.has(key);
                        return (
                          <label
                            key={key}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(c) => toggleKey(key, c === true)}
                            />
                            <span className="truncate">{name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Planned</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Δ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-sm text-muted-foreground py-4"
                      >
                        All categories hidden — click Customize to pick what to show.
                      </TableCell>
                    </TableRow>
                  ) : visible.map((b, i) => {
                    const name = b.categoryId ? (catNameById.get(b.categoryId) ?? "Uncategorized") : "Uncategorized";
                    const v = Number(b.varianceAmount);
                    // Income: positive variance (earned more) = green;
                    // negative (earned less) = red. Expense: keep the
                    // default — positive (overspent) = red, negative
                    // (underspent) = green. Unknown/null categoryId
                    // defaults to expense semantics.
                    const kind = b.categoryId
                      ? (catKindById.get(b.categoryId) ?? "expense")
                      : "expense";
                    const goodColor = "text-emerald-700";
                    const badColor = "text-red-600";
                    const varianceColor =
                      v === 0
                        ? ""
                        : kind === "income"
                          ? v > 0
                            ? goodColor
                            : badColor
                          : v > 0
                            ? badColor
                            : goodColor;
                    return (
                      <TableRow key={b.categoryId ?? "_uncat"}>
                        <TableCell className="font-medium">
                          {name}
                          {kind === "income" && (
                            <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                              income
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums p-0">
                          <VarianceCellPopover
                            kind="planned"
                            categoryName={name}
                            amount={b.plannedAmount}
                            plannedItems={b.plannedItems ?? []}
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums p-0">
                          <VarianceCellPopover
                            kind="actual"
                            categoryName={name}
                            amount={b.actualAmount}
                            actualTxns={b.actualTxns ?? []}
                            categoryId={b.categoryId}
                            categories={categories}
                            onChangeTxnCategory={onChangeTxnCategory}
                          />
                        </TableCell>
                        <TableCell
                          className={cn("text-right tabular-nums", varianceColor)}
                        >
                          {money(v, { signed: true })}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// =====================================================================
// Action panel — 3 collapsible sections
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
  snapshot: NonNullable<WeeklyDebriefDetail["varianceSnapshot"]>;
  pendingBankTxns: Array<{ id: string; description: string; amount: string; occurredOn: string; categoryId?: string | null }>;
  catNameById: Map<string, string>;
  weekStart: string;
  onMatchPlan: (plan: WeeklyDebriefPlanItem, txnId: string) => void;
  onReschedulePlan: (plan: WeeklyDebriefPlanItem, targetSunday: string) => void;
  onPlanStatus: (plan: WeeklyDebriefPlanItem, status: "missed" | "skipped") => void;
  onAcceptUnplanned: (txn: WeeklyDebriefTxnItem) => void;
  onConvertToRecurring: (txn: WeeklyDebriefTxnItem) => void;
  onSendToReview: (txnId: string) => void;
  upsertPending: boolean;
  sendPending: boolean;
}) {
  const unmatchedPlans = snapshot.unmatchedPlans;
  // Open unplanned only (acknowledged ones already dropped from open
  // items but stay visible in the snapshot; we surface those separately
  // below the open list with a muted note).
  const openUnplanned = snapshot.unplannedTxns.filter((t) => t.status === "unplanned");
  const acknowledgedUnplanned = snapshot.unplannedTxns.filter((t) => t.status === "acknowledged_unplanned");
  // Candidate bank txns for the Match dropdown: only the still-open
  // unplanned ones (acknowledged or matched txns are already used).
  const candidateTxns = openUnplanned;

  const [openPlans, setOpenPlans] = useState(true);
  const [openUnp, setOpenUnp] = useState(true);
  const [openPending, setOpenPending] = useState(true);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Action panel</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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
                Acknowledged ({acknowledgedUnplanned.length}) — still counted in variance
              </div>
              <div className="space-y-1">
                {acknowledgedUnplanned.map((txn) => (
                  <div
                    key={txn.txnId}
                    className="flex items-center justify-between gap-3 text-sm py-1 px-2 rounded bg-muted/30"
                    data-testid={`row-acknowledged-${txn.txnId}`}
                  >
                    <div className="flex-1 truncate">
                      <span className="text-muted-foreground tabular-nums text-xs mr-2">{txn.date}</span>
                      {txn.description}
                    </div>
                    <span className="tabular-nums text-muted-foreground">{money(txn.amount, { signed: true })}</span>
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
                    <span className="ml-2">· {catNameById.get(tx.categoryId)}</span>
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
    <Collapsible open={open} onOpenChange={onOpenChange} className="border rounded-md">
      <CollapsibleTrigger className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/40">
        <div className="flex items-center gap-2 text-sm font-medium">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          {title}
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 h-5 tabular-nums",
              count > 0 ? "bg-amber-100 text-amber-900 border-amber-300" : "bg-emerald-100 text-emerald-900 border-emerald-300",
            )}
          >
            {count}
          </Badge>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3">
          {count === 0 ? (
            <div className="text-xs text-muted-foreground py-2 italic">{emptyText}</div>
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

  const catName = plan.categoryId ? (catNameById.get(plan.categoryId) ?? null) : null;
  const sign = plan.kind === "income" ? 1 : -1;

  return (
    <div className="py-2 border-b last:border-0 space-y-2" data-testid={`row-plan-${plan.recurringItemId ?? "noid"}-${plan.forecastDate}`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{plan.name}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {plan.forecastDate} · {money(sign * Number(plan.forecastAmount), { signed: true })}
            {catName && <span className="ml-2">· {catName}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 justify-end">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setMatchOpen((v) => !v)} data-testid={`button-match-${plan.recurringItemId}`}>
            <CheckCircle2 className="w-3 h-3 mr-1" /> Match
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRescheduleOpen((v) => !v)} data-testid={`button-reschedule-${plan.recurringItemId}`}>
            <RefreshCcw className="w-3 h-3 mr-1" /> Reschedule
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onStatus(plan, "missed")} data-testid={`button-missed-${plan.recurringItemId}`}>
            <X className="w-3 h-3 mr-1" /> Missed
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onStatus(plan, "skipped")} data-testid={`button-skip-${plan.recurringItemId}`}>
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
                    <span className="text-muted-foreground tabular-nums mr-2">{t.date}</span>
                    {t.description}
                  </span>
                  <span className="tabular-nums">{money(t.amount, { signed: true })}</span>
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
  const catName = txn.categoryId ? (catNameById.get(txn.categoryId) ?? null) : null;
  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0" data-testid={`row-unplanned-${txn.txnId}`}>
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
        <CardTitle className="text-base">Post-lock additions ({additions.length})</CardTitle>
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
                <span className="text-muted-foreground tabular-nums text-xs mr-2">{a.date}</span>
                {a.description}
              </div>
              <span className="tabular-nums text-muted-foreground">{money(a.amount, { signed: true })}</span>
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
// (#802 — Phase E) Advisor takeaway card — locked-week-only
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
    // Bake the summary into a context block + a starter prompt so the
    // chat sees the actual numbers without needing a dedicated tool.
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

  // -- Empty state: older locked week with no summary --
  if (!summary) {
    return (
      <Card data-testid="card-advisor-takeaway">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Advisor takeaway
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
            Advisor takeaway
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
        <p className="text-sm font-semibold leading-snug" data-testid="text-advisor-headline">
          {summary.headline}
        </p>
        {summary.bullets.length > 0 && (
          <ul className="text-sm space-y-1 list-disc pl-5 text-foreground/90">
            {summary.bullets.map((b, i) => (
              <li key={i} data-testid={`text-advisor-bullet-${i}`}>{b}</li>
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

// =====================================================================
// Monthly summary — only when every week in the month is locked
// =====================================================================

function MonthlySummaryCard({
  activeWeekStart,
  weeks,
}: {
  activeWeekStart: string;
  weeks: WeeklyDebriefListItem[];
}) {
  const month = monthKey(activeWeekStart);
  const monthWeeks = useMemo(() => {
    return weeks.filter((w) => monthKey(w.weekStart) === month);
  }, [weeks, month]);

  if (monthWeeks.length === 0) return null;
  const allLocked = monthWeeks.every((w) => w.status === "locked");
  if (!allLocked) return null;

  let plannedNet = 0;
  let actualNet = 0;
  let varianceNet = 0;
  let plannedAbsTotal = 0;
  for (const w of monthWeeks) {
    plannedNet += Number(w.netSummary.plannedNet);
    actualNet += Number(w.netSummary.actualNet);
    varianceNet += Number(w.netSummary.varianceNet);
    plannedAbsTotal += Math.abs(Number(w.netSummary.plannedNet));
  }
  const accuracy = plannedAbsTotal === 0
    ? null
    : Math.max(0, (1 - Math.abs(varianceNet) / plannedAbsTotal) * 100);

  return (
    <Card data-testid="card-monthly-summary">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {monthLabel(month)}
            <Badge className="bg-emerald-100 text-emerald-900 border-emerald-300">
              <Lock className="w-3 h-3 mr-1" /> Reconciled
            </Badge>
          </CardTitle>
          {accuracy !== null && (
            <span className="text-sm font-medium tabular-nums" data-testid="text-variance-accuracy">
              Variance accuracy: {accuracy.toFixed(1)}%
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead></TableHead>
              <TableHead className="text-right">Planned net</TableHead>
              <TableHead className="text-right">Actual net</TableHead>
              <TableHead className="text-right">Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">{monthWeeks.length} week{monthWeeks.length === 1 ? "" : "s"}</TableCell>
              <TableCell className="text-right tabular-nums">{money(plannedNet)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(actualNet)}</TableCell>
              <TableCell
                className={cn(
                  "text-right tabular-nums font-medium",
                  varianceNet < 0 ? "text-red-600" : "text-emerald-700",
                )}
              >
                {money(varianceNet, { signed: true })}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

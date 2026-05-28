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
} from "lucide-react";
import {
  useListWeeklyDebriefs,
  useGetWeeklyDebrief,
  useLockWeeklyDebrief,
  useUnlockWeeklyDebrief,
  useUpsertForecastResolution,
  useCreateRecurringItem,
  useSendTransactionsToReview,
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
} from "@workspace/api-client-react";
import type { RecurringItemInput } from "@workspace/api-zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
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

  const weeksQ = useListWeeklyDebriefs({ from: fromISO, to: toISO });
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
  const detailQ = useGetWeeklyDebrief(activeWeekStart);
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

  const invalidateAfterResolution = () => {
    qc.invalidateQueries({ queryKey: getGetWeeklyDebriefQueryKey(activeWeekStart) });
    qc.invalidateQueries({ queryKey: getListWeeklyDebriefsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
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
  // with the snapshot's bank-txn ids, filter to sentToReviewAt==null.
  const snapshotTxnIds = useMemo(
    () => new Set((snapshot?.transactions ?? []).map((t) => t.txnId)),
    [snapshot],
  );
  const pendingBankTxns = useMemo(() => {
    if (!txnQ.data) return [];
    return txnQ.data.filter(
      (t) => !t.sentToReviewAt && snapshotTxnIds.has(t.id),
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
              <VarianceSummaryCard snapshot={snapshot} />
              <CategoryVarianceTable
                buckets={snapshot.byCategory}
                catNameById={catNameById}
                catKindById={catKindById}
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
                    <SelectTrigger><SelectValue /></SelectTrigger>
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
                    <SelectTrigger><SelectValue /></SelectTrigger>
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

function VarianceSummaryCard({ snapshot }: { snapshot: NonNullable<WeeklyDebriefDetail["varianceSnapshot"]> }) {
  const t = snapshot.totals;
  const rows: Array<{ label: string; planned: string; actual: string; variance: number; positiveIsBad: boolean }> = [
    {
      label: "Income",
      planned: t.plannedIncome,
      actual: t.actualIncome,
      variance: Number(t.actualIncome) - Number(t.plannedIncome),
      positiveIsBad: false,
    },
    {
      label: "Expenses",
      planned: t.plannedExpenses,
      actual: t.actualExpenses,
      variance: Number(t.actualExpenses) - Number(t.plannedExpenses),
      positiveIsBad: true,
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
                  <TableCell className="text-right tabular-nums">{money(r.actual)}</TableCell>
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

function CategoryVarianceTable({
  buckets,
  catNameById,
  catKindById,
}: {
  buckets: WeeklyDebriefCategoryBucket[];
  catNameById: Map<string, string>;
  catKindById: Map<string, "income" | "expense">;
}) {
  const [open, setOpen] = useState(true);
  const sorted = useMemo(
    () =>
      [...buckets].sort(
        (a, b) => Math.abs(Number(b.varianceAmount)) - Math.abs(Number(a.varianceAmount)),
      ),
    [buckets],
  );
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
              <span className="text-xs text-muted-foreground">{sorted.length} categories</span>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            {sorted.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">No category activity this week.</div>
            ) : (
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
                  {sorted.map((b, i) => {
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
                      <TableRow key={(b.categoryId ?? "_") + i}>
                        <TableCell className="font-medium">
                          {name}
                          {kind === "income" && (
                            <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                              income
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(b.plannedAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(b.actualAmount)}</TableCell>
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

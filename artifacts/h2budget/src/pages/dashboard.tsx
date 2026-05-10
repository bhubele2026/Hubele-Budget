import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  customFetch,
  useGetDashboard,
  useGetBudgetMonth,
  useGetForecast,
  useListTransactions,
  useListMappingRules,
  useListDashboardBudgets,
  useListDebts,
  useListPlaidItems,
  useUpsertDashboardBudget,
  useDeleteDashboardBudget,
  useUpdateTransaction,
  useListWeeklySettlements,
  useCloseOutWeek,
  useReopenWeek,
  getListWeeklySettlementsQueryKey,
  getListDashboardBudgetsQueryKey,
  getListTransactionsQueryKey,
  type Transaction,
  type MappingRule,
} from "@workspace/api-client-react";
import { MatchedRuleChip } from "@/components/matched-rule-chip";
import {
  computeChaseEndOfMonthBalance,
  scopeChaseTransactions,
} from "@/lib/chaseEndingBalance";
import {
  computeAmexEndOfMonthBalance,
  resolveAmexAnchor,
  resolveAmexDebt,
} from "@/lib/amexEndingBalance";
import { monthKeyOf } from "@/components/account-page";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { DashboardKillOrder } from "@/components/dashboard-kill-order";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { AvalancheReadyCard } from "@/components/avalanche-ready-card";
import { DebtReauthBanner } from "@/components/debt-plaid-link";
import { PlaidExpiringSoonList } from "@/components/plaid-expiring-soon-list";

import { SUB_BUCKETS, type SubBucket, useWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import {
  computeViewMonth,
  isAtFloor as isViewMonthAtFloor,
  monthLabelFor,
} from "@/lib/dashboardMonthCycler";

function fmtISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function expenseAmount(t: Transaction): number {
  const a = Number(t.amount) || 0;
  return a < 0 ? -a : 0;
}

// (#28) Compact label for non-Amex sources surfaced in the WK/MO/UN row
// lists when "Include other sources" is on. Returns null for Amex (the
// implicit default) so the badge stays out of the way for the common case.
// "plaid:chase" -> "chase", "plaid:bank" -> "bank", "manual" -> "manual".
export function nonAmexSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.toLowerCase();
  if (s === "amex" || s === "plaid:amex") return null;
  if (s.startsWith("plaid:")) return s.slice("plaid:".length);
  return s;
}

// (#278) Canonical chip label for any tagged source — including Amex.
// Used to derive the source-filter chip row above the WK/MO/UN buckets and
// to test row membership against the user's selected-source set.
export function dashboardSourceLabel(source: string | null | undefined): string {
  if (!source) return "unknown";
  const s = source.toLowerCase();
  if (s === "amex" || s === "plaid:amex") return "amex";
  if (s.startsWith("plaid:")) return s.slice("plaid:".length);
  return s;
}

function SourceTag({ label }: { label: string }) {
  return (
    <span
      className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-muted-foreground/30 text-muted-foreground shrink-0"
      title={`Source: ${label}`}
    >
      {label}
    </span>
  );
}

function useBudgetEditor(bucket: "weekly" | "monthly" | "unplanned", periodKey: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: budgets } = useListDashboardBudgets({ bucket, periodKey });
  const upsert = useUpsertDashboardBudget();
  const del = useDeleteDashboardBudget();
  const row = budgets?.[0];
  const saved = Number(row?.amount ?? 0);
  const isDefault = row?.isDefault ?? true;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const beginEdit = () => {
    setDraft(saved ? String(saved) : "");
    setEditing(true);
  };
  const save = () => {
    upsert.mutate(
      { data: { bucket, periodKey, amount: draft || "0" } },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getListDashboardBudgetsQueryKey({ bucket, periodKey }),
          });
          setEditing(false);
          toast({ title: "Budget updated" });
        },
      },
    );
  };
  const resetToDefault = () => {
    del.mutate(
      { params: { bucket, periodKey } },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getListDashboardBudgetsQueryKey({ bucket, periodKey }),
          });
          toast({ title: "Reverted to Settings default" });
        },
      },
    );
  };
  return {
    saved,
    isDefault,
    editing,
    draft,
    setDraft,
    beginEdit,
    save,
    setEditing,
    resetToDefault,
    isPending: upsert.isPending,
    isResetting: del.isPending,
  };
}

function CapInline({
  saved,
  isDefault,
  editing,
  draft,
  setDraft,
  beginEdit,
  save,
  setEditing,
  resetToDefault,
  isPending,
  isResetting,
}: ReturnType<typeof useBudgetEditor>) {
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          type="number"
          step="0.01"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 w-28 inline-block"
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <Button size="sm" onClick={save} disabled={isPending}>
          Save
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-2">
      <button
        type="button"
        className="text-3xl md:text-4xl font-serif font-light text-muted-foreground hover:text-foreground transition-colors"
        onClick={beginEdit}
        title="Click to edit cap"
      >
        / {formatCurrency(saved)}
      </button>
      {isDefault ? (
        <span
          className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-muted-foreground/30 text-muted-foreground"
          title="Cap comes from your Settings allowance"
        >
          default
        </span>
      ) : (
        <span className="inline-flex items-baseline gap-1">
          <span
            className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-amber-700/40 text-amber-700"
            title="Override set for this month"
          >
            override
          </span>
          <button
            type="button"
            className="text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground underline disabled:opacity-50"
            onClick={resetToDefault}
            disabled={isResetting}
            title="Clear override and use the Settings default"
          >
            reset
          </button>
        </span>
      )}
    </span>
  );
}

// (#629) Sun-Sat week math. Returns Sunday of the week containing `d`
// (local time). We use local time so "this week" matches what the user
// sees on their wall clock — same convention as the rest of the app.
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
function formatWeekRange(sun: Date): string {
  const sat = addDays(sun, 6);
  const sameMonth = sun.getMonth() === sat.getMonth();
  const sunStr = sun.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const satStr = sat.toLocaleDateString("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
  });
  return `${sunStr} – ${satStr}`;
}

function WeeklyMonthlySection({
  transactions,
  viewMonth,
  today,
  selectedSources,
}: {
  transactions: Transaction[];
  viewMonth: Date;
  today: Date;
  selectedSources: ReadonlySet<string>;
}) {
  const SUB_LABEL = useWeeklyBucketLabels();
  const { toast } = useToast();
  const qc = useQueryClient();

  // (#629) Cap is still a per-month override (matches existing
  // dashboardBudgets data model + Settings allowance), but the *spend
  // total* is now scoped to the visible Sun–Sat week.
  const monthKey = useMemo(
    () => `${viewMonth.getFullYear()}-${String(viewMonth.getMonth() + 1).padStart(2, "0")}`,
    [viewMonth],
  );
  const editor = useBudgetEditor("weekly", monthKey);

  const currentWeekStart = useMemo(() => sundayOf(today), [today]);
  const [viewWeekStart, setViewWeekStart] = useState<Date>(currentWeekStart);
  const weekStartISO = useMemo(() => fmtISO(viewWeekStart), [viewWeekStart]);
  const weekEndISO = useMemo(() => fmtISO(addDays(viewWeekStart, 6)), [viewWeekStart]);
  const isCurrentWeek = fmtISO(currentWeekStart) === weekStartISO;
  const isFutureWeek = viewWeekStart > currentWeekStart;

  const { totals, total, weekTxns } = useMemo(() => {
    const t: Record<SubBucket, number> = { groceries: 0, dining: 0, entertainment: 0, misc: 0 };
    let sum = 0;
    const list: Transaction[] = [];
    for (const tx of transactions) {
      if (!selectedSources.has(dashboardSourceLabel(tx.source))) continue;
      if (!tx.weeklyAllowance) continue;
      if (tx.occurredOn < weekStartISO || tx.occurredOn > weekEndISO) continue;
      const amt = expenseAmount(tx);
      const bucket = (tx.weeklyBucket as SubBucket | null | undefined) ?? "misc";
      if (SUB_BUCKETS.includes(bucket)) t[bucket] += amt;
      else t.misc += amt;
      sum += amt;
      list.push(tx);
    }
    list.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
    return { totals: t, total: sum, weekTxns: list };
  }, [transactions, weekStartISO, weekEndISO, selectedSources]);

  const cap = editor.saved;
  const remaining = Math.max(0, cap - total);
  const pct = cap > 0 ? Math.min(100, (total / cap) * 100) : 0;
  const overspent = cap > 0 && total > cap;

  // (#629) Day X of 7 — only meaningful for the current week.
  const dayOfWeek = isCurrentWeek
    ? Math.min(7, Math.floor((today.getTime() - viewWeekStart.getTime()) / 86400000) + 1)
    : 7;

  // (#629) Settlement state for this household. We list-all (no weekStart
  // filter) so the lookup is one cached request even as the user pages
  // through prior weeks.
  const { data: settlements } = useListWeeklySettlements({});
  const settledSet = useMemo(
    () => new Set((settlements ?? []).map((s) => s.weekStart)),
    [settlements],
  );
  const isClosed = settledSet.has(weekStartISO);
  const closeOut = useCloseOutWeek();
  const reopen = useReopenWeek();
  const invalidateSettlements = () =>
    qc.invalidateQueries({ queryKey: getListWeeklySettlementsQueryKey({}) });

  const handleCloseOut = () => {
    closeOut.mutate(
      { data: { weekStart: weekStartISO } },
      {
        onSuccess: () => {
          invalidateSettlements();
          toast({ title: "Week closed out", description: formatWeekRange(viewWeekStart) });
        },
      },
    );
  };
  const handleReopen = () => {
    reopen.mutate(
      { params: { weekStart: weekStartISO } },
      {
        onSuccess: () => {
          invalidateSettlements();
          toast({ title: "Week reopened" });
        },
      },
    );
  };

  return (
    <section>
      <div className="flex items-end justify-between mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-amber-700 font-medium">
            WEEKLY {formatCurrency(cap)}
          </div>
          <h2 className="text-2xl font-serif font-bold text-foreground">Life spending</h2>
        </div>
      </div>
      <Card>
        <CardContent className="p-6 space-y-4">
          {/* (#629) Week navigator. Forward arrow disabled on the
              current week so users can't peek into a future "week"
              that's still empty by definition. */}
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setViewWeekStart((w) => addDays(w, -7))}
              data-testid="button-week-prev"
              aria-label="Previous week"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex flex-col items-center text-center">
              <div className="text-sm font-medium tabular-nums">
                {formatWeekRange(viewWeekStart)}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {isCurrentWeek ? "This week" : isFutureWeek ? "Future" : "Prior week"}
                {isClosed && " · closed out"}
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setViewWeekStart((w) => addDays(w, 7))}
              disabled={isCurrentWeek}
              data-testid="button-week-next"
              aria-label="Next week"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <span className={`text-4xl md:text-5xl font-serif font-bold tabular-nums ${overspent ? "text-destructive" : "text-foreground"}`}>
                {formatCurrency(total)}
              </span>
              <CapInline {...editor} />
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {isCurrentWeek
                ? `${formatCurrency(remaining)} left · day ${dayOfWeek} of 7`
                : `${formatCurrency(remaining)} left`}
            </div>
          </div>
          <Progress value={pct} className={overspent ? "[&>div]:bg-destructive" : ""} />

          {/* (#629) Close Out / Reopen — only for prior weeks. */}
          {!isCurrentWeek && !isFutureWeek && (
            <div className="flex items-center justify-end gap-2">
              {isClosed ? (
                <>
                  <span className="text-[11px] uppercase tracking-widest text-emerald-700 font-medium">
                    Closed out ✓
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleReopen}
                    disabled={reopen.isPending}
                    data-testid="button-week-reopen"
                  >
                    Reopen
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCloseOut}
                  disabled={closeOut.isPending}
                  data-testid="button-week-close-out"
                >
                  Close Out Week
                </Button>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2 border-t">
            {SUB_BUCKETS.map((b) => (
              <div key={b}>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {SUB_LABEL[b]}
                </div>
                <div className="text-lg font-serif font-semibold tabular-nums">
                  {formatCurrency(totals[b])}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t pt-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
              This week ({weekTxns.length})
            </div>
            {weekTxns.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">
                {isCurrentWeek
                  ? <>All clear — no weekly charges yet this week. Tag them on the <Link href="/amex" className="text-amber-700 underline">Amex page</Link>.</>
                  : <>No weekly charges in this week.</>}
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {weekTxns.map((t) => {
                  const amt = Number(t.amount) || 0;
                  const srcLabel = nonAmexSourceLabel(t.source);
                  return (
                    <div
                      key={t.id}
                      className="flex items-center justify-between gap-3 text-sm"
                      data-testid={`row-weekly-${t.id}`}
                    >
                      <div className="flex items-baseline gap-3 min-w-0">
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground w-12 shrink-0">
                          {new Date(t.occurredOn + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                        <span className="truncate">{t.description}</span>
                        {srcLabel && <SourceTag label={srcLabel} />}
                      </div>
                      <span className={`tabular-nums font-mono ${amt < 0 ? "text-destructive" : "text-foreground"}`}>
                        {amt < 0 ? "-" : ""}{formatCurrency(Math.abs(amt))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function MonthlyLikeSection({
  title,
  bucket,
  transactions,
  viewMonth,
  today,
  selectedSources,
  resolvedUnplannedTxnIds,
}: {
  title: string;
  bucket: "monthly" | "unplanned";
  transactions: Transaction[];
  viewMonth: Date;
  today: Date;
  selectedSources: ReadonlySet<string>;
  resolvedUnplannedTxnIds?: ReadonlySet<string>;
}) {
  const monthKey = useMemo(
    () => `${viewMonth.getFullYear()}-${String(viewMonth.getMonth() + 1).padStart(2, "0")}`,
    [viewMonth],
  );
  const monthStartISO = useMemo(() => fmtISO(viewMonth), [viewMonth]);
  const monthEndISO = useMemo(
    () => fmtISO(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0)),
    [viewMonth],
  );

  const editor = useBudgetEditor(bucket, monthKey);

  const { total, recent } = useMemo(() => {
    const filtered = transactions.filter((t) => {
      if (!selectedSources.has(dashboardSourceLabel(t.source))) return false;
      // (#631 / #632) Bucket membership predicate also excludes
      // transfer-classified rows; see `isTxnInBucket`.
      if (!isTxnInBucket(t, bucket, resolvedUnplannedTxnIds)) return false;
      return t.occurredOn >= monthStartISO && t.occurredOn <= monthEndISO;
    });
    const sum = filtered.reduce((s, t) => s + expenseAmount(t), 0);
    const sorted = [...filtered].sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
    return { total: sum, recent: sorted };
  }, [transactions, bucket, monthStartISO, monthEndISO, selectedSources, resolvedUnplannedTxnIds]);

  const cap = editor.saved;
  const overspent = cap > 0 && total > cap;
  const pct = cap > 0 ? Math.min(100, (total / cap) * 100) : 0;
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const isCurrentMonth =
    viewMonth.getFullYear() === today.getFullYear() &&
    viewMonth.getMonth() === today.getMonth();
  const dayOfMonth = isCurrentMonth ? today.getDate() : daysInMonth;

  return (
    <section>
      <div className="flex items-end justify-between mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-amber-700 font-medium">
            {bucket === "monthly" ? "MONTHLY BUDGET" : "UNPLANNED BUDGET"}
          </div>
          <h2 className="text-2xl font-serif font-bold text-foreground">{title}</h2>
        </div>
      </div>
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <span className={`text-4xl md:text-5xl font-serif font-bold tabular-nums ${overspent ? "text-destructive" : "text-foreground"}`}>
                {formatCurrency(total)}
              </span>
              <CapInline {...editor} />
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {cap > 0 ? null : <span>Click budget to set amount · </span>}
              day {dayOfMonth} of {daysInMonth}
            </div>
          </div>
          {cap > 0 && <Progress value={pct} className={overspent ? "[&>div]:bg-destructive" : ""} />}
          <div className="border-t pt-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
              {isCurrentMonth ? "This month" : "Selected month"} ({recent.length})
            </div>
            {recent.length === 0 ? (
              <div className="text-sm text-muted-foreground py-2">
                All clear — no {bucket} charges this month yet. Tag them on the{" "}
                <Link href="/amex" className="text-amber-700 underline">Amex page</Link>.
              </div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {recent.map((t) => {
                  const amt = Number(t.amount) || 0;
                  const srcLabel = nonAmexSourceLabel(t.source);
                  // (#488) Jump back to the transaction on the Transactions
                  // page so the user can re-categorise / undo a mistag
                  // without hunting for it. The page reads `?tx=` and
                  // scrolls + highlights the row when it mounts; `?month=`
                  // pins the right month so the row is in the visible set.
                  const txMonthISO = `${t.occurredOn.slice(0, 7)}-01`;
                  return (
                    <Link
                      key={t.id}
                      href={`/transactions?tx=${encodeURIComponent(t.id)}&month=${txMonthISO}`}
                      className="block -mx-1 px-1 rounded hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid={`row-${bucket}-${t.id}`}
                    >
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <div className="flex items-baseline gap-3 min-w-0">
                          <span className="text-[10px] uppercase tracking-widest text-muted-foreground w-12 shrink-0">
                            {new Date(t.occurredOn + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                          <span className="truncate">{t.description}</span>
                          {srcLabel && <SourceTag label={srcLabel} />}
                        </div>
                        <span className={`tabular-nums font-mono ${amt < 0 ? "text-destructive" : "text-foreground"}`}>
                          {amt < 0 ? "-" : ""}{formatCurrency(Math.abs(amt))}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function DebtProgressCard({
  owed,
  paidThisMonth,
  paidLifetime,
  activeDebtCount,
}: {
  owed: string;
  paidThisMonth: string;
  paidLifetime: string;
  activeDebtCount: number;
}) {
  const owedNum = Math.max(0, Number(owed) || 0);
  const paidLifetimeNum = Math.max(0, Number(paidLifetime) || 0);
  const paidMonthNum = Math.max(0, Number(paidThisMonth) || 0);
  const denom = owedNum + paidLifetimeNum;
  const pct = denom > 0 ? Math.round((paidLifetimeNum / denom) * 100) : 0;
  return (
    <Card className="md:col-span-2 lg:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Debt progress
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Owed now</div>
            <div className="text-2xl font-bold tabular-nums">
              {formatCurrency(owedNum.toFixed(2))}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {activeDebtCount} active {activeDebtCount === 1 ? "debt" : "debts"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Paid off</div>
            <div className="text-2xl font-bold tabular-nums text-primary">
              {formatCurrency(paidLifetimeNum.toFixed(2))}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              all-time · {formatCurrency(paidMonthNum.toFixed(2))} this month
            </div>
          </div>
        </div>
        <div className="space-y-1">
          <Progress value={pct} className="h-1.5" />
          <div className="text-xs text-muted-foreground tabular-nums">
            {pct}% paid down
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ReimbursementsBox({
  transactions,
  isLoading,
  today,
  mappingRules,
}: {
  transactions: Transaction[];
  isLoading?: boolean;
  today: Date;
  mappingRules: readonly MappingRule[] | undefined;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateTx = useUpdateTransaction();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // (#84) Multi-select mode: when on, the row checkbox toggles selection
  // (instead of marking reimbursed) and a contextual bulk bar offers
  // "Mark N reimbursed". When off, the per-row checkbox keeps its
  // existing one-click behavior.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const reimbursable = useMemo(
    () => transactions.filter((t) => t.reimbursable),
    [transactions],
  );

  const pending = useMemo(
    () =>
      reimbursable
        .filter((t) => !t.reimbursed)
        .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1)),
    [reimbursable],
  );

  // (#84) Keep the selected set honest: prune ids that are no longer in
  // `pending` (e.g., after a successful resolve, refetch, or month change),
  // and exit selection mode entirely if nothing is left to act on. Without
  // this, the bulk bar can show "N selected" while bulk actions silently
  // no-op against a stale Set.
  const pendingIdSet = useMemo(
    () => new Set(pending.map((t) => t.id)),
    [pending],
  );
  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (pendingIdSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (selectionMode && pending.length === 0) setSelectionMode(false);
  }, [pendingIdSet, pending.length, selectionMode]);

  const reimbursed = useMemo(
    () =>
      reimbursable
        .filter((t) => t.reimbursed)
        .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1)),
    [reimbursable],
  );

  const pendingByPayer = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const t of pending) {
      const key = (t.owedBy ?? "").trim() || "Unassigned";
      const cur = map.get(key) ?? { total: 0, count: 0 };
      cur.total += expenseAmount(t);
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .map(([payer, v]) => ({ payer, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [pending]);

  const pendingTotal = useMemo(
    () => pending.reduce((s, t) => s + expenseAmount(t), 0),
    [pending],
  );

  // Optimistically flip `reimbursed` on every cached transactions list
  // (regardless of query params), so the UI moves the row and the
  // headline total update instantly without waiting on the server.
  // Returns a snapshot for rollback on failure.
  const applyOptimistic = (id: string, next: boolean) => {
    const queries = qc.getQueriesData<Transaction[]>({
      queryKey: getListTransactionsQueryKey(),
    });
    const snapshot: Array<[readonly unknown[], Transaction[] | undefined]> = [];
    for (const [key, data] of queries) {
      snapshot.push([key, data]);
      if (!Array.isArray(data)) continue;
      let changed = false;
      const updated = data.map((row) => {
        if (row.id !== id) return row;
        if (row.reimbursed === next) return row;
        changed = true;
        return { ...row, reimbursed: next };
      });
      if (changed) qc.setQueryData(key, updated);
    }
    return snapshot;
  };

  const rollback = (
    snapshot: Array<[readonly unknown[], Transaction[] | undefined]>,
  ) => {
    for (const [key, data] of snapshot) {
      qc.setQueryData(key, data);
    }
  };

  const setReimbursed = async (
    t: Transaction,
    next: boolean,
    opts?: { silent?: boolean },
  ) => {
    setPendingIds((prev) => {
      const n = new Set(prev);
      n.add(t.id);
      return n;
    });
    const snapshot = applyOptimistic(t.id, next);
    try {
      await updateTx.mutateAsync({ id: t.id, data: { reimbursed: next } });
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      if (!opts?.silent) {
        if (next) {
          toast({
            title: "Reimbursed",
            description: `${t.description} · ${formatCurrency(expenseAmount(t))}`,
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => setReimbursed(t, false, { silent: true })}
              >
                Undo
              </ToastAction>
            ),
          });
        } else {
          toast({
            title: "Moved back to pending",
            description: `${t.description} · ${formatCurrency(expenseAmount(t))}`,
          });
        }
      }
    } catch (e) {
      rollback(snapshot);
      toast({
        title: "Couldn't update reimbursement",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setPendingIds((prev) => {
        const n = new Set(prev);
        n.delete(t.id);
        return n;
      });
    }
  };

  const bulkMarkPaid = async (payer: string | null) => {
    const targets = payer
      ? pending.filter((t) => ((t.owedBy ?? "").trim() || "Unassigned") === payer)
      : pending;
    if (targets.length === 0) return;
    for (const t of targets) {
      applyOptimistic(t.id, true);
    }
    try {
      await Promise.all(
        targets.map((t) => updateTx.mutateAsync({ id: t.id, data: { reimbursed: true } })),
      );
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({
        title: `Marked ${targets.length} item${targets.length === 1 ? "" : "s"} reimbursed`,
      });
    } catch (e) {
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({
        title: "Some updates failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // (#84) Bulk-mark by arbitrary subset chosen in selection mode.
  const bulkMarkSelected = async () => {
    const targets = pending.filter((t) => selectedIds.has(t.id));
    if (targets.length === 0) return;
    for (const t of targets) applyOptimistic(t.id, true);
    try {
      await Promise.all(
        targets.map((t) =>
          updateTx.mutateAsync({ id: t.id, data: { reimbursed: true } }),
        ),
      );
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({
        title: `Marked ${targets.length} item${targets.length === 1 ? "" : "s"} reimbursed`,
      });
      setSelectedIds(new Set());
      setSelectionMode(false);
      lastClickedIdRef.current = null;
    } catch (e) {
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({
        title: "Some updates failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const lastClickedIdRef = useRef<string | null>(null);

  const exitSelectionMode = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
    lastClickedIdRef.current = null;
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedIdRef.current = id;
  };

  const selectRangeTo = (id: string) => {
    const anchor = lastClickedIdRef.current;
    const ids = pending.map((t) => t.id);
    const endIdx = ids.indexOf(id);
    if (endIdx === -1) return;
    const startIdx = anchor ? ids.indexOf(anchor) : -1;
    if (startIdx === -1) {
      toggleSelected(id);
      return;
    }
    const [lo, hi] =
      startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i += 1) next.add(ids[i]);
      return next;
    });
    lastClickedIdRef.current = id;
  };

  const renderRow = (t: Transaction, reimbursed: boolean) => {
    const amt = expenseAmount(t);
    const inSelectMode = selectionMode && !reimbursed;
    const isSelected = inSelectMode && selectedIds.has(t.id);
    return (
      <div
        key={t.id}
        className={cn(
          "flex items-center gap-3 text-sm py-1 transition-opacity",
          reimbursed && "opacity-60",
          isSelected && "bg-primary/5 rounded-sm px-1 -mx-1",
        )}
      >
        {inSelectMode ? (
          <Checkbox
            checked={isSelected}
            onClick={(e) => {
              if (e.shiftKey) {
                e.preventDefault();
                selectRangeTo(t.id);
              }
            }}
            onCheckedChange={() => toggleSelected(t.id)}
            aria-label={isSelected ? "Unselect" : "Select"}
            data-testid={`select-reimburse-${t.id}`}
          />
        ) : (
          <Checkbox
            checked={reimbursed}
            disabled={pendingIds.has(t.id)}
            onCheckedChange={(v) => setReimbursed(t, !!v)}
            aria-label={reimbursed ? "Move back to pending" : "Mark reimbursed"}
          />
        )}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-medium truncate",
              reimbursed && "line-through",
            )}
          >
            {t.description}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDate(t.occurredOn)}
            {t.source ? ` · ${t.source}` : ""}
          </p>
          <div className="mt-0.5">
            <MatchedRuleChip
              categoryId={t.categoryId}
              matchedRuleId={t.matchedRuleId}
              rules={mappingRules}
              testIdSuffix={`reimburse-${t.id}`}
              variant="compact"
            />
          </div>
        </div>
        <span
          className={cn(
            "font-medium tabular-nums font-mono",
            reimbursed && "line-through",
          )}
        >
          {formatCurrency(amt)}
        </span>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="w-4 h-4" /> Reimbursements
        </CardTitle>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-3 w-28" />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-4xl font-serif font-bold tabular-nums text-purple-700">
              {formatCurrency(pendingTotal)}{" "}
              <span className="text-sm font-sans font-normal text-muted-foreground">
                pending · {pending.length} item
                {pending.length === 1 ? "" : "s"}
              </span>
            </div>
            {pendingByPayer.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pendingByPayer.map(({ payer, total, count }) => (
                  <button
                    key={payer}
                    type="button"
                    disabled={selectionMode || updateTx.isPending}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs hover:ring-2 hover:ring-primary/40 transition-all cursor-pointer",
                      payer === "Unassigned"
                        ? "border-dashed text-muted-foreground"
                        : "bg-muted/40",
                      selectionMode &&
                        "opacity-50 cursor-not-allowed hover:ring-0",
                    )}
                    title={
                      selectionMode
                        ? "Exit selection mode to use payer shortcuts"
                        : `Mark all ${count} item${count === 1 ? "" : "s"} from ${payer} as reimbursed`
                    }
                    onClick={() => bulkMarkPaid(payer)}
                    data-testid={`bulk-reimburse-${payer}`}
                  >
                    <span className="font-medium">{payer}</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(total)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {pending.length > 0 && !selectionMode && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => bulkMarkPaid(null)}
                  disabled={updateTx.isPending}
                  data-testid="bulk-reimburse-all"
                >
                  Mark all {pending.length} as reimbursed
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => setSelectionMode(true)}
                  data-testid="bulk-reimburse-select-mode"
                >
                  Select…
                </Button>
              </div>
            )}
            {pending.length > 0 && selectionMode && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5"
                data-testid="bulk-reimburse-bar"
              >
                <span className="text-xs font-medium">
                  {selectedIds.size} of {pending.length} selected
                </span>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={bulkMarkSelected}
                  disabled={selectedIds.size === 0 || updateTx.isPending}
                  data-testid="bulk-reimburse-mark-selected"
                >
                  Mark {selectedIds.size || ""} reimbursed
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs ml-auto"
                  onClick={exitSelectionMode}
                  data-testid="bulk-reimburse-cancel"
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : reimbursable.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            All clear — nothing waiting to be reimbursed.
          </p>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto pr-1 space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                Pending ({pending.length})
              </div>
              {pending.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  All caught up — nothing waiting to be reimbursed.
                </p>
              ) : (
                <div className="space-y-1">
                  {pending.map((t) => renderRow(t, false))}
                </div>
              )}
            </div>
            {reimbursed.length > 0 && (
              <div className="border-t pt-3">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Reimbursed ({reimbursed.length})
                </div>
                <div className="space-y-1">
                  {reimbursed.map((t) => renderRow(t, true))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryCell({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-serif font-semibold tabular-nums">
        {formatCurrency(value)}
      </div>
    </div>
  );
}

function DashboardHero({ today }: { today: Date }) {
  const dateLabel = today
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .replace(",", "")
    .toUpperCase()
    .replace(/^(\S+)\s/, "$1 · ");
  return (
    <Card>
      <CardContent className="p-6 flex flex-col sm:flex-row items-center sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="H2"
            className="h-12 w-12 rounded"
          />
          <div className="font-serif font-bold text-2xl tracking-tight text-foreground">
            H2 Budget
          </div>
        </div>
        <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-4 py-1.5 text-xs font-semibold tracking-widest tabular-nums">
          {dateLabel}
        </span>
      </CardContent>
    </Card>
  );
}

const SNAPSHOT_MIN_MONTH = "2026-04-01";

function monthOffsetFromCurrent(today: Date, monthStart: string) {
  const d = new Date(monthStart + "T00:00:00");
  return (
    (d.getFullYear() - today.getFullYear()) * 12 +
    (d.getMonth() - today.getMonth())
  );
}

function fmtMonthStart(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function useMonthlySnapshotState(today: Date) {
  const currentMonthStart = useMemo(
    () => fmtMonthStart(new Date(today.getFullYear(), today.getMonth(), 1)),
    [today],
  );
  const [monthStart, setMonthStart] = useState(currentMonthStart);

  const monthDate = useMemo(
    () => new Date(monthStart + "T00:00:00"),
    [monthStart],
  );
  const monthLabel = useMemo(
    () =>
      monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    [monthDate],
  );
  const shortMonth = useMemo(
    () => monthDate.toLocaleDateString("en-US", { month: "long" }),
    [monthDate],
  );

  const offset = monthOffsetFromCurrent(today, monthStart);
  const canPrev = monthStart > SNAPSHOT_MIN_MONTH;
  const canNext = offset < 0;

  const stepMonth = (delta: number) => {
    const d = new Date(monthDate);
    d.setMonth(d.getMonth() + delta);
    const next = fmtMonthStart(d);
    if (next < SNAPSHOT_MIN_MONTH) return;
    if (next > currentMonthStart) return;
    setMonthStart(next);
  };

  return {
    monthStart,
    monthDate,
    monthLabel,
    shortMonth,
    offset,
    canPrev,
    canNext,
    stepMonth,
  };
}

type MonthlySnapshotState = ReturnType<typeof useMonthlySnapshotState>;

function MonthlySnapshotTiles({
  state,
  totalDebt,
  activeDebtCount,
  chaseEndingBalance,
  amexEndingBalance,
  bankSnapshot,
}: {
  state: MonthlySnapshotState;
  totalDebt: string;
  activeDebtCount: number;
  chaseEndingBalance: (monthStart: string) => number | null;
  amexEndingBalance: (monthStart: string) => number | null;
  bankSnapshot: { source: "manual" | "plaid"; at: string } | null;
}) {
  const { monthStart, monthLabel, shortMonth, canPrev, canNext, stepMonth } =
    state;

  return (
    <section
      className="space-y-4"
      data-testid="dashboard-monthly-snapshot-tiles"
    >
      <div className="flex items-center justify-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full"
          onClick={() => stepMonth(-1)}
          disabled={!canPrev}
          aria-label="Previous month"
          data-testid="button-snapshot-prev-month"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span
          className="text-sm font-semibold tracking-wide min-w-[160px] text-center"
          data-testid="text-snapshot-month-label"
        >
          {monthLabel}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full"
          onClick={() => stepMonth(1)}
          disabled={!canNext}
          aria-label="Next month"
          data-testid="button-snapshot-next-month"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="tile-total-owed">
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Total Owed
            </div>
            <div className="text-3xl font-serif font-bold tabular-nums mt-1">
              {formatCurrency(totalDebt)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {activeDebtCount} active{" "}
              {activeDebtCount === 1 ? "debt" : "debts"}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="tile-chase-ending-balance">
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Chase ending balance
            </div>
            {(() => {
              const bal = chaseEndingBalance(monthStart);
              if (bal === null) {
                return (
                  <>
                    <div
                      className="text-3xl font-serif font-bold tabular-nums mt-1 text-muted-foreground"
                      data-testid="text-chase-ending-balance-empty"
                    >
                      —
                    </div>
                    <div
                      className="text-xs text-muted-foreground mt-1"
                      data-testid="text-chase-ending-balance-empty-hint"
                    >
                      Link Chase checking to see this
                    </div>
                  </>
                );
              }
              return (
                <>
                  <div
                    className={cn(
                      "text-3xl font-serif font-bold tabular-nums mt-1",
                      bal < 0 && "text-destructive",
                    )}
                    data-testid="text-chase-ending-balance"
                  >
                    {formatCurrency(bal)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    end of {shortMonth}
                  </div>
                  {bankSnapshot && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      <BankSnapshotFreshness
                        source={bankSnapshot.source}
                        at={bankSnapshot.at}
                      />
                    </div>
                  )}
                </>
              );
            })()}
          </CardContent>
        </Card>
        <Card data-testid="tile-amex-ending-balance">
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Amex ending balance
            </div>
            {(() => {
              const bal = amexEndingBalance(monthStart);
              if (bal === null) {
                return (
                  <>
                    <div
                      className="text-3xl font-serif font-bold tabular-nums mt-1 text-muted-foreground"
                      data-testid="text-amex-ending-balance-empty"
                    >
                      —
                    </div>
                    <div
                      className="text-xs text-muted-foreground mt-1"
                      data-testid="text-amex-ending-balance-empty-hint"
                    >
                      Link Amex or set a balance to see this
                    </div>
                  </>
                );
              }
              return (
                <>
                  <div
                    className={cn(
                      "text-3xl font-serif font-bold tabular-nums mt-1",
                      bal < 0 && "text-destructive",
                    )}
                    data-testid="text-amex-ending-balance"
                  >
                    {formatCurrency(bal)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    end of {shortMonth}
                  </div>
                </>
              );
            })()}
          </CardContent>
        </Card>
        <Card data-testid="tile-net-month">
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Net {shortMonth}
            </div>
            <NetMonthValue state={state} />
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function NetMonthValue({ state }: { state: MonthlySnapshotState }) {
  const { monthStart } = state;
  const { data: budget } = useGetBudgetMonth(monthStart);
  const summary = budget?.summary;
  const incomeActual = parseFloat(summary?.income.actual ?? "0") || 0;
  const expensesActual = parseFloat(summary?.expenses.actual ?? "0") || 0;
  const paidThisMonth = useMemo(() => {
    if (!budget) return 0;
    let sum = 0;
    for (const g of budget.groups ?? []) {
      for (const l of g.lines ?? []) {
        if (l.sourceKind === "auto_debts") {
          sum += parseFloat(l.actualAmount) || 0;
        }
      }
    }
    return sum;
  }, [budget]);
  const everydaySpend = Math.max(0, expensesActual - paidThisMonth);
  const net = incomeActual - everydaySpend - paidThisMonth;
  const netPositive = net >= 0;
  return (
    <>
      <div
        className={cn(
          "text-3xl font-serif font-bold tabular-nums mt-1",
          netPositive
            ? "text-[hsl(var(--positive))]"
            : "text-[hsl(var(--negative))]",
        )}
      >
        {netPositive ? "" : "-"}
        {formatCurrency(Math.abs(net))}
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        income − spend − debt paid
      </div>
    </>
  );
}

function MonthVsPlanPanel({ state, today }: { state: MonthlySnapshotState; today: Date }) {
  const { monthStart, monthDate, shortMonth, offset } = state;
  const { data: budget, isLoading } = useGetBudgetMonth(monthStart);
  const summary = budget?.summary;

  const incomeActual = parseFloat(summary?.income.actual ?? "0") || 0;
  const incomeBudget = parseFloat(summary?.income.budget ?? "0") || 0;
  const expensesActual = parseFloat(summary?.expenses.actual ?? "0") || 0;
  const expensesBudget = parseFloat(summary?.expenses.budget ?? "0") || 0;

  const daysInMonth = new Date(
    monthDate.getFullYear(),
    monthDate.getMonth() + 1,
    0,
  ).getDate();
  const isCurrentMonth = offset === 0;
  const dayOfMonth = isCurrentMonth ? today.getDate() : daysInMonth;
  const monthElapsedPct = (dayOfMonth / daysInMonth) * 100;

  const spentPct =
    expensesBudget > 0
      ? Math.min(100, (expensesActual / expensesBudget) * 100)
      : 0;
  const spentPctRaw =
    expensesBudget > 0 ? (expensesActual / expensesBudget) * 100 : 0;

  const paceDelta = spentPctRaw - monthElapsedPct;
  let paceLabel: "ON PACE" | "AHEAD" | "BEHIND" = "ON PACE";
  let paceClass = "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (paceDelta > 5) {
    paceLabel = "BEHIND";
    paceClass =
      "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300";
  } else if (paceDelta < -5) {
    paceLabel = "AHEAD";
    paceClass =
      "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300";
  }
  const overspent = expensesBudget > 0 && expensesActual > expensesBudget;
  const remaining = Math.max(0, expensesBudget - expensesActual);

  return (
    <section className="space-y-4" data-testid="dashboard-monthly-snapshot">
      <Card data-testid="card-month-vs-plan">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">{shortMonth} vs plan</CardTitle>
          <Link
            href={`/budget?month=${monthStart}`}
            className="text-xs uppercase tracking-widest text-amber-700 dark:text-amber-400 hover:underline"
            data-testid="link-open-budget"
          >
            OPEN BUDGET →
          </Link>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "text-3xl md:text-4xl font-serif font-bold tabular-nums",
                        overspent && "text-destructive",
                      )}
                    >
                      {formatCurrency(expensesActual)}
                    </span>
                    <span className="text-xl font-serif font-light text-muted-foreground tabular-nums">
                      of {formatCurrency(expensesBudget)}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold tracking-widest",
                      paceClass,
                    )}
                    data-testid="badge-pace"
                  >
                    {paceLabel}
                  </span>
                </div>
                <Progress
                  value={spentPct}
                  className={overspent ? "[&>div]:bg-destructive" : ""}
                />
                <div className="text-xs text-muted-foreground tabular-nums">
                  {Math.round(spentPctRaw)}% used · day {dayOfMonth} of{" "}
                  {daysInMonth}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t">
                <div data-testid="tile-income-received">
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    Income Received
                  </div>
                  <div className="text-2xl font-serif font-bold tabular-nums mt-1">
                    {formatCurrency(incomeActual)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    of {formatCurrency(incomeBudget)}
                  </div>
                </div>
                <div data-testid="tile-left-to-spend">
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    Left to spend
                  </div>
                  <div className="text-2xl font-serif font-bold tabular-nums mt-1">
                    {formatCurrency(remaining)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    across the rest of {shortMonth}
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function DashboardSnapshotSection({
  today,
  totalDebt,
  activeDebtCount,
  chaseEndingBalance,
  amexEndingBalance,
  bankSnapshot,
}: {
  today: Date;
  totalDebt: string;
  activeDebtCount: number;
  chaseEndingBalance: (monthStart: string) => number | null;
  amexEndingBalance: (monthStart: string) => number | null;
  bankSnapshot: { source: "manual" | "plaid"; at: string } | null;
}) {
  const state = useMonthlySnapshotState(today);
  return (
    <>
      <DashboardHero today={today} />
      <MonthlySnapshotTiles
        state={state}
        totalDebt={totalDebt}
        activeDebtCount={activeDebtCount}
        chaseEndingBalance={chaseEndingBalance}
        amexEndingBalance={amexEndingBalance}
        bankSnapshot={bankSnapshot}
      />
      <div className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 pt-4 md:pt-6 pb-4 bg-background border-b shadow-sm">
        <MonthVsPlanPanel state={state} today={today} />
      </div>
    </>
  );
}

const INCLUDE_ALL_SOURCES_KEY = "h2budget:dashboardIncludeAllSources";
const SELECTED_SOURCES_KEY = "h2budget:dashboardSelectedSources";

// (#631) Whether `t` belongs in the dashboard's Monthly / Unplanned
// roll-up. Extracted so MonthlyLikeSection's filter and the unit tests
// share a single predicate.
//
// (#632) Defensive guard: a transfer-classified row (e.g. a card
// payment) is never real spend, so it must never roll into Monthly or
// Unplanned regardless of which flag put it there. The startup
// reclassify sweep clears stale allowance flags on boot, but this
// keeps the dashboard honest in the meantime and for any future paths
// that flip isTransfer without touching the allowance flags. The user
// can still force a transfer row into a bucket by clearing isTransfer
// (which sets isTransferUserOverridden=true).
//
// Transfer rows that only land in the bucket via a forecast-inbox
// `ignored_unforecasted` / `unplanned` resolution are not real spend
// either and are excluded by the same guard.
export function isTxnInBucket(
  t: Transaction,
  bucket: "monthly" | "unplanned",
  resolvedUnplannedTxnIds?: ReadonlySet<string>,
): boolean {
  if (t.isTransfer) return false;
  if (bucket === "monthly") return !!t.monthlyAllowance;
  if (t.unplannedAllowance) return true;
  if (resolvedUnplannedTxnIds?.has(t.id)) return true;
  return false;
}

// (#278) Detected source chips for a given month — derived from transactions
// that are tagged into any WK/MO/UN bucket and fall in [monthStartISO,
// monthEndISO]. Returned sorted with "amex" first (the historical default),
// then alphabetical, so the chip row order is stable across renders.
export function detectChipSources(
  transactions: Transaction[],
  monthStartISO: string,
  monthEndISO: string,
  resolvedUnplannedTxnIds?: ReadonlySet<string>,
): string[] {
  const set = new Set<string>();
  for (const t of transactions) {
    // (#482) A txn marked Unplanned in the forecast inbox is "tagged"
    // for chip purposes too — otherwise the only Chase txn the user
    // marked unplanned this month would not surface a Chase chip and
    // they could not toggle it on to see the roll-up.
    const taggedByUser =
      t.weeklyAllowance ||
      t.monthlyAllowance ||
      t.unplannedAllowance;
    const taggedByForecast = !!resolvedUnplannedTxnIds?.has(t.id);
    if (!taggedByUser && !taggedByForecast) continue;
    // (#631 / #632) A transfer-classified row (e.g. a card payment) is
    // not real spend; the bucket filter excludes it from totals, so a
    // chip would be a dead-end. Drop it whether the tag came from the
    // user (stale allowance flag) or the forecast inbox.
    if (t.isTransfer) continue;
    if (t.occurredOn < monthStartISO || t.occurredOn > monthEndISO) continue;
    set.add(dashboardSourceLabel(t.source));
  }
  return Array.from(set).sort((a, b) => {
    if (a === b) return 0;
    if (a === "amex") return -1;
    if (b === "amex") return 1;
    return a.localeCompare(b);
  });
}

type InitialSelection =
  | { kind: "explicit"; selected: string[] }
  | { kind: "migrate-all" } // legacy "include all sources" was ON — seed from
                            // the first non-empty detected list, then persist.
  | { kind: "default" };    // no prior pref — preserves Amex-only default (#28).

function readInitialSelection(): InitialSelection {
  if (typeof window === "undefined") return { kind: "default" };
  try {
    const raw = window.localStorage.getItem(SELECTED_SOURCES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return {
          kind: "explicit",
          selected: parsed.filter((s): s is string => typeof s === "string"),
        };
      }
    }
    if (window.localStorage.getItem(INCLUDE_ALL_SOURCES_KEY) === "1") {
      return { kind: "migrate-all" };
    }
  } catch {
    /* ignore */
  }
  return { kind: "default" };
}

function SourceChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      data-testid={`chip-source-${label}`}
      className={
        "text-[10px] uppercase tracking-widest px-2 py-1 rounded-full border transition-colors " +
        (active
          ? "bg-amber-700 text-white border-amber-700"
          : "bg-transparent text-muted-foreground border-muted-foreground/40 hover:border-muted-foreground")
      }
    >
      {label}
    </button>
  );
}

export function DashboardMonthlyBuckets({
  today,
  transactions,
  resolvedUnplannedTxnIds,
}: {
  today: Date;
  transactions: Transaction[];
  resolvedUnplannedTxnIds?: ReadonlySet<string>;
}) {
  const [monthOffset, setMonthOffset] = useState(0);
  const viewMonth = useMemo(
    () => computeViewMonth(today, monthOffset),
    [today, monthOffset],
  );
  const isAtFloor = isViewMonthAtFloor(viewMonth);
  const monthLabel = monthLabelFor(viewMonth);
  const monthStartISO = useMemo(() => fmtISO(viewMonth), [viewMonth]);
  const monthEndISO = useMemo(
    () => fmtISO(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0)),
    [viewMonth],
  );

  // (#278) Per-source filter chips replace the single Amex-only toggle (#28).
  // `selectedSources` is the explicit set of source labels included in the
  // WK/MO/UN totals — toggling the last chip off yields a true empty set
  // (zero totals) rather than silently re-selecting everything.
  const initialRef = useRef<InitialSelection | null>(null);
  if (initialRef.current === null) initialRef.current = readInitialSelection();
  const [selectedSources, setSelectedSources] = useState<ReadonlySet<string>>(() => {
    const init = initialRef.current!;
    if (init.kind === "explicit") return new Set(init.selected);
    if (init.kind === "default") return new Set(["amex"]);
    // "migrate-all" — seeded once detected sources are known (effect below).
    return new Set();
  });
  // Persist any user-driven change. Skipped while we still owe the legacy
  // "include all" migration its first seed so we don't write an empty array
  // before detected sources arrive.
  const pendingMigrationRef = useRef(initialRef.current.kind === "migrate-all");
  useEffect(() => {
    if (pendingMigrationRef.current) return;
    try {
      window.localStorage.setItem(
        SELECTED_SOURCES_KEY,
        JSON.stringify(Array.from(selectedSources)),
      );
    } catch {
      /* ignore */
    }
  }, [selectedSources]);

  const detectedSources = useMemo(
    () =>
      detectChipSources(
        transactions,
        monthStartISO,
        monthEndISO,
        resolvedUnplannedTxnIds,
      ),
    [transactions, monthStartISO, monthEndISO, resolvedUnplannedTxnIds],
  );

  // One-shot migration from the legacy single-toggle key (#28): once we've
  // observed a non-empty detected set, snapshot it as the user's selection.
  useEffect(() => {
    if (!pendingMigrationRef.current) return;
    if (detectedSources.length === 0) return;
    pendingMigrationRef.current = false;
    setSelectedSources(new Set(detectedSources));
  }, [detectedSources]);

  const toggleSource = (label: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <>
      <div
        className="flex items-center justify-between gap-2 flex-wrap"
        data-testid="dashboard-month-cycler"
      >
        <div
          className="flex items-center gap-2 flex-wrap"
          data-testid="dashboard-source-chips"
        >
          {detectedSources.length === 0 ? (
            <span className="text-xs uppercase tracking-widest text-muted-foreground">
              No tagged sources yet
            </span>
          ) : (
            <>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground mr-1">
                Sources
              </span>
              {detectedSources.map((label) => (
                <SourceChip
                  key={label}
                  label={label}
                  active={selectedSources.has(label)}
                  onToggle={() => toggleSource(label)}
                />
              ))}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={() => setMonthOffset((m) => m - 1)}
            disabled={isAtFloor}
            data-testid="button-month-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span
            className="text-xs uppercase tracking-widest text-muted-foreground min-w-[140px] text-center"
            data-testid="text-month-label"
          >
            {monthLabel}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={() => setMonthOffset((m) => m + 1)}
            data-testid="button-month-next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <WeeklyMonthlySection
        transactions={transactions}
        viewMonth={viewMonth}
        today={today}
        selectedSources={selectedSources}
      />
      <MonthlyLikeSection
        title="Monthly spending"
        bucket="monthly"
        transactions={transactions}
        viewMonth={viewMonth}
        today={today}
        selectedSources={selectedSources}
      />
      <MonthlyLikeSection
        title="Unplanned spending"
        bucket="unplanned"
        transactions={transactions}
        viewMonth={viewMonth}
        today={today}
        selectedSources={selectedSources}
        resolvedUnplannedTxnIds={resolvedUnplannedTxnIds}
      />
    </>
  );
}

export default function DashboardPage() {
  const today = useMemo(() => new Date(), []);
  // Pull 12 months back so prev-month navigation in monthly sections has data.
  const monthlyFromISO = useMemo(() => {
    const start = new Date(today.getFullYear(), today.getMonth() - 12, 1);
    return fmtISO(start);
  }, [today]);
  const { data, isLoading } = useGetDashboard();
  const { data: debts } = useListDebts();
  const { data: forecastData } = useGetForecast();
  const { data: monthTxns } = useListTransactions({ from: monthlyFromISO, limit: 5000 });
  // Pull all Chase activity so end-of-month balances roll correctly between
  // the bank snapshot's anchor month and any past month displayed in the
  // dashboard's monthly snapshot.
  const { data: allTxns } = useListTransactions({ limit: 5000 });

  const bankSnapshot = forecastData?.bankSnapshot ?? null;
  // (#475) Use the same per-account snapshot resolution + scoping the
  // Chase Transactions page uses, so the dashboard tile and the Chase
  // page's "Ending balance" header agree for any month — including
  // future months that roll forward and past months that roll back
  // through synced Chase transactions.
  const accountSnapshots = forecastData?.accountSnapshots ?? {};
  const plaidCheckingAccounts = useMemo(
    () => forecastData?.plaidCheckingAccounts ?? [],
    [forecastData?.plaidCheckingAccounts],
  );
  const chaseEffectiveSnapshot = useMemo(
    () =>
      deriveEffectiveSnapshot({
        bankSnapshot,
        accountSnapshots,
        // The dashboard's Chase tile is always anchored to the primary
        // bank snapshot's own account (no per-account picker here), so
        // the helper resolves to `bankSnapshot` directly and stays in
        // lock-step with the Chase page when viewed on its default
        // account.
        selectedAccountInternalId: bankSnapshot?.accountId ?? null,
        plaidCheckingAccounts,
      }),
    [bankSnapshot, accountSnapshots, plaidCheckingAccounts],
  );
  const chasePlaidAccountId = useMemo(() => {
    if (!bankSnapshot?.accountId) return null;
    const acct = plaidCheckingAccounts.find(
      (a) => a.id === bankSnapshot.accountId,
    );
    return acct?.accountId ?? null;
  }, [bankSnapshot?.accountId, plaidCheckingAccounts]);
  // (#462) Same (institutionName, mask) collapse the Chase page now
  // applies, so the dashboard tile keeps counting transactions that
  // briefly land on a duplicate `plaid_accounts` row's external
  // account_id during a re-link window — matches the Chase page's
  // Ending Balance tile in lock-step.
  const chasePlaidAccountIds = useMemo<Set<string> | null>(() => {
    if (!chasePlaidAccountId || !bankSnapshot?.accountId) return null;
    const selected = plaidCheckingAccounts.find(
      (a) => a.id === bankSnapshot.accountId,
    );
    const ids = new Set<string>();
    ids.add(chasePlaidAccountId);
    if (!selected) return ids;
    const selInst = (selected.institutionName ?? "").toLowerCase();
    const selMask = (selected.mask ?? "").toLowerCase();
    if (!selInst || !selMask) return ids;
    for (const a of plaidCheckingAccounts) {
      if (a.id === selected.id) continue;
      if (!a.accountId) continue;
      const inst = (a.institutionName ?? "").toLowerCase();
      const mask = (a.mask ?? "").toLowerCase();
      if (inst === selInst && mask === selMask) {
        ids.add(a.accountId);
      }
    }
    return ids;
  }, [chasePlaidAccountId, bankSnapshot?.accountId, plaidCheckingAccounts]);

  const chaseTransactions = useMemo(
    () => scopeChaseTransactions(allTxns ?? [], chasePlaidAccountIds ?? null),
    [allTxns, chasePlaidAccountIds],
  );

  const chaseEndingBalance = useMemo(() => {
    return (monthStart: string): number | null =>
      computeChaseEndOfMonthBalance({
        monthStart,
        effectiveSnapshot: chaseEffectiveSnapshot,
        chaseTransactions,
      });
  }, [chaseEffectiveSnapshot, chaseTransactions]);

  // (#574) Amex ending balance tile — mirrors the Amex page's
  // `resolvedAnchor` (linked Amex debt, else `/api/amex/anchor`) and
  // routes through `computeAmexEndOfMonthBalance` so the dashboard tile
  // and the Amex page header agree for any selected month.
  const { data: amexAnchorResp } = useQuery<{
    amexEndingBalance: number | null;
    asOf: string;
    source: "debt" | "anchor" | "computed" | "plaid" | "missing";
  }>({
    queryKey: ["/api/amex/anchor"],
    queryFn: () => customFetch("/api/amex/anchor", { method: "GET" }),
    staleTime: 60_000,
  });
  const amexTransactions = useMemo(() => {
    const out: Transaction[] = [];
    for (const t of allTxns ?? []) {
      const s = (t.source ?? "").toLowerCase();
      if (s === "amex" || s === "plaid:amex") out.push(t);
    }
    return out;
  }, [allTxns]);
  // (#574) Mirror the Amex page: derive Plaid account ids from the
  // page's amex transactions and feed them — together with the live
  // Plaid items — into the shared `resolveAmexDebt` helper so multi-
  // card / Plaid-linked households get the same anchor here as on the
  // Amex page (linked-debt preference, multi-card aggregation, and
  // institution+mask dedupe all included).
  const amexPlaidAccountIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of amexTransactions) {
      if (t.plaidAccountId) s.add(t.plaidAccountId);
    }
    return s;
  }, [amexTransactions]);
  const { data: amexPlaidItemsForScope } = useListPlaidItems();
  const amexDebt = useMemo(
    () =>
      resolveAmexDebt({
        debts,
        amexPlaidAccountIds,
        plaidItemsForScope: amexPlaidItemsForScope,
      }),
    [debts, amexPlaidAccountIds, amexPlaidItemsForScope],
  );
  const amexResolvedAnchor = useMemo(
    () => resolveAmexAnchor({ amexDebt, amexAnchorResp }),
    [amexDebt, amexAnchorResp],
  );
  const amexFallbackMonth = useMemo(() => monthKeyOf(today), [today]);
  const amexEndingBalance = useMemo(() => {
    return (monthStart: string): number | null =>
      computeAmexEndOfMonthBalance({
        monthStart,
        anchor: amexResolvedAnchor,
        amexTransactions,
        fallbackMonth: amexFallbackMonth,
      });
  }, [amexResolvedAnchor, amexTransactions, amexFallbackMonth]);
  // All-time reimbursables — no date window, server filters by reimbursable=true.
  const { data: reimbTxns, isLoading: reimbLoading } = useListTransactions({
    reimbursable: true,
    limit: 100000,
  });
  // Mapping rules feed the MatchedRuleChip on Recent Transactions and
  // ReimbursementsBox rows; the chip looks up the rule by id to render
  // its pattern. Same source of truth as the Transactions / Amex pages.
  const { data: mappingRules } = useListMappingRules();

  const monthlyTagged = useMemo(() => monthTxns ?? [], [monthTxns]);
  const reimbursementsAll = useMemo(() => reimbTxns ?? [], [reimbTxns]);

  // (#482) Roll forecast-inbox "Mark Unplanned" actions into the dashboard's
  // Unplanned spending bucket. The forecast write path stamps a resolution
  // of `ignored_unforecasted` (legacy `unplanned`) against the bank txn's
  // id; surface that set so MonthlyLikeSection can include those txns
  // alongside the manually-tagged `unplannedAllowance` rows.
  const resolvedUnplannedTxnIds = useMemo(() => {
    const ids = new Set<string>();
    const rs = forecastData?.resolutions ?? [];
    for (const r of rs) {
      if (!r.matchedTxnId) continue;
      if (r.status === "ignored_unforecasted" || r.status === "unplanned") {
        ids.add(r.matchedTxnId);
      }
    }
    return ids;
  }, [forecastData?.resolutions]);

  // Gate on data only — global keepPreviousData keeps the previous
  // dashboard visible during refetches so we never flash a skeleton
  // after the first load.
  if (!data) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-serif font-bold text-foreground">Dashboard</h1>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <DebtReauthBanner debts={debts} />
      <PlaidExpiringSoonList />
      <DashboardSnapshotSection
        today={today}
        totalDebt={data.totalDebt}
        activeDebtCount={data.activeDebtCount}
        chaseEndingBalance={chaseEndingBalance}
        amexEndingBalance={amexEndingBalance}
        bankSnapshot={
          bankSnapshot
            ? { source: bankSnapshot.source, at: bankSnapshot.at }
            : null
        }
      />

      <DashboardMonthlyBuckets
        today={today}
        transactions={monthlyTagged}
        resolvedUnplannedTxnIds={resolvedUnplannedTxnIds}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Net Cashflow
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold tabular-nums ${Number(data.netCashflow) < 0 ? "text-destructive" : "text-primary"}`}>
              {formatCurrency(data.netCashflow)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Monthly Income
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{formatCurrency(data.monthlyIncome)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Monthly Spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{formatCurrency(data.monthlySpend)}</div>
          </CardContent>
        </Card>
        <DebtProgressCard
          owed={data.totalDebt}
          paidThisMonth={data.paidThisMonth}
          paidLifetime={data.paidLifetime}
          activeDebtCount={data.activeDebtCount}
        />
      </div>

      <AvalancheReadyCard />

      <DashboardKillOrder />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Recent Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {data.recentTransactions.map((tx) => (
                <div
                  key={tx.id}
                  className="flex justify-between items-center pb-3 border-b border-border last:border-0 last:pb-0"
                  data-testid={`row-recent-${tx.id}`}
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-foreground truncate">{tx.description}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(tx.occurredOn)}</p>
                    <div className="mt-0.5">
                      <MatchedRuleChip
                        categoryId={tx.categoryId}
                        matchedRuleId={tx.matchedRuleId}
                        rules={mappingRules}
                        testIdSuffix={`recent-${tx.id}`}
                        variant="compact"
                      />
                    </div>
                  </div>
                  <div className={`font-medium text-sm tabular-nums ${Number(tx.amount) < 0 ? "text-destructive" : "text-primary"}`}>
                    {formatCurrency(tx.amount)}
                  </div>
                </div>
              ))}
              {data.recentTransactions.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  All clear — no recent activity to show.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <ReimbursementsBox
          transactions={reimbursementsAll}
          isLoading={reimbLoading}
          today={today}
          mappingRules={mappingRules}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Top Categories</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {data.topCategories.map((cat) => (
                <div
                  key={cat.categoryName}
                  className="flex justify-between items-center pb-3 border-b border-border last:border-0 last:pb-0"
                >
                  <span className="text-sm font-medium text-foreground">{cat.categoryName}</span>
                  <span className="text-sm font-medium tabular-nums">{formatCurrency(cat.total)}</span>
                </div>
              ))}
              {data.topCategories.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  All clear — no categories with spend yet this month.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Upcoming Bills</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {data.upcomingBills.map((b) => (
                <div
                  key={b.id}
                  className="flex justify-between items-center pb-3 border-b border-border last:border-0 last:pb-0"
                >
                  <div>
                    <span className="text-sm font-medium text-foreground">{b.name}</span>
                    <p className="text-xs text-muted-foreground capitalize">
                      {b.frequency}{b.dayOfMonth ? ` · day ${b.dayOfMonth}` : ""}
                    </p>
                  </div>
                  <span className="text-sm font-medium tabular-nums">{formatCurrency(b.amount)}</span>
                </div>
              ))}
              {data.upcomingBills.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  All clear — no recurring bills on the radar.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

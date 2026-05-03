import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useGetDashboard,
  useListTransactions,
  useListDashboardBudgets,
  useUpsertDashboardBudget,
  getListDashboardBudgetsQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { DashboardKillOrder } from "@/components/dashboard-kill-order";

import { SUB_BUCKETS, type SubBucket, useWeeklyBucketLabels } from "@/lib/weeklyBuckets";

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function expenseAmount(t: Transaction): number {
  const a = Number(t.amount) || 0;
  return a < 0 ? -a : 0;
}

function useBudgetEditor(bucket: "weekly" | "monthly" | "unplanned", periodKey: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: budgets } = useListDashboardBudgets({ bucket, periodKey });
  const upsert = useUpsertDashboardBudget();
  const saved = Number(budgets?.[0]?.amount ?? 0);
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
  return { saved, editing, draft, setDraft, beginEdit, save, setEditing, isPending: upsert.isPending };
}

function CapInline({
  saved,
  editing,
  draft,
  setDraft,
  beginEdit,
  save,
  setEditing,
  isPending,
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
    <button
      type="button"
      className="text-3xl md:text-4xl font-serif font-light text-muted-foreground hover:text-foreground transition-colors"
      onClick={beginEdit}
      title="Click to edit cap"
    >
      / {formatCurrency(saved)}
    </button>
  );
}

function LifeThisWeek({
  transactions,
  today,
}: {
  transactions: Transaction[];
  today: Date;
}) {
  const SUB_LABEL = useWeeklyBucketLabels();
  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = useMemo(
    () => addDays(startOfWeek(today), weekOffset * 7),
    [today, weekOffset],
  );
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const periodKey = fmtISO(weekStart);

  const editor = useBudgetEditor("weekly", periodKey);

  const { totals, total } = useMemo(() => {
    const t: Record<SubBucket, number> = { groceries: 0, dining: 0, entertainment: 0, misc: 0 };
    let sum = 0;
    const startIso = fmtISO(weekStart);
    const endIso = fmtISO(weekEnd);
    for (const tx of transactions) {
      if (!tx.weeklyAllowance) continue;
      if (tx.occurredOn < startIso || tx.occurredOn > endIso) continue;
      const amt = expenseAmount(tx);
      const bucket = (tx.weeklyBucket as SubBucket | null | undefined) ?? "misc";
      if (SUB_BUCKETS.includes(bucket)) t[bucket] += amt;
      else t.misc += amt;
      sum += amt;
    }
    return { totals: t, total: sum };
  }, [transactions, weekStart, weekEnd]);

  const cap = editor.saved;
  const remaining = Math.max(0, cap - total);
  const pct = cap > 0 ? Math.min(100, (total / cap) * 100) : 0;
  const overspent = cap > 0 && total > cap;

  const isCurrentWeek = weekOffset === 0;
  const dayOfWeek = isCurrentWeek
    ? Math.min(7, Math.max(1, today.getDay() + 1))
    : 7;

  const rangeLabel = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <section>
      <div className="flex items-end justify-between mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-amber-700 font-medium">
            WEEKLY {formatCurrency(cap)}
          </div>
          <h2 className="text-2xl font-serif font-bold text-foreground">Life this week</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => setWeekOffset((w) => w - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs uppercase tracking-widest text-muted-foreground min-w-[110px] text-center">
            {rangeLabel}
          </span>
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => setWeekOffset((w) => w + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
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
              {formatCurrency(remaining)} left · day {dayOfWeek} of 7
            </div>
          </div>
          <Progress value={pct} className={overspent ? "[&>div]:bg-destructive" : ""} />
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
          <div className="text-xs text-muted-foreground border-t pt-3">
            Tag any other Amex charge as "weekly" on the{" "}
            <Link href="/amex" className="text-amber-700 underline">Amex page</Link> to add it to {SUB_LABEL.misc}.
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
  today,
}: {
  title: string;
  bucket: "monthly" | "unplanned";
  transactions: Transaction[];
  today: Date;
}) {
  const [monthOffset, setMonthOffset] = useState(0);
  const viewMonth = useMemo(
    () => new Date(today.getFullYear(), today.getMonth() + monthOffset, 1),
    [today, monthOffset],
  );
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
      const matches = bucket === "monthly" ? t.monthlyAllowance : t.unplannedAllowance;
      if (!matches) return false;
      return t.occurredOn >= monthStartISO && t.occurredOn <= monthEndISO;
    });
    const sum = filtered.reduce((s, t) => s + expenseAmount(t), 0);
    const sorted = [...filtered].sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1)).slice(0, 8);
    return { total: sum, recent: sorted };
  }, [transactions, bucket, monthStartISO, monthEndISO]);

  const cap = editor.saved;
  const overspent = cap > 0 && total > cap;
  const pct = cap > 0 ? Math.min(100, (total / cap) * 100) : 0;
  const monthLabel = viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const isCurrentMonth = monthOffset === 0;
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => setMonthOffset((m) => m - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs uppercase tracking-widest text-muted-foreground min-w-[140px] text-center">
            {monthLabel}
          </span>
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => setMonthOffset((m) => m + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
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
              Recent ({recent.length})
            </div>
            {recent.length === 0 ? (
              <div className="text-sm text-muted-foreground py-2">
                Nothing tagged yet. Tag charges as "{bucket}" on the{" "}
                <Link href="/amex" className="text-amber-700 underline">Amex page</Link>.
              </div>
            ) : (
              <div className="space-y-2">
                {recent.map((t) => {
                  const amt = Number(t.amount) || 0;
                  return (
                    <div key={t.id} className="flex items-center justify-between gap-3 text-sm">
                      <div className="flex items-baseline gap-3 min-w-0">
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground w-12 shrink-0">
                          {new Date(t.occurredOn + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                        <span className="truncate">{t.description}</span>
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

export default function DashboardPage() {
  const today = useMemo(() => new Date(), []);
  const currentMonthStartISO = useMemo(
    () => fmtISO(new Date(today.getFullYear(), today.getMonth(), 1)),
    [today],
  );
  // Pull a wider window so prev/next week navigation has data.
  const fromISO = useMemo(() => {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return fmtISO(start);
  }, [today]);
  // Pull 12 months back so prev-month navigation in monthly sections has data.
  const monthlyFromISO = useMemo(() => {
    const start = new Date(today.getFullYear(), today.getMonth() - 12, 1);
    return fmtISO(start);
  }, [today]);

  const { data, isLoading } = useGetDashboard();
  const { data: txns } = useListTransactions({ from: fromISO, limit: 1000 });
  const { data: monthTxns } = useListTransactions({ from: monthlyFromISO, limit: 5000 });

  const allTxns = txns ?? [];
  const monthlyTagged = useMemo(() => monthTxns ?? [], [monthTxns]);

  const reimbursables = useMemo(
    () => monthlyTagged.filter(
      (t) => t.reimbursable && !t.reimbursed && t.occurredOn >= currentMonthStartISO,
    ),
    [monthlyTagged, currentMonthStartISO],
  );
  const reimbursableTotal = useMemo(
    () => reimbursables.reduce((s, t) => s + expenseAmount(t), 0),
    [reimbursables],
  );

  if (isLoading || !data) {
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
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground tracking-tight">
          Ledger Overview
        </h1>
        <p className="text-muted-foreground mt-1">
          Your family's financial snapshot.
        </p>
      </div>

      <LifeThisWeek transactions={allTxns} today={today} />
      <MonthlyLikeSection
        title="Monthly spending"
        bucket="monthly"
        transactions={monthlyTagged}
        today={today}
      />
      <MonthlyLikeSection
        title="Unplanned spending"
        bucket="unplanned"
        transactions={monthlyTagged}
        today={today}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Debt
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{formatCurrency(data.totalDebt)}</div>
          </CardContent>
        </Card>
      </div>

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
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-foreground truncate">{tx.description}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(tx.occurredOn)}</p>
                  </div>
                  <div className={`font-medium text-sm tabular-nums ${Number(tx.amount) < 0 ? "text-destructive" : "text-primary"}`}>
                    {formatCurrency(tx.amount)}
                  </div>
                </div>
              ))}
              {data.recentTransactions.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No recent transactions.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <Receipt className="w-4 h-4" /> Reimbursables
            </CardTitle>
            <Badge variant="outline">{formatCurrency(reimbursableTotal)}</Badge>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-72 overflow-y-auto">
              {reimbursables.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  None outstanding.
                </p>
              )}
              {reimbursables.map((tx) => (
                <div key={tx.id} className="flex justify-between items-center text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{tx.description}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(tx.occurredOn)}</p>
                  </div>
                  <span className="font-medium tabular-nums">
                    {formatCurrency(Math.abs(Number(tx.amount) || 0))}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
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
                  No data available.
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
                  No recurring items yet.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

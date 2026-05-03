import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useGetDashboard,
  useGetBudgetMonth,
  useGetForecast,
  useListTransactions,
  useListDashboardBudgets,
  useUpsertDashboardBudget,
  useDeleteDashboardBudget,
  useUpdateTransaction,
  getListDashboardBudgetsQueryKey,
  getListTransactionsQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { computeBalanceAtEndOf } from "@/lib/accountBalance";
import { monthKeyFromISO, type MonthKey } from "@/components/account-page";
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
import { AvalancheReadyCard } from "@/components/avalanche-ready-card";

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

function WeeklyMonthlySection({
  transactions,
  viewMonth,
  today,
}: {
  transactions: Transaction[];
  viewMonth: Date;
  today: Date;
}) {
  const SUB_LABEL = useWeeklyBucketLabels();
  const monthKey = useMemo(
    () => `${viewMonth.getFullYear()}-${String(viewMonth.getMonth() + 1).padStart(2, "0")}`,
    [viewMonth],
  );
  const monthStartISO = useMemo(() => fmtISO(viewMonth), [viewMonth]);
  const monthEndISO = useMemo(
    () => fmtISO(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0)),
    [viewMonth],
  );

  const editor = useBudgetEditor("weekly", monthKey);

  const { totals, total, monthTxns } = useMemo(() => {
    const t: Record<SubBucket, number> = { groceries: 0, dining: 0, entertainment: 0, misc: 0 };
    let sum = 0;
    const list: Transaction[] = [];
    for (const tx of transactions) {
      if (tx.source !== "amex") continue;
      if (!tx.weeklyAllowance) continue;
      if (tx.occurredOn < monthStartISO || tx.occurredOn > monthEndISO) continue;
      const amt = expenseAmount(tx);
      const bucket = (tx.weeklyBucket as SubBucket | null | undefined) ?? "misc";
      if (SUB_BUCKETS.includes(bucket)) t[bucket] += amt;
      else t.misc += amt;
      sum += amt;
      list.push(tx);
    }
    list.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
    return { totals: t, total: sum, monthTxns: list };
  }, [transactions, monthStartISO, monthEndISO]);

  const cap = editor.saved;
  const remaining = Math.max(0, cap - total);
  const pct = cap > 0 ? Math.min(100, (total / cap) * 100) : 0;
  const overspent = cap > 0 && total > cap;

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
            WEEKLY {formatCurrency(cap)}
          </div>
          <h2 className="text-2xl font-serif font-bold text-foreground">Life spending</h2>
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
              {formatCurrency(remaining)} left · day {dayOfMonth} of {daysInMonth}
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
          <div className="border-t pt-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
              This month ({monthTxns.length})
            </div>
            {monthTxns.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">
                Nothing tagged yet. Tag charges as "weekly" on the{" "}
                <Link href="/amex" className="text-amber-700 underline">Amex page</Link>.
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {monthTxns.map((t) => {
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

function MonthlyLikeSection({
  title,
  bucket,
  transactions,
  viewMonth,
  today,
}: {
  title: string;
  bucket: "monthly" | "unplanned";
  transactions: Transaction[];
  viewMonth: Date;
  today: Date;
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
      if (t.source !== "amex") return false;
      const matches = bucket === "monthly" ? t.monthlyAllowance : t.unplannedAllowance;
      if (!matches) return false;
      return t.occurredOn >= monthStartISO && t.occurredOn <= monthEndISO;
    });
    const sum = filtered.reduce((s, t) => s + expenseAmount(t), 0);
    const sorted = [...filtered].sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
    return { total: sum, recent: sorted };
  }, [transactions, bucket, monthStartISO, monthEndISO]);

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
                Nothing tagged yet. Tag charges as "{bucket}" on the{" "}
                <Link href="/amex" className="text-amber-700 underline">Amex page</Link>.
              </div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
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

function ReimbursementsBox({
  transactions,
  isLoading,
  today,
}: {
  transactions: Transaction[];
  isLoading?: boolean;
  today: Date;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateTx = useUpdateTransaction();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

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

  const reimbursed = useMemo(
    () =>
      reimbursable
        .filter((t) => t.reimbursed)
        .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1)),
    [reimbursable],
  );

  const knownPayers = useMemo(() => {
    const s = new Set<string>();
    for (const t of reimbursable) {
      const v = (t.owedBy ?? "").trim();
      if (v) s.add(v);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [reimbursable]);

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

  const applyOptimisticOwedBy = (id: string, next: string | null) => {
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
        if ((row.owedBy ?? null) === next) return row;
        changed = true;
        return { ...row, owedBy: next };
      });
      if (changed) qc.setQueryData(key, updated);
    }
    return snapshot;
  };

  const setOwedBy = async (t: Transaction, raw: string) => {
    const trimmed = raw.trim();
    const next: string | null = trimmed.length === 0 ? null : trimmed;
    if ((t.owedBy ?? null) === next) return;
    const snapshot = applyOptimisticOwedBy(t.id, next);
    try {
      await updateTx.mutateAsync({ id: t.id, data: { owedBy: next } });
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    } catch (e) {
      rollback(snapshot);
      toast({
        title: "Couldn't update owed by",
        description: (e as Error).message,
        variant: "destructive",
      });
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

  const owedByListId = "dashboard-owed-by-suggestions";

  const renderRow = (t: Transaction, reimbursed: boolean) => {
    const amt = expenseAmount(t);
    return (
      <div
        key={t.id}
        className={cn(
          "flex items-center gap-3 text-sm py-1 transition-opacity",
          reimbursed && "opacity-60",
        )}
      >
        <Checkbox
          checked={reimbursed}
          disabled={pendingIds.has(t.id)}
          onCheckedChange={(v) => setReimbursed(t, !!v)}
          aria-label={reimbursed ? "Move back to pending" : "Mark reimbursed"}
        />
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
        </div>
        <Input
          key={t.owedBy ?? ""}
          list={owedByListId}
          defaultValue={t.owedBy ?? ""}
          placeholder="Owed by…"
          aria-label={`Owed by for ${t.description}`}
          className="h-7 w-32 text-xs"
          onBlur={(e) => {
            if ((e.currentTarget.value.trim() || null) !== (t.owedBy ?? null)) {
              setOwedBy(t, e.currentTarget.value);
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
      <datalist id={owedByListId}>
        {knownPayers.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
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
                  <span
                    key={payer}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
                      payer === "Unassigned"
                        ? "border-dashed text-muted-foreground"
                        : "bg-muted/40",
                    )}
                    title={`${payer}: ${count} item${count === 1 ? "" : "s"}`}
                  >
                    <span className="font-medium">{payer}</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(total)}
                    </span>
                  </span>
                ))}
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
            Nothing tagged reimbursable yet.
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

function MonthlySnapshot({
  today,
  totalDebt,
  activeDebtCount,
  chaseEndingBalance,
}: {
  today: Date;
  totalDebt: string;
  activeDebtCount: number;
  chaseEndingBalance: (monthStart: string) => number | null;
}) {
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

  const { data: budget, isLoading } = useGetBudgetMonth(monthStart);
  const summary = budget?.summary;

  const incomeActual = parseFloat(summary?.income.actual ?? "0") || 0;
  const incomeBudget = parseFloat(summary?.income.budget ?? "0") || 0;
  const expensesActual = parseFloat(summary?.expenses.actual ?? "0") || 0;
  const expensesBudget = parseFloat(summary?.expenses.budget ?? "0") || 0;

  // Split debt vs everyday expenses using auto_debts groups in the response.
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                    <div className="text-3xl font-serif font-bold tabular-nums mt-1 text-muted-foreground">
                      —
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
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
            <div
              className={cn(
                "text-3xl font-serif font-bold tabular-nums mt-1",
                netPositive
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive",
              )}
            >
              {netPositive ? "" : "-"}
              {formatCurrency(Math.abs(net))}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              income − spend − debt paid
            </div>
          </CardContent>
        </Card>
      </div>

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

export function DashboardMonthlyBuckets({
  today,
  transactions,
}: {
  today: Date;
  transactions: Transaction[];
}) {
  const [monthOffset, setMonthOffset] = useState(0);
  const viewMonth = useMemo(
    () => computeViewMonth(today, monthOffset),
    [today, monthOffset],
  );
  const isAtFloor = isViewMonthAtFloor(viewMonth);
  const monthLabel = monthLabelFor(viewMonth);

  return (
    <>
      <div
        className="flex items-center justify-end gap-2"
        data-testid="dashboard-month-cycler"
      >
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

      <WeeklyMonthlySection
        transactions={transactions}
        viewMonth={viewMonth}
        today={today}
      />
      <MonthlyLikeSection
        title="Monthly spending"
        bucket="monthly"
        transactions={transactions}
        viewMonth={viewMonth}
        today={today}
      />
      <MonthlyLikeSection
        title="Unplanned spending"
        bucket="unplanned"
        transactions={transactions}
        viewMonth={viewMonth}
        today={today}
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
  const { data: forecastData } = useGetForecast();
  const { data: monthTxns } = useListTransactions({ from: monthlyFromISO, limit: 5000 });
  // Pull all Chase activity so end-of-month balances roll correctly between
  // the bank snapshot's anchor month and any past month displayed in the
  // dashboard's monthly snapshot.
  const { data: allTxns } = useListTransactions({ limit: 5000 });

  const bankSnapshot = forecastData?.bankSnapshot ?? null;
  const chasePlaidAccountId = useMemo(() => {
    if (!bankSnapshot?.accountId) return null;
    const acct = (forecastData?.plaidCheckingAccounts ?? []).find(
      (a) => a.id === bankSnapshot.accountId,
    );
    return acct?.accountId ?? null;
  }, [bankSnapshot?.accountId, forecastData?.plaidCheckingAccounts]);

  const chaseTransactions = useMemo(() => {
    const all = allTxns ?? [];
    if (chasePlaidAccountId) {
      return all.filter((t) => t.plaidAccountId === chasePlaidAccountId);
    }
    return all.filter((t) => !t.plaidAccountId);
  }, [allTxns, chasePlaidAccountId]);

  const chaseNetChangeByMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of chaseTransactions) {
      const mk = monthKeyFromISO(t.occurredOn);
      const k = `${mk.year}-${mk.month}`;
      m.set(k, (m.get(k) ?? 0) + (Number(t.amount) || 0));
    }
    return m;
  }, [chaseTransactions]);

  const chaseAnchorBalance = bankSnapshot
    ? Number(bankSnapshot.balance) || 0
    : null;
  const chaseAnchorMonth = useMemo<MonthKey | null>(() => {
    if (!bankSnapshot?.at) return null;
    return monthKeyFromISO(bankSnapshot.at);
  }, [bankSnapshot?.at]);

  const chaseEndingBalance = useMemo(() => {
    return (monthStart: string): number | null => {
      if (chaseAnchorBalance === null || chaseAnchorMonth === null) return null;
      const target = monthKeyFromISO(monthStart);
      return computeBalanceAtEndOf({
        anchorBalance: chaseAnchorBalance,
        anchorMonth: chaseAnchorMonth,
        netChangeByMonth: chaseNetChangeByMonth,
        target,
      });
    };
  }, [chaseAnchorBalance, chaseAnchorMonth, chaseNetChangeByMonth]);
  // All-time reimbursables — no date window, server filters by reimbursable=true.
  const { data: reimbTxns, isLoading: reimbLoading } = useListTransactions({
    reimbursable: true,
    limit: 100000,
  });

  const monthlyTagged = useMemo(() => monthTxns ?? [], [monthTxns]);
  const reimbursementsAll = useMemo(() => reimbTxns ?? [], [reimbTxns]);

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
      <div className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-4 md:pt-8 pb-4 bg-background border-b shadow-sm space-y-8">
        <DashboardHero today={today} />
        <MonthlySnapshot
          today={today}
          totalDebt={data.totalDebt}
          activeDebtCount={data.activeDebtCount}
          chaseEndingBalance={chaseEndingBalance}
        />
      </div>

      <DashboardMonthlyBuckets
        today={today}
        transactions={monthlyTagged}
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

        <ReimbursementsBox
          transactions={reimbursementsAll}
          isLoading={reimbLoading}
          today={today}
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

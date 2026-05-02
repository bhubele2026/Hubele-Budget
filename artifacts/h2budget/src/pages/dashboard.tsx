import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetDashboard,
  useListTransactions,
  useListDashboardBudgets,
  useUpsertDashboardBudget,
  getListDashboardBudgetsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Edit2, Wallet, TrendingUp, TrendingDown, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function startOfWeek(d: Date): Date {
  const day = d.getDay();
  const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return sunday;
}

function fmtISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function AllowanceCard(props: {
  title: string;
  bucket: "weekly" | "monthly" | "unplanned";
  periodKey: string;
  spent: number;
  icon: React.ReactNode;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: budgets } = useListDashboardBudgets({
    bucket: props.bucket,
    periodKey: props.periodKey,
  });
  const upsert = useUpsertDashboardBudget();

  const saved = Number(budgets?.[0]?.amount ?? 0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const remaining = Math.max(0, saved - props.spent);
  const pct = saved > 0 ? Math.min(100, (props.spent / saved) * 100) : 0;
  const overspent = saved > 0 && props.spent > saved;

  const handleSave = () => {
    upsert.mutate(
      {
        data: {
          bucket: props.bucket,
          periodKey: props.periodKey,
          amount: draft || "0",
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getListDashboardBudgetsQueryKey({
              bucket: props.bucket,
              periodKey: props.periodKey,
            }),
          });
          setEditing(false);
          toast({ title: "Budget updated" });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          {props.icon}
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {props.title}
          </CardTitle>
        </div>
        {!editing && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => {
              setDraft(String(saved));
              setEditing(true);
            }}
          >
            <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <div className="flex gap-2 items-center">
            <Input
              type="number"
              step="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8"
              autoFocus
            />
            <Button size="sm" onClick={handleSave} disabled={upsert.isPending}>
              Save
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold tabular-nums">
                {formatCurrency(remaining)}
              </span>
              <span className="text-xs text-muted-foreground">
                of {formatCurrency(saved)}
              </span>
            </div>
            <Progress value={pct} className={overspent ? "[&>div]:bg-destructive" : ""} />
            <div className="text-xs text-muted-foreground">
              {formatCurrency(props.spent)} spent
              {overspent && <span className="text-destructive ml-1">· over budget</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const today = useMemo(() => new Date(), []);
  const monthStartISO = useMemo(
    () => fmtISO(new Date(today.getFullYear(), today.getMonth(), 1)),
    [today],
  );
  const weekStartISO = useMemo(() => fmtISO(startOfWeek(today)), [today]);
  const monthKey = useMemo(
    () => `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`,
    [today],
  );

  const { data, isLoading } = useGetDashboard();
  const { data: monthTxns } = useListTransactions({
    from: monthStartISO,
    limit: 1000,
  });

  const { weeklySpent, monthlySpent, unplannedSpent, reimbursables } = useMemo(() => {
    const txns = monthTxns ?? [];
    const weekStartDate = startOfWeek(today);
    let w = 0,
      m = 0,
      u = 0;
    const reim: typeof txns = [];
    for (const t of txns) {
      const amt = Number(t.amount) || 0;
      const expense = amt < 0 ? -amt : 0;
      if (t.weeklyAllowance && new Date(t.occurredOn) >= weekStartDate) w += expense;
      if (t.monthlyAllowance) m += expense;
      if (t.unplannedAllowance) u += expense;
      if (t.reimbursable && !t.reimbursed) reim.push(t);
    }
    return {
      weeklySpent: w,
      monthlySpent: m,
      unplannedSpent: u,
      reimbursables: reim,
    };
  }, [monthTxns, today]);

  const reimbursableTotal = useMemo(
    () =>
      reimbursables.reduce((s, t) => {
        const amt = Number(t.amount) || 0;
        return s + (amt < 0 ? -amt : 0);
      }, 0),
    [reimbursables],
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-serif font-bold text-foreground">Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-32" /></CardContent>
            </Card>
          ))}
        </div>
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

      <div>
        <h2 className="text-lg font-serif font-semibold mb-3 text-foreground">Allowance Buckets</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <AllowanceCard
            title="Weekly"
            bucket="weekly"
            periodKey={weekStartISO}
            spent={weeklySpent}
            icon={<Wallet className="w-4 h-4 text-muted-foreground" />}
          />
          <AllowanceCard
            title="Monthly"
            bucket="monthly"
            periodKey={monthKey}
            spent={monthlySpent}
            icon={<TrendingUp className="w-4 h-4 text-muted-foreground" />}
          />
          <AllowanceCard
            title="Unplanned"
            bucket="unplanned"
            periodKey={monthKey}
            spent={unplannedSpent}
            icon={<TrendingDown className="w-4 h-4 text-muted-foreground" />}
          />
        </div>
      </div>

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

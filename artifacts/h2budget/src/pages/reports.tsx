import { useMemo, useState } from "react";
import {
  useListTransactions,
  useGetBudgetMonth,
  useListCategories,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";

function fmtISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
];

const PIE_COLORS = [
  "hsl(160, 45%, 32%)",
  "hsl(160, 35%, 50%)",
  "hsl(40, 60%, 55%)",
  "hsl(20, 70%, 55%)",
  "hsl(280, 35%, 55%)",
  "hsl(200, 45%, 50%)",
  "hsl(0, 60%, 55%)",
  "hsl(120, 35%, 45%)",
];

export default function ReportsPage() {
  const [rangeDays, setRangeDays] = useState("90");
  const [monthOffset, setMonthOffset] = useState("0");

  const today = useMemo(() => new Date(), []);
  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - Number(rangeDays));
    return d;
  }, [today, rangeDays]);

  const { data: txns, isLoading } = useListTransactions({
    from: fmtISO(fromDate),
    limit: 5000,
  });
  const { data: categories } = useListCategories();
  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // Cash flow series (income/expense per day)
  const cashSeries = useMemo(() => {
    if (!txns) return [];
    const byDay = new Map<string, { date: string; income: number; expense: number }>();
    for (const t of txns) {
      const day = t.occurredOn;
      const amt = Number(t.amount) || 0;
      const slot = byDay.get(day) ?? { date: day, income: 0, expense: 0 };
      if (amt > 0) slot.income += amt;
      else slot.expense += -amt;
      byDay.set(day, slot);
    }
    return Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [txns]);

  // Aggregate cash flow into weekly buckets when range > 60 days
  const cashChartData = useMemo(() => {
    if (Number(rangeDays) <= 60) return cashSeries;
    const weekly = new Map<string, { date: string; income: number; expense: number }>();
    for (const r of cashSeries) {
      const d = new Date(r.date);
      const sun = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
      const key = fmtISO(sun);
      const slot = weekly.get(key) ?? { date: key, income: 0, expense: 0 };
      slot.income += r.income;
      slot.expense += r.expense;
      weekly.set(key, slot);
    }
    return Array.from(weekly.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [cashSeries, rangeDays]);

  // Category breakdown (expenses)
  const categoryBreakdown = useMemo(() => {
    if (!txns) return [];
    const map = new Map<string, number>();
    for (const t of txns) {
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue;
      const key = t.categoryId ?? "uncategorized";
      map.set(key, (map.get(key) ?? 0) + -amt);
    }
    const arr = Array.from(map.entries()).map(([k, v]) => ({
      name: k === "uncategorized" ? "Uncategorized" : catNameById.get(k) ?? "Uncategorized",
      value: v,
    }));
    arr.sort((a, b) => b.value - a.value);
    return arr.slice(0, 8);
  }, [txns]);

  // Budget vs Actual for the chosen month
  const budgetMonth = useMemo(() => {
    const d = new Date(today.getFullYear(), today.getMonth() - Number(monthOffset), 1);
    return fmtISO(d);
  }, [today, monthOffset]);
  const { data: budget } = useGetBudgetMonth(budgetMonth);

  const budgetChartData = useMemo(() => {
    if (!budget) return [];
    return budget.lines
      .map((l) => ({
        name: l.categoryName,
        Budgeted: Number(l.plannedAmount) || 0,
        Actual: Number(l.actualAmount) || 0,
      }))
      .sort((a, b) => b.Budgeted - a.Budgeted)
      .slice(0, 12);
  }, [budget]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground tracking-tight">Reports</h1>
        <p className="text-muted-foreground mt-1">Cashflow trends, category mix, and budget variance.</p>
      </div>

      <Tabs defaultValue="cashflow">
        <TabsList>
          <TabsTrigger value="cashflow">Cash Flow</TabsTrigger>
          <TabsTrigger value="budget">Budget vs Actual</TabsTrigger>
          <TabsTrigger value="categories">Category Mix</TabsTrigger>
        </TabsList>

        <TabsContent value="cashflow" className="mt-4 space-y-4">
          <div className="flex items-center gap-3">
            <Label className="text-sm">Range</Label>
            <Select value={rangeDays} onValueChange={setRangeDays}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Income vs Expense</CardTitle>
            </CardHeader>
            <CardContent className="h-96">
              {cashChartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No transactions in this window.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={cashChartData} margin={{ top: 10, right: 16, bottom: 30, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v)}`} />
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    <Legend />
                    <Line type="monotone" dataKey="income" stroke="hsl(160, 45%, 32%)" strokeWidth={2} dot={false} name="Income" />
                    <Line type="monotone" dataKey="expense" stroke="hsl(0, 60%, 55%)" strokeWidth={2} dot={false} name="Expense" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="budget" className="mt-4 space-y-4">
          <div className="flex items-center gap-3">
            <Label className="text-sm">Month</Label>
            <Select value={monthOffset} onValueChange={setMonthOffset}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">This month</SelectItem>
                <SelectItem value="1">Last month</SelectItem>
                <SelectItem value="2">2 months ago</SelectItem>
                <SelectItem value="3">3 months ago</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Budgeted vs Actual — {budgetMonth.slice(0, 7)}</CardTitle>
            </CardHeader>
            <CardContent className="h-96">
              {budgetChartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No budget set for this month.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={budgetChartData} margin={{ top: 10, right: 16, bottom: 60, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v)}`} />
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    <Legend />
                    <Bar dataKey="Budgeted" fill="hsl(160, 35%, 60%)" />
                    <Bar dataKey="Actual" fill="hsl(160, 45%, 32%)" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="categories" className="mt-4 space-y-4">
          <div className="flex items-center gap-3">
            <Label className="text-sm">Range</Label>
            <Select value={rangeDays} onValueChange={setRangeDays}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle>Top Categories</CardTitle></CardHeader>
              <CardContent className="h-96">
                {categoryBreakdown.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground">No spending in window.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={categoryBreakdown}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={120}
                      >
                        {categoryBreakdown.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Breakdown</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {categoryBreakdown.map((c, i) => (
                    <div key={c.name} className="flex justify-between items-center pb-3 border-b last:border-0 last:pb-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className="w-3 h-3 rounded-sm flex-shrink-0"
                          style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                        />
                        <span className="text-sm font-medium truncate">{c.name}</span>
                      </div>
                      <span className="text-sm font-medium tabular-nums">{formatCurrency(c.value)}</span>
                    </div>
                  ))}
                  {categoryBreakdown.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No data.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

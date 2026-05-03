import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDebts,
  useCreateDebt,
  useUpdateDebt,
  useDeleteDebt,
  useGetAvalancheSettings,
  useUpdateAvalancheSettings,
  useSyncDebtMinimums,
  useGetAvalancheExtra,
  useCreateDebtPayment,
  useListCategories,
  useGetSettings,
  getListDebtsQueryKey,
  getGetAvalancheSettingsQueryKey,
  getGetAvalancheExtraQueryKey,
} from "@workspace/api-client-react";
import type { Debt } from "@workspace/api-client-react";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  simulate,
  monthsIfMinOnly,
  interestIfMinOnly,
  dailyInterest,
  fmtMoney,
  fmtMoneyCompact,
  fmtMonth,
  fmtPct,
  sortDebts,
  type SimDebt,
  type Strategy,
} from "@/lib/avalanche";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as ReTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Pencil, Trash2, Plus, RefreshCw, Flame, TrendingDown } from "lucide-react";

function debtToSim(d: Debt): SimDebt {
  return {
    id: d.id,
    name: d.name,
    apr: Number(d.apr),
    balance: Number(d.balance),
    minPayment: Number(d.minPayment),
    status: d.status,
  };
}

function aprToneClass(apr: number): string {
  if (apr >= 0.25) return "text-destructive";
  if (apr >= 0.15) return "text-amber-600 dark:text-amber-400";
  if (apr > 0) return "text-emerald-600 dark:text-emerald-400";
  return "text-muted-foreground";
}

export default function AvalanchePage() {
  const { data: debts, isLoading } = useListDebts();
  const { data: settings } = useGetAvalancheSettings();
  const qc = useQueryClient();
  const { toast } = useToast();

  const updateSettings = useUpdateAvalancheSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAvalancheSettingsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAvalancheExtraQueryKey() });
      },
    },
  });
  const { data: resolvedExtra } = useGetAvalancheExtra();
  const { data: categories } = useListCategories();
  const { data: appSettings } = useGetSettings();
  const createPayment = useCreateDebtPayment({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAvalancheExtraQueryKey() });
      },
    },
  });
  const createDebt = useCreateDebt({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getListDebtsQueryKey() }),
    },
  });
  const updateDebt = useUpdateDebt({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getListDebtsQueryKey() }),
    },
  });
  const deleteDebt = useDeleteDebt({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getListDebtsQueryKey() }),
    },
  });
  const syncMinimums = useSyncDebtMinimums({
    mutation: {
      onSuccess: (res) => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        const n = res?.updated?.length ?? 0;
        toast({
          title: n > 0 ? `Synced ${n} debt${n === 1 ? "" : "s"}` : "Already in sync",
          description:
            n > 0
              ? res.updated
                  .slice(0, 3)
                  .map((u) => `${u.name}: $${u.oldMin} → $${u.newMin}`)
                  .join("\n")
              : "No recent payments suggest a different minimum.",
        });
      },
    },
  });

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Debt | null>(null);
  const [drillDown, setDrillDown] = useState<string | null>(null);
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [whatIf, setWhatIf] = useState(0);
  const [paying, setPaying] = useState<Debt | null>(null);

  const strategy: Strategy = (settings?.strategy as Strategy) ?? "avalanche";
  const manualExtra = Number(settings?.manualExtra ?? 0);
  const resolvedExtraAmount = Number(resolvedExtra?.amount ?? manualExtra);
  const totalExtra = resolvedExtraAmount + whatIf;

  const simDebts: SimDebt[] = useMemo(
    () => (debts ?? []).map(debtToSim),
    [debts],
  );

  const sim = useMemo(
    () => simulate({ debts: simDebts, extraPerMonth: totalExtra, strategy }),
    [simDebts, totalExtra, strategy],
  );

  const otherSim = useMemo(
    () =>
      simulate({
        debts: simDebts,
        extraPerMonth: totalExtra,
        strategy: strategy === "avalanche" ? "snowball" : "avalanche",
      }),
    [simDebts, totalExtra, strategy],
  );
  const interestDelta = otherSim.totalInterestPaid - sim.totalInterestPaid;
  const monthsDelta = (otherSim.ranOutOfTime ? 600 : otherSim.monthsToFreedom) - (sim.ranOutOfTime ? 600 : sim.monthsToFreedom);

  // Baseline (no what-if) sim — used for "saves vs baseline" hint
  const baselineSim = useMemo(
    () => simulate({ debts: simDebts, extraPerMonth: resolvedExtraAmount, strategy }),
    [simDebts, resolvedExtraAmount, strategy],
  );
  const whatIfInterestSaved = baselineSim.totalInterestPaid - sim.totalInterestPaid;
  const whatIfMonthsSaved = (baselineSim.ranOutOfTime ? 600 : baselineSim.monthsToFreedom) - (sim.ranOutOfTime ? 600 : sim.monthsToFreedom);

  const activeDebts = simDebts.filter((d) => (d.status ?? "active") === "active");
  const archivedDebts = (debts ?? []).filter((d) => d.status === "archived");
  const totalBalance = activeDebts.reduce((s, d) => s + d.balance, 0);
  const totalMin = activeDebts.reduce((s, d) => s + d.minPayment, 0);
  const sortedActive = useMemo(
    () => sortDebts(activeDebts, strategy),
    [activeDebts, strategy],
  );

  const killById = useMemo(() => {
    const m = new Map<string, { date: Date; monthIndex: number }>();
    for (const k of sim.killedOrder) m.set(k.id, { date: k.date, monthIndex: k.monthIndex });
    return m;
  }, [sim]);

  // Cumulative balance / interest series for the chart
  const chartData = useMemo(() => {
    let cumInt = 0;
    return sim.months.slice(0, 120).map((m) => {
      cumInt += m.totalInterest;
      return {
        month: fmtMonth(m.date),
        balance: Math.round(m.totalBalanceEnd),
        interest: Math.round(cumInt),
      };
    });
  }, [sim]);

  const drillDebt = drillDown ? (debts ?? []).find((d) => d.id === drillDown) : null;
  const drillSchedule = useMemo(() => {
    if (!drillDown) return [];
    return sim.months
      .map((m) => {
        const snap = m.perDebt.find((p) => p.id === drillDown);
        if (!snap || snap.startBalance <= 0) return null;
        return {
          date: m.date,
          startBalance: snap.startBalance,
          interest: snap.interest,
          minPaid: snap.minPaid,
          extraPaid: snap.extraPaid,
          endBalance: snap.endBalance,
          paidOff: snap.paidOffThisMonth,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [sim, drillDown]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const handleSave = async (id: string, patch: Partial<Debt>) => {
    try {
      await updateDebt.mutateAsync({
        id,
        data: patch,
      });
    } catch (e) {
      toast({
        title: "Couldn't save",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground flex items-center gap-2">
            <Flame className="h-7 w-7 text-primary" /> Avalanche
          </h1>
          <p className="text-muted-foreground mt-1">
            Pay the highest interest first. Watch the snowball cascade.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => syncMinimums.mutate()}
            disabled={syncMinimums.isPending}
          >
            <RefreshCw className={`h-4 w-4 ${syncMinimums.isPending ? "animate-spin" : ""}`} />
            Sync minimums
          </Button>
          <Button className="gap-2" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add debt
          </Button>
        </div>
      </div>

      {/* Hero stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total debt" value={fmtMoneyCompact(totalBalance)} />
        <StatCard
          label="Months to free"
          value={sim.ranOutOfTime ? "∞" : String(sim.monthsToFreedom)}
          sub={
            sim.ranOutOfTime
              ? "raise the extra"
              : `${(sim.monthsToFreedom / 12).toFixed(1)} yrs`
          }
        />
        <StatCard
          label="Debt-free date"
          value={sim.debtFreeDate ? fmtMonth(sim.debtFreeDate) : "—"}
        />
        <StatCard
          label="Total interest"
          value={fmtMoneyCompact(sim.totalInterestPaid)}
          sub={`min only: ${fmtMoneyCompact(totalMin * (sim.monthsToFreedom || 0))}`}
        />
      </div>

      {/* Controls */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Strategy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={strategy === "avalanche" ? "default" : "outline"}
                onClick={() => updateSettings.mutate({ data: { strategy: "avalanche" } })}
              >
                Avalanche
                <span className="ml-2 text-xs opacity-70">Highest APR</span>
              </Button>
              <Button
                variant={strategy === "snowball" ? "default" : "outline"}
                onClick={() => updateSettings.mutate({ data: { strategy: "snowball" } })}
              >
                Snowball
                <span className="ml-2 text-xs opacity-70">Smallest balance</span>
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {interestDelta > 0 ? (
                <>
                  <strong className="capitalize">{strategy}</strong> saves{" "}
                  <strong className="text-emerald-600 dark:text-emerald-400">
                    {fmtMoney(interestDelta)}
                  </strong>
                  {monthsDelta > 0 ? (
                    <> and <strong>{monthsDelta} mo</strong></>
                  ) : null}{" "}
                  vs <strong>{strategy === "avalanche" ? "snowball" : "avalanche"}</strong> with your current extra source ({fmtMoney(resolvedExtraAmount)}/mo).
                </>
              ) : interestDelta < 0 ? (
                <>
                  Switching to{" "}
                  <strong>{strategy === "avalanche" ? "snowball" : "avalanche"}</strong>{" "}
                  would save{" "}
                  <strong className="text-emerald-600 dark:text-emerald-400">
                    {fmtMoney(-interestDelta)}
                  </strong>
                  {monthsDelta < 0 ? <> and <strong>{-monthsDelta} mo</strong></> : null}
                  {" "}with your current extra source ({fmtMoney(resolvedExtraAmount)}/mo).
                </>
              ) : (
                <>Both strategies cost the same with {fmtMoney(resolvedExtraAmount)}/mo extra.</>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span>Extra per month</span>
              <span className="tabular-nums text-primary">
                {fmtMoney(resolvedExtraAmount)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Source</Label>
              <Select
                value={settings?.extraSource ?? "manual"}
                onValueChange={(v) =>
                  updateSettings.mutate({
                    data: { extraSource: v as "budget_net" | "budget_line" | "manual" },
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual amount</SelectItem>
                  <SelectItem value="budget_net">Budget net</SelectItem>
                  <SelectItem value="budget_line">Specific budget line</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {settings?.extraSource === "manual" && (
              <div>
                <Label className="text-xs">Manual amount ($/mo)</Label>
                <Input
                  type="number"
                  step="25"
                  min="0"
                  value={manualExtra}
                  onChange={(e) =>
                    updateSettings.mutate({ data: { manualExtra: e.target.value || "0" } })
                  }
                />
              </div>
            )}
            {settings?.extraSource === "budget_line" && (
              <div>
                <Label className="text-xs">Budget category</Label>
                <Select
                  value={settings?.extraBudgetCategoryId ?? ""}
                  onValueChange={(v) =>
                    updateSettings.mutate({
                      data: { extraBudgetCategoryId: v || null },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {(categories ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="text-xs text-muted-foreground mt-1">
                  Uses planned amount of "
                  {resolvedExtra?.breakdown?.categoryName ?? "—"}" for{" "}
                  {resolvedExtra?.monthStart?.slice(0, 7) ?? "this month"}.
                </div>
              </div>
            )}
            {settings?.extraSource === "budget_net" && (
              <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground space-y-0.5">
                <div className="flex justify-between">
                  <span>Planned income</span>
                  <span className="tabular-nums text-foreground">
                    {fmtMoney(Number(resolvedExtra?.breakdown?.income ?? 0))}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>− Planned expenses</span>
                  <span className="tabular-nums text-foreground">
                    {fmtMoney(Number(resolvedExtra?.breakdown?.expenses ?? 0))}
                  </span>
                </div>
                <div className="flex justify-between border-t pt-1 mt-1">
                  <span>Net surplus</span>
                  <span className="tabular-nums font-medium text-primary">
                    {fmtMoney(resolvedExtraAmount)}
                  </span>
                </div>
              </div>
            )}
            <div>
              <Label className="text-xs">Mode</Label>
              <Select
                value={settings?.budgetMode ?? "budgeted"}
                onValueChange={(v) =>
                  updateSettings.mutate({ data: { budgetMode: v as "budgeted" | "actual" } })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="budgeted">Budgeted (plan)</SelectItem>
                  <SelectItem value="actual">Actual (transactions)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs: debts table + projection */}
      <Tabs defaultValue="debts">
        <TabsList>
          <TabsTrigger value="debts">Debts ({activeDebts.length})</TabsTrigger>
          <TabsTrigger value="projection">Projection</TabsTrigger>
          <TabsTrigger value="chart">Chart</TabsTrigger>
          {archivedDebts.length > 0 && (
            <TabsTrigger value="archived">Archived ({archivedDebts.length})</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="debts" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Creditor</th>
                    <th className="text-left px-3 py-2">Type</th>
                    <th className="text-right px-3 py-2">APR</th>
                    <th className="text-right px-3 py-2">Balance</th>
                    <th className="text-right px-3 py-2">Min</th>
                    <th className="text-left px-3 py-2">Due</th>
                    <th className="text-right px-3 py-2">Payoff</th>
                    <th className="text-right px-3 py-2">Daily $</th>
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedActive.length === 0 && (
                    <tr>
                      <td colSpan={10} className="text-center py-8 text-muted-foreground">
                        No active debts. Add one to get started.
                      </td>
                    </tr>
                  )}
                  {sortedActive.map((d, i) => {
                    const dbt = (debts ?? []).find((x) => x.id === d.id)!;
                    const k = killById.get(d.id);
                    const isTarget = i === 0;
                    const dueChip = renderDueChip(dbt.dueDay ?? null);
                    return (
                      <tr
                        key={d.id}
                        className={`border-t hover:bg-muted/30 cursor-pointer ${
                          isTarget ? "bg-primary/5" : ""
                        }`}
                        onClick={() => setDrillDown(d.id)}
                      >
                        <td className="px-3 py-2 font-medium">
                          {isTarget && (
                            <Badge className="mr-2" variant="default">
                              Target
                            </Badge>
                          )}
                          {d.name}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{dbt.type ?? "—"}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${aprToneClass(d.apr)}`}
                        >
                          {fmtPct(d.apr)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtMoney(d.balance)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtMoney(d.minPayment)}
                        </td>
                        <td className="px-3 py-2">{dueChip}</td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {k ? fmtMonth(k.date) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                          {fmtMoney(dailyInterest(d))}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPaying(dbt);
                            }}
                          >
                            Pay
                          </Button>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditing(dbt);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {sortedActive.length > 0 && (
                  <tfoot>
                    <tr className="border-t bg-muted/40 font-semibold">
                      <td className="px-3 py-2" colSpan={3}>
                        Totals
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtMoney(totalBalance)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtMoney(totalMin)}
                      </td>
                      <td colSpan={5}></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="projection" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between gap-3">
                <span>What-if extra</span>
                <span className="tabular-nums text-sm font-normal">
                  +{fmtMoney(whatIf)} / mo
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Slider
                min={0}
                max={2000}
                step={25}
                value={[whatIf]}
                onValueChange={([v]) => setWhatIf(v ?? 0)}
              />
              <div className="text-xs text-muted-foreground">
                {whatIf > 0 && whatIfInterestSaved > 0 ? (
                  <>
                    Adding {fmtMoney(whatIf)}/mo saves{" "}
                    <strong className="text-emerald-600 dark:text-emerald-400">
                      {fmtMoney(whatIfInterestSaved)}
                    </strong>
                    {whatIfMonthsSaved > 0 ? (
                      <> and <strong>{whatIfMonthsSaved} mo</strong></>
                    ) : null}
                    {" "}vs your baseline ({fmtMoney(resolvedExtraAmount)}/mo).
                  </>
                ) : (
                  <>Drag to see how much sooner you'd be debt-free.</>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Month</th>
                    <th className="text-left px-3 py-2">Target</th>
                    <th className="text-right px-3 py-2">Interest</th>
                    <th className="text-right px-3 py-2">Mins</th>
                    <th className="text-right px-3 py-2">Extra</th>
                    <th className="text-right px-3 py-2">Balance end</th>
                    <th className="text-left px-3 py-2">Killed</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllMonths ? sim.months : sim.months.slice(0, 24)).map((m) => (
                    <tr key={m.monthIndex} className="border-t">
                      <td className="px-3 py-2">{fmtMonth(m.date)}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {m.activeTargetName ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtMoney(m.totalInterest)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtMoney(m.totalMinsPaid)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtMoney(m.totalExtraPaid)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtMoney(m.totalBalanceEnd)}
                      </td>
                      <td className="px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                        {m.killedThisMonth.map((k) => k.name).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sim.months.length > 24 && (
                <div className="p-3 border-t text-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllMonths((s) => !s)}
                  >
                    {showAllMonths ? "Show first 24 months" : `Show all ${sim.months.length} months`}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chart" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingDown className="h-4 w-4" /> Cumulative balance vs interest
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <ReTooltip
                      formatter={(v: number) =>
                        v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
                      }
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="balance"
                      name="Remaining balance"
                      stroke="hsl(160, 45%, 22%)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="interest"
                      name="Cumulative interest"
                      stroke="hsl(0, 65%, 50%)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {archivedDebts.length > 0 && (
          <TabsContent value="archived" className="mt-4">
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <tbody>
                    {archivedDebts.map((d) => (
                      <tr key={d.id} className="border-t">
                        <td className="px-3 py-2">{d.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtMoney(Number(d.balance))}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              handleSave(d.id, { status: "active" })
                            }
                          >
                            Restore
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Add dialog */}
      <DebtDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add debt"
        onSubmit={async (data) => {
          await createDebt.mutateAsync({ data });
          setAddOpen(false);
          toast({ title: "Debt added" });
        }}
      />

      {/* Edit dialog */}
      <DebtDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={`Edit ${editing?.name ?? "debt"}`}
        initial={editing ?? undefined}
        onArchive={
          editing
            ? async () => {
                await handleSave(editing.id, { status: "archived" });
                setEditing(null);
                toast({ title: "Archived" });
              }
            : undefined
        }
        onDelete={
          editing
            ? async () => {
                if (!confirm(`Delete "${editing.name}"? This can't be undone.`)) return;
                await deleteDebt.mutateAsync({ id: editing.id });
                setEditing(null);
                toast({ title: "Debt deleted" });
              }
            : undefined
        }
        onSubmit={async (data) => {
          if (!editing) return;
          await updateDebt.mutateAsync({ id: editing.id, data });
          setEditing(null);
          toast({ title: "Saved" });
        }}
      />

      {/* Pay dialog */}
      <PayDialog
        open={!!paying}
        onOpenChange={(o) => !o && setPaying(null)}
        debt={paying}
        isTarget={paying ? sortedActive[0]?.id === paying.id : false}
        suggestedExtra={totalExtra}
        defaultAccount={appSettings?.primaryAccount ?? ""}
        submitting={createPayment.isPending}
        onSubmit={async (data) => {
          if (!paying) return;
          try {
            await createPayment.mutateAsync({ id: paying.id, data });
            toast({ title: "Payment recorded" });
            setPaying(null);
          } catch (e) {
            toast({
              title: "Couldn't record payment",
              description: (e as Error).message,
              variant: "destructive",
            });
          }
        }}
      />

      {/* Drill-down dialog */}
      <Dialog open={!!drillDown} onOpenChange={(o) => !o && setDrillDown(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {drillDebt?.name} — payoff schedule
            </DialogTitle>
          </DialogHeader>
          {drillDebt && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-3 text-sm pb-2 border-b">
                <div>
                  <div className="text-xs text-muted-foreground">If min only</div>
                  <div className="font-medium tabular-nums">
                    {(() => {
                      const m = monthsIfMinOnly(debtToSim(drillDebt));
                      return m === null ? "Never (min < interest)" : `${m} mo`;
                    })()}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Min-only interest</div>
                  <div className="font-medium tabular-nums text-destructive">
                    {(() => {
                      const i = interestIfMinOnly(debtToSim(drillDebt));
                      return i === null ? "—" : fmtMoney(i);
                    })()}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Daily interest</div>
                  <div className="font-medium tabular-nums">
                    {fmtMoney(dailyInterest(debtToSim(drillDebt)))}
                  </div>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left py-1">Month</th>
                    <th className="text-right py-1">Start</th>
                    <th className="text-right py-1">Interest</th>
                    <th className="text-right py-1">Min</th>
                    <th className="text-right py-1">Extra</th>
                    <th className="text-right py-1">End</th>
                  </tr>
                </thead>
                <tbody>
                  {drillSchedule.map((r, i) => (
                    <tr
                      key={i}
                      className={`border-t ${r.paidOff ? "bg-emerald-50 dark:bg-emerald-950/30 font-medium" : ""}`}
                    >
                      <td className="py-1">{fmtMonth(r.date)}</td>
                      <td className="text-right tabular-nums py-1">
                        {fmtMoney(r.startBalance)}
                      </td>
                      <td className="text-right tabular-nums py-1 text-destructive">
                        {fmtMoney(r.interest)}
                      </td>
                      <td className="text-right tabular-nums py-1">{fmtMoney(r.minPaid)}</td>
                      <td className="text-right tabular-nums py-1">{fmtMoney(r.extraPaid)}</td>
                      <td className="text-right tabular-nums py-1">
                        {r.paidOff ? "🎉 0" : fmtMoney(r.endBalance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function DebtDialog({
  open,
  onOpenChange,
  title,
  initial,
  onSubmit,
  onArchive,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  initial?: Debt;
  onSubmit: (data: {
    name: string;
    apr: string;
    balance: string;
    minPayment: string;
    type?: string | null;
    dueDay?: number | null;
    notes?: string | null;
    status?: string;
  }) => Promise<void>;
  onArchive?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [aprPct, setAprPct] = useState(
    initial ? (Number(initial.apr) * 100).toString() : "0",
  );
  const [balance, setBalance] = useState(initial?.balance ?? "0");
  const [minPayment, setMinPayment] = useState(initial?.minPayment ?? "0");
  const [type, setType] = useState(initial?.type ?? "");
  const [dueDay, setDueDay] = useState(initial?.dueDay?.toString() ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);

  // Reset on open
  useMemo(() => {
    if (open && initial) {
      setName(initial.name);
      setAprPct((Number(initial.apr) * 100).toString());
      setBalance(initial.balance);
      setMinPayment(initial.minPayment);
      setType(initial.type ?? "");
      setDueDay(initial.dueDay?.toString() ?? "");
      setNotes(initial.notes ?? "");
    } else if (open && !initial) {
      setName("");
      setAprPct("0");
      setBalance("0");
      setMinPayment("0");
      setType("");
      setDueDay("");
      setNotes("");
    }
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Creditor</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">APR (%)</Label>
              <Input
                type="number"
                step="0.01"
                value={aprPct}
                onChange={(e) => setAprPct(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Input
                value={type}
                placeholder="card, loan, …"
                onChange={(e) => setType(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Balance ($)</Label>
              <Input
                type="number"
                step="0.01"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Min payment ($)</Label>
              <Input
                type="number"
                step="0.01"
                value={minPayment}
                onChange={(e) => setMinPayment(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Due day (1-31)</Label>
            <Input
              type="number"
              min="1"
              max="31"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {onArchive && (
              <Button variant="outline" size="sm" onClick={onArchive}>
                Archive
              </Button>
            )}
            {onDelete && (
              <Button variant="ghost" size="sm" onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name || submitting}
              onClick={async () => {
                setSubmitting(true);
                try {
                  const aprNum = Number(aprPct) / 100;
                  await onSubmit({
                    name: name.trim(),
                    apr: aprNum.toFixed(4),
                    balance: Number(balance || 0).toFixed(2),
                    minPayment: Number(minPayment || 0).toFixed(2),
                    type: type.trim() || null,
                    dueDay: dueDay ? Number(dueDay) : null,
                    notes: notes.trim() || null,
                  });
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function daysUntilDue(dueDay: number | null): number | null {
  if (!dueDay || dueDay < 1 || dueDay > 31) return null;
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const lastDayThisMonth = new Date(y, m + 1, 0).getDate();
  const lastDayNextMonth = new Date(y, m + 2, 0).getDate();
  const todayD = today.getDate();
  let target: Date;
  if (dueDay >= todayD) {
    target = new Date(y, m, Math.min(dueDay, lastDayThisMonth));
  } else {
    target = new Date(y, m + 1, Math.min(dueDay, lastDayNextMonth));
  }
  const ms = target.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}

function renderDueChip(dueDay: number | null) {
  const days = daysUntilDue(dueDay);
  if (days === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  let cls = "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (days <= 2) cls = "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  else if (days <= 6) cls = "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  const label = days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days}d`;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function PayDialog({
  open,
  onOpenChange,
  debt,
  isTarget,
  suggestedExtra,
  defaultAccount,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  debt: Debt | null;
  isTarget: boolean;
  suggestedExtra: number;
  defaultAccount: string;
  submitting: boolean;
  onSubmit: (data: {
    amount: string;
    occurredOn: string;
    account?: string | null;
    notes?: string | null;
  }) => Promise<void>;
}) {
  const min = debt ? Number(debt.minPayment) : 0;
  const recommendedTopUp = isTarget ? suggestedExtra : 0;
  const [payExtra, setPayExtra] = useState(false);
  const [amount, setAmount] = useState((min + (isTarget ? suggestedExtra : 0)).toFixed(2));
  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [account, setAccount] = useState(defaultAccount);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open && debt) {
      const m = Number(debt.minPayment);
      setPayExtra(false);
      setAmount(m.toFixed(2));
      setOccurredOn(new Date().toISOString().slice(0, 10));
      setAccount(defaultAccount);
      setNotes("");
    }
  }, [open, debt, defaultAccount]);

  const togglePayExtra = (next: boolean) => {
    setPayExtra(next);
    setAmount(((next ? min + recommendedTopUp : min) || 0).toFixed(2));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pay {debt?.name ?? "debt"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 p-2 text-xs space-y-0.5">
            <div className="flex justify-between">
              <span>Current balance</span>
              <span className="tabular-nums">
                {debt ? fmtMoney(Number(debt.balance)) : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Minimum</span>
              <span className="tabular-nums">{fmtMoney(min)}</span>
            </div>
            {isTarget && recommendedTopUp > 0 && (
              <div className="flex justify-between text-primary">
                <span>Avalanche top-up</span>
                <span className="tabular-nums">+{fmtMoney(recommendedTopUp)}</span>
              </div>
            )}
          </div>
          {isTarget && recommendedTopUp > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={payExtra}
                onChange={(e) => togglePayExtra(e.target.checked)}
              />
              Pay extra ({fmtMoney(min + recommendedTopUp)})
            </label>
          )}
          <div>
            <Label className="text-xs">Amount ($)</Label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Date</Label>
              <Input
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Account</Label>
              <Input
                value={account}
                placeholder="e.g. Checking"
                onChange={(e) => setAccount(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={submitting || !amount || Number(amount) <= 0}
            onClick={() =>
              onSubmit({
                amount: Number(amount).toFixed(2),
                occurredOn,
                account: account.trim() || null,
                notes: notes.trim() || null,
              })
            }
          >
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

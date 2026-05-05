import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  simulate,
  simulateWithSolvableFallback,
  simulateMinimumsOnly,
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
import { Pencil, Trash2, Plus, RefreshCw, Flame, TrendingDown, PartyPopper, X, ClipboardPaste, Sparkles } from "lucide-react";
import {
  DebtPlaidActions,
  DebtPlaidIndicator,
  DebtLastSynced,
  DebtPlaidSource,
  DebtReauthBanner,
} from "@/components/debt-plaid-link";

const MANUAL_EXTRA_CAP = 5000;
const MAX_DISPLAY_INTEREST = 1_000_000;
const MAX_UNDERWATER_VISIBLE = 5;

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

function PayoffRing({
  originalBalance,
  balance,
}: {
  originalBalance: number | null;
  balance: number;
}) {
  const orig = originalBalance != null && Number.isFinite(originalBalance) && originalBalance > 0
    ? originalBalance
    : 0;
  const paid = orig > 0 ? Math.max(0, Math.min(orig, orig - balance)) : 0;
  const pct = orig > 0 ? (paid / orig) * 100 : 0;
  const size = 22;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const tip =
    orig > 0
      ? `${Math.round(pct)}% paid down — ${fmtMoney(paid)} of ${fmtMoney(orig)} (now ${fmtMoney(balance)})`
      : `No original balance recorded yet — current ${fmtMoney(balance)}`;
  return (
    <span
      className="inline-flex items-center"
      title={tip}
      aria-label={tip}
      data-testid="payoff-ring"
    >
      <svg width={size} height={size} className="shrink-0">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-muted/40"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="text-emerald-500 dark:text-emerald-400"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </span>
  );
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
  const [highlightedDebtId, setHighlightedDebtId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement | null>>(new Map());
  const [killedBanner, setKilledBanner] = useState<{ id: string; name: string } | null>(null);

  const search = useSearch();
  const focusDebtId = useMemo(() => {
    const params = new URLSearchParams(search);
    return params.get("focus");
  }, [search]);
  const initialTab = useMemo(() => {
    const params = new URLSearchParams(search);
    const t = params.get("tab");
    if (t === "debts" || t === "projection" || t === "chart" || t === "archived") return t;
    return "debts";
  }, [search]);
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!focusDebtId || isLoading) return;
    setActiveTab("debts");
    const tryScroll = () => {
      const row = rowRefs.current.get(focusDebtId);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightedDebtId(focusDebtId);
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      const t = setTimeout(tryScroll, 80);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [focusDebtId, isLoading]);

  useEffect(() => {
    if (!highlightedDebtId) return;
    const t = setTimeout(() => setHighlightedDebtId(null), 2200);
    return () => clearTimeout(t);
  }, [highlightedDebtId]);

  const strategy: Strategy = (settings?.strategy as Strategy) ?? "avalanche";
  const clampManual = (n: number) =>
    Number.isFinite(n) ? Math.max(0, Math.min(MANUAL_EXTRA_CAP, n)) : 0;
  const rawManualExtra = Number(settings?.manualExtra ?? 0);
  const manualExtra = clampManual(rawManualExtra);
  const rawResolvedExtraAmount = Number(resolvedExtra?.amount ?? manualExtra);
  // When the source is manual, the API echoes the raw saved manualExtra back
  // as `resolvedExtra.amount`. Clamp it here too so a stale > $5k value can't
  // drive the headline or the simulation past the cap.
  const isManualSource =
    (resolvedExtra?.source ?? settings?.extraSource ?? "manual") === "manual";
  const resolvedExtraAmount = isManualSource
    ? clampManual(rawResolvedExtraAmount)
    : Number.isFinite(rawResolvedExtraAmount)
      ? Math.max(0, rawResolvedExtraAmount)
      : 0;
  const totalExtra = resolvedExtraAmount + whatIf;

  const simDebts: SimDebt[] = useMemo(
    () => (debts ?? []).map(debtToSim),
    [debts],
  );

  const fallback = useMemo(
    () =>
      simulateWithSolvableFallback({
        debts: simDebts,
        extraPerMonth: totalExtra,
        strategy,
      }),
    [simDebts, totalExtra, strategy],
  );
  const sim = fallback.sim;
  const usingSolvableSubset = fallback.usingSolvableSubset;
  const excludedUnderwaterCount = fallback.excludedUnderwaterCount;
  const effectiveDebts = fallback.effectiveDebts;

  const minOnlyBaseline = useMemo(
    () =>
      simulateMinimumsOnly({
        debts: simDebts,
        strategy,
      }),
    [simDebts, strategy],
  );
  const minOnlyForever = minOnlyBaseline.ranOutOfTime;

  const otherSim = useMemo(
    () =>
      simulate({
        debts: effectiveDebts,
        extraPerMonth: totalExtra,
        strategy: strategy === "avalanche" ? "snowball" : "avalanche",
      }),
    [effectiveDebts, totalExtra, strategy],
  );
  const bothInfinite = sim.ranOutOfTime && otherSim.ranOutOfTime;
  const interestDelta = otherSim.totalInterestPaid - sim.totalInterestPaid;
  const monthsDelta = (otherSim.ranOutOfTime ? 600 : otherSim.monthsToFreedom) - (sim.ranOutOfTime ? 600 : sim.monthsToFreedom);

  // Null when minimums-only never finishes — the UI renders that case
  // explicitly rather than displaying an unbounded "savings" number.
  const interestSavedVsMin = minOnlyForever
    ? null
    : Math.max(0, minOnlyBaseline.totalInterestPaid - sim.totalInterestPaid);
  const monthsSavedVsMin = minOnlyForever
    ? null
    : Math.max(
        0,
        minOnlyBaseline.monthsToFreedom -
          (sim.ranOutOfTime ? 600 : sim.monthsToFreedom),
      );

  const whatIfBaselineSim = useMemo(
    () =>
      simulate({
        debts: effectiveDebts,
        extraPerMonth: resolvedExtraAmount,
        strategy,
      }),
    [effectiveDebts, resolvedExtraAmount, strategy],
  );
  const whatIfInterestSaved = Math.max(
    0,
    whatIfBaselineSim.totalInterestPaid - sim.totalInterestPaid,
  );
  const whatIfMonthsSaved = Math.max(
    0,
    (whatIfBaselineSim.ranOutOfTime ? 600 : whatIfBaselineSim.monthsToFreedom) -
      (sim.ranOutOfTime ? 600 : sim.monthsToFreedom),
  );

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

  // Drive next-3 from the sim's payoff cascade so underwater debts (no
  // real payoff date) aren't promoted to card #1.
  const next3 = useMemo(() => {
    if (sim.killedOrder.length > 0) {
      return sim.killedOrder
        .slice(0, 3)
        .map((k) => activeDebts.find((d) => d.id === k.id))
        .filter((d): d is NonNullable<typeof d> => Boolean(d));
    }
    return sortedActive.slice(0, 3);
  }, [sim.killedOrder, activeDebts, sortedActive]);

  // Every debt the sim is throwing extra at this month, in cascade order
  // (the first one is the primary target; subsequent entries appear when
  // extra is large enough to wipe out earlier debts and spill over). With
  // $0 extra this month, falls back to a single strategy-sorted debt so
  // the UI always shows a "next target."
  const planTargets = useMemo(() => {
    const monthTargets = sim.months[0]?.targets ?? [];
    if (monthTargets.length > 0) {
      return monthTargets
        .map((t) => {
          const d = activeDebts.find((x) => x.id === t.id);
          if (!d) return null;
          return {
            ...d,
            extraForTarget: t.extraPaid,
            killedThisMonth: t.killedThisMonth,
          };
        })
        .filter((d): d is NonNullable<typeof d> => Boolean(d));
    }
    const sortedSolvable = sortDebts(
      effectiveDebts.filter((d) => d.balance > 0),
      strategy,
    );
    const fallback = sortedSolvable[0] ?? sortedActive[0] ?? null;
    if (!fallback) return [];
    return [{ ...fallback, extraForTarget: 0, killedThisMonth: false }];
  }, [sim.months, activeDebts, effectiveDebts, sortedActive, strategy]);

  const planTargetIds = useMemo(
    () => new Set(planTargets.map((d) => d.id)),
    [planTargets],
  );

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

  // Slider is hard-capped at $5k/mo regardless of budget headroom — keeps the
  // control useful for real-life planning. `manualExtra` is already clamped on
  // read above, so the slider value is guaranteed to be within range.
  const availableMoney = Number(resolvedExtra?.availableMoney ?? 0);
  const budgetCap = MANUAL_EXTRA_CAP;
  const roomLeft = availableMoney - manualExtra;
  const overBudget = roomLeft < 0;

  // Progress: paid-down vs the per-debt `originalBalance` anchor captured
  // at create / first Plaid sync (and backfilled for older debts from the
  // peak of recorded balance history). Falls back to current balance when
  // no anchor exists, which produces 0% rather than NaN.
  const activeRawDebts = (debts ?? []).filter(
    (d) => (d.status ?? "active") === "active",
  );
  const originalTotal = activeRawDebts.reduce((s, d) => {
    const orig = d.originalBalance != null ? Number(d.originalBalance) : Number(d.balance);
    return s + (Number.isFinite(orig) ? orig : 0);
  }, 0);
  const paidDown = Math.max(0, originalTotal - totalBalance);
  const progressPct = originalTotal > 0 ? (paidDown / originalTotal) * 100 : 0;

  const budgetMode = (settings?.budgetMode ?? "budgeted") as "budgeted" | "actual";

  return (
    <div className="space-y-6">
      <DebtReauthBanner debts={debts} />
      {killedBanner && (
        <div className="relative flex items-center gap-3 rounded-lg border border-emerald-300/60 bg-gradient-to-r from-emerald-50 to-amber-50 p-4 text-emerald-900 dark:border-emerald-700/60 dark:from-emerald-950/40 dark:to-amber-950/40 dark:text-emerald-100 animate-in fade-in slide-in-from-top-2">
          <PartyPopper className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="flex-1">
            <div className="font-semibold">Debt killed! 🎉</div>
            <div className="text-sm opacity-90">
              <strong>{killedBanner.name}</strong> is paid in full and moved to
              Archived. Onto the next one.
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setKilledBanner(null)}
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {/* Editorial header */}
      <div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Section II
            </div>
            <h1 className="text-5xl font-serif font-bold text-foreground mt-1 leading-none">
              Avalanche
            </h1>
            <p className="text-muted-foreground mt-2 italic">
              Pay the highest interest first. Watch the snowball cascade.
            </p>
          </div>
          <div className="flex gap-2 mt-2">
            <Button
              variant="outline"
              className="gap-2 rounded-full"
              onClick={() => syncMinimums.mutate()}
              disabled={syncMinimums.isPending}
              title="Sync minimums from recent payments"
            >
              <RefreshCw className={`h-4 w-4 ${syncMinimums.isPending ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Sync minimums</span>
            </Button>
            <Button
              variant="outline"
              className="gap-2 rounded-full"
              onClick={() => setAddOpen(true)}
            >
              <ClipboardPaste className="h-4 w-4" />
              Paste debts
            </Button>
            <Button
              className="gap-2 rounded-full bg-foreground text-background hover:bg-foreground/90"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-4 w-4" /> Add debt
            </Button>
          </div>
        </div>
        <div className="border-t border-border mt-5" />
      </div>

      {/* Stat strip + underwater + progress — kept tight so the top of the
          page reads as one connected section instead of disjoint slabs. */}
      <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4">
        <StatStripCell label="Total debt" value={fmtMoneyCompact(totalBalance)} />
        <StatStripCell
          label="Months to free"
          value={sim.ranOutOfTime ? "∞" : String(sim.monthsToFreedom)}
          sub={
            sim.ranOutOfTime
              ? sim.underwater.length > 0
                ? `${sim.underwater[0]!.name} interest > minimum`
                : "raise the extra"
              : excludedUnderwaterCount > 0
                ? `excludes ${excludedUnderwaterCount} underwater debt${excludedUnderwaterCount === 1 ? "" : "s"}`
                : `${(sim.monthsToFreedom / 12).toFixed(1)} yrs`
          }
          valueClassName={sim.ranOutOfTime ? "text-destructive" : undefined}
        />
        <StatStripCell
          label="Debt-free date"
          value={sim.debtFreeDate ? fmtMonth(sim.debtFreeDate) : "—"}
        />
        <StatStripCell
          label="Total interest"
          value={sim.ranOutOfTime ? "∞" : fmtMoneyCompact(sim.totalInterestPaid)}
          valueClassName="text-destructive"
        />
      </div>
      {sim.underwater.length > 0 && (() => {
        const sanitized = sim.underwater.map((u) => {
          const interestOk =
            Number.isFinite(u.monthlyInterest) &&
            u.monthlyInterest >= 0 &&
            u.monthlyInterest <= MAX_DISPLAY_INTEREST;
          const minOk = Number.isFinite(u.minPayment) && u.minPayment > 0;
          let coverage: number | null = null;
          if (interestOk && minOk && u.monthlyInterest > 0) {
            coverage = Math.max(
              0,
              Math.min(100, (u.minPayment / u.monthlyInterest) * 100),
            );
          }
          const aprLooksWrong =
            !interestOk ||
            !Number.isFinite(u.apr) ||
            u.apr < 0 ||
            u.apr >= 1;
          return { ...u, interestOk, minOk, coverage, aprLooksWrong };
        });
        const sorted = [...sanitized].sort((a, b) => {
          const ax = a.coverage ?? -1;
          const bx = b.coverage ?? -1;
          return ax - bx;
        });
        const visible = sorted.slice(0, MAX_UNDERWATER_VISIBLE);
        const moreCount = sorted.length - visible.length;
        return (
          <div
            className="rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-100"
            data-testid="banner-underwater"
          >
            <div className="font-medium">
              {sorted.length === 1
                ? "1 debt is underwater"
                : `${sorted.length} debts are underwater`}{" "}
              <span className="font-normal text-amber-900/80 dark:text-amber-100/80">
                — the minimum payment isn't keeping up with monthly interest, so
                the balance keeps growing. Add a little extra to start chipping
                away at it.
              </span>
            </div>
            <ul className="mt-1.5 space-y-0.5 text-[13px] leading-snug text-amber-900/90 dark:text-amber-100/90">
              {visible.map((u) => {
                const minLabel = u.minOk ? fmtMoney(u.minPayment) : "—";
                const coverageLabel =
                  u.coverage !== null ? `~${Math.round(u.coverage)}%` : "—";
                const debtRow = (debts ?? []).find((x) => x.id === u.id);
                return (
                  <li key={u.id} className="flex items-baseline gap-1.5">
                    <span className="font-medium text-amber-950 dark:text-amber-50">{u.name}</span>
                    {u.aprLooksWrong ? (
                      <span className="text-amber-900/80 dark:text-amber-100/80">
                        APR looks wrong —{" "}
                        {debtRow ? (
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-50"
                            onClick={() => setEditing(debtRow)}
                          >
                            check this debt
                          </button>
                        ) : (
                          "check this debt"
                        )}
                      </span>
                    ) : (
                      <span className="text-amber-900/80 dark:text-amber-100/80">
                        min {minLabel} covers {coverageLabel} of interest
                      </span>
                    )}
                  </li>
                );
              })}
              {moreCount > 0 && (
                <li className="text-amber-900/70 dark:text-amber-100/70">+{moreCount} more</li>
              )}
            </ul>
          </div>
        );
      })()}

      {/* Progress row */}
      <div>
        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-muted-foreground mb-2">
          <span>Progress</span>
          <span className="tabular-nums">{progressPct.toFixed(1)}%</span>
        </div>
        <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-foreground rounded-full transition-all"
            style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
          />
        </div>
      </div>
      </div>

      {/* This month — full plan amount + target debt(s) + projected kill date. */}
      {(() => {
        if (planTargets.length === 0) return null;
        const allMins = activeDebts.reduce((s, d) => s + d.minPayment, 0);
        const planTotal = allMins + totalExtra;
        const isMulti = planTargets.length > 1;
        const primary = planTargets[0]!;
        const primaryDebt = (debts ?? []).find((x) => x.id === primary.id);
        return (
          <Card
            className="rounded-2xl border-primary/40 bg-primary/[0.03]"
            data-testid="panel-this-month"
          >
            <CardContent className="p-5 flex flex-col md:flex-row md:items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  This month
                </div>
                {isMulti ? (
                  <>
                    <div className="mt-1 text-lg">
                      Pay{" "}
                      <span className="font-semibold tabular-nums">
                        {fmtMoney(planTotal)}
                      </span>{" "}
                      total —{" "}
                      <span className="tabular-nums">{fmtMoney(allMins)}</span>{" "}
                      in minimums on every debt plus{" "}
                      <span className="tabular-nums">
                        {fmtMoney(totalExtra)}
                      </span>{" "}
                      extra split across{" "}
                      <span className="font-semibold">
                        {planTargets.length} debts
                      </span>
                    </div>
                    <ul
                      className="mt-2 space-y-1 text-xs text-muted-foreground"
                      data-testid="this-month-targets"
                    >
                      {planTargets.map((t) => {
                        const killDate =
                          sim.killedOrder.find((k) => k.id === t.id)?.date ??
                          null;
                        return (
                          <li
                            key={t.id}
                            data-testid={`this-month-target-${t.id}`}
                            className="flex items-baseline gap-1.5"
                          >
                            <span className="font-medium text-foreground">
                              {t.name}
                            </span>
                            <span>
                              gets{" "}
                              <span className="tabular-nums text-foreground">
                                {fmtMoney(t.minPayment + t.extraForTarget)}
                              </span>{" "}
                              ({fmtMoney(t.minPayment)} min +{" "}
                              {fmtMoney(t.extraForTarget)} extra)
                            </span>
                            {t.killedThisMonth ? (
                              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                                · killed this month
                              </span>
                            ) : killDate ? (
                              <span>
                                · projected kill{" "}
                                <span className="tabular-nums text-foreground">
                                  {fmtMonth(killDate)}
                                </span>
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : (
                  (() => {
                    const target = primary;
                    const targetPayment = target.minPayment + totalExtra;
                    const dailyCost = dailyInterest(target);
                    const killDate =
                      sim.killedOrder.find((k) => k.id === target.id)?.date ??
                      null;
                    return (
                      <>
                        <div className="mt-1 text-lg">
                          Pay{" "}
                          <span className="font-semibold tabular-nums">
                            {fmtMoney(planTotal)}
                          </span>{" "}
                          total —{" "}
                          <span className="tabular-nums">
                            {fmtMoney(allMins)}
                          </span>{" "}
                          in minimums on every debt plus{" "}
                          <span className="tabular-nums">
                            {fmtMoney(totalExtra)}
                          </span>{" "}
                          extra onto{" "}
                          <span className="font-semibold">{target.name}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          Target gets{" "}
                          <span className="tabular-nums text-foreground">
                            {fmtMoney(targetPayment)}
                          </span>{" "}
                          · costs{" "}
                          <span className="tabular-nums text-foreground">
                            {fmtMoney(dailyCost)}
                          </span>
                          /day in interest right now
                          {killDate && (
                            <>
                              {" "}· projected kill{" "}
                              <span className="tabular-nums text-foreground">
                                {fmtMonth(killDate)}
                              </span>
                            </>
                          )}
                        </div>
                      </>
                    );
                  })()
                )}
              </div>
              {isMulti ? (
                <div
                  className="flex flex-col gap-2 md:items-end"
                  data-testid="this-month-pay-buttons"
                >
                  {planTargets.map((t) => {
                    const dbt = (debts ?? []).find((x) => x.id === t.id);
                    if (!dbt) return null;
                    return (
                      <Button
                        key={t.id}
                        className="rounded-full"
                        data-testid={`btn-pay-target-${t.id}`}
                        variant={t.id === primary.id ? "default" : "outline"}
                        onClick={() => setPaying(dbt)}
                      >
                        Pay {t.name}
                      </Button>
                    );
                  })}
                </div>
              ) : (
                primaryDebt && (
                  <Button
                    className="rounded-full"
                    data-testid="btn-pay-target"
                    onClick={() => setPaying(primaryDebt)}
                  >
                    Pay {primary.name}
                  </Button>
                )
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* Two cards: Extra per month + Strategy */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Extra per month */}
        <Card className="rounded-2xl">
          <CardContent className="p-6 space-y-4">
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Extra per month
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-5xl font-serif font-bold tabular-nums">
                {fmtMoney(resolvedExtraAmount)}
              </span>
              <span className="text-muted-foreground text-base">/mo</span>
            </div>
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
                <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                  <div>
                    Uses{" "}
                    {resolvedExtra?.mode === "actual" ? "actual" : "planned"}{" "}
                    amount of "
                    {resolvedExtra?.breakdown?.categoryName ?? "—"}" for{" "}
                    {resolvedExtra?.monthStart?.slice(0, 7) ?? "this month"}.
                  </div>
                  {resolvedExtra?.breakdown?.planned != null && (
                    <div className="flex justify-between">
                      <span>Planned</span>
                      <span className="tabular-nums text-foreground">
                        {fmtMoney(Number(resolvedExtra.breakdown.planned))}
                      </span>
                    </div>
                  )}
                  {resolvedExtra?.breakdown?.actual != null && (
                    <div className="flex justify-between">
                      <span>Actual</span>
                      <span className="tabular-nums text-foreground">
                        {fmtMoney(Number(resolvedExtra.breakdown.actual))}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {settings?.extraSource === "budget_net" && (
              <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground space-y-0.5">
                <div className="flex justify-between">
                  <span>
                    {resolvedExtra?.mode === "actual" ? "Actual" : "Planned"} income
                  </span>
                  <span className="tabular-nums text-foreground">
                    {fmtMoney(Number(resolvedExtra?.breakdown?.income ?? 0))}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>
                    − {resolvedExtra?.mode === "actual" ? "Actual" : "Planned"} expenses
                  </span>
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
                {resolvedExtra?.mode === "actual" &&
                  resolvedExtra?.breakdown?.plannedIncome != null && (
                    <div className="text-[10px] text-muted-foreground/80 pt-1">
                      Plan: {fmtMoney(Number(resolvedExtra.breakdown.plannedIncome))} in
                      {" / "}
                      {fmtMoney(Number(resolvedExtra.breakdown.plannedExpenses ?? 0))} out
                    </div>
                  )}
              </div>
            )}
            {settings?.extraSource === "manual" && (
              <>
                <div className="pt-2">
                  <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-muted-foreground mb-2">
                    <span>Avalanche budget</span>
                    <span className="tabular-nums normal-case tracking-normal text-foreground font-medium">
                      {fmtMoney(budgetCap)}/mo
                    </span>
                  </div>
                  <Slider
                    value={[Math.min(manualExtra, budgetCap)]}
                    min={0}
                    max={budgetCap}
                    step={25}
                    onValueChange={(v) =>
                      updateSettings.mutate({
                        data: { manualExtra: (v[0] ?? 0).toFixed(2) },
                      })
                    }
                  />
                  <div
                    className={`text-xs mt-2 ${overBudget ? "text-destructive font-medium" : "text-muted-foreground"}`}
                    data-testid="text-room-left"
                  >
                    {overBudget ? (
                      <>
                        Over budget by{" "}
                        <span className="tabular-nums">
                          {fmtMoney(Math.abs(roomLeft))}
                        </span>{" "}
                        — only{" "}
                        <span className="tabular-nums">
                          {fmtMoney(availableMoney)}
                        </span>{" "}
                        free this month.
                      </>
                    ) : (
                      <>
                        Room left in budget:{" "}
                        <span className="tabular-nums text-foreground font-medium">
                          {fmtMoney(roomLeft)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() =>
                    updateSettings.mutate({ data: { manualExtra: "0" } })
                  }
                >
                  Reset to $0
                </button>
              </>
            )}
          </CardContent>
        </Card>

        {/* Strategy */}
        <Card className="rounded-2xl">
          <CardContent className="p-6 space-y-4">
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Strategy
            </div>
            <PillToggle
              value={strategy}
              onChange={(v) =>
                updateSettings.mutate({ data: { strategy: v as Strategy } })
              }
              options={[
                { value: "avalanche", label: "Avalanche", sub: "Highest APR first" },
                { value: "snowball", label: "Snowball", sub: "Smallest balance first" },
              ]}
            />
            <div className="text-sm text-muted-foreground flex items-start gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 mt-1 shrink-0" />
              <span>
                {bothInfinite ? (
                  <>
                    Neither strategy beats minimums at{" "}
                    {fmtMoney(totalExtra)}/mo extra. Add more extra,
                    or refinance the underwater debt(s) above to make a plan
                    that actually finishes.
                  </>
                ) : minOnlyForever && !sim.ranOutOfTime ? (
                  <>
                    <strong className="text-foreground capitalize">{strategy}</strong>{" "}
                    with{" "}
                    <strong>{fmtMoney(totalExtra)}/mo</strong> extra
                    finishes{" "}
                    {usingSolvableSubset ? (
                      <>
                        the solvable portion (excludes{" "}
                        {excludedUnderwaterCount} underwater debt
                        {excludedUnderwaterCount === 1 ? "" : "s"} above)
                      </>
                    ) : (
                      <>the plan</>
                    )}
                    . Minimums alone never do — the underwater debt(s) above
                    grow forever without it.
                  </>
                ) : interestSavedVsMin !== null && monthsSavedVsMin !== null && (interestSavedVsMin > 0 || monthsSavedVsMin > 0) ? (
                  <>
                    <strong className="text-foreground capitalize">{strategy}</strong>{" "}
                    with{" "}
                    <strong>{fmtMoney(totalExtra)}/mo</strong> extra
                    saves{" "}
                    <strong className="text-emerald-600 dark:text-emerald-400">
                      {fmtMoney(interestSavedVsMin)}
                    </strong>
                    {monthsSavedVsMin > 0 ? (
                      <> and <strong>{monthsSavedVsMin} mo</strong></>
                    ) : null}{" "}
                    vs paying minimums only.
                  </>
                ) : interestDelta > 0 || monthsDelta > 0 ? (
                  <>
                    Sticking with{" "}
                    <strong className="text-foreground capitalize">{strategy}</strong>{" "}
                    saves{" "}
                    <strong className="text-emerald-600 dark:text-emerald-400">
                      {fmtMoney(Math.max(0, interestDelta))}
                    </strong>
                    {monthsDelta > 0 ? (
                      <> and <strong>{monthsDelta} mo</strong></>
                    ) : null}{" "}
                    vs the other strategy.
                  </>
                ) : interestDelta < 0 || monthsDelta < 0 ? (
                  <>
                    Switching to{" "}
                    <strong className="text-foreground">
                      {strategy === "avalanche" ? "snowball" : "avalanche"}
                    </strong>{" "}
                    would save{" "}
                    <strong className="text-emerald-600 dark:text-emerald-400">
                      {fmtMoney(Math.max(0, -interestDelta))}
                    </strong>
                    {monthsDelta < 0 ? (
                      <> and <strong>{-monthsDelta} mo</strong></>
                    ) : null}.
                  </>
                ) : (
                  <>
                    Both strategies cost the same with{" "}
                    {fmtMoney(totalExtra)}/mo extra.
                  </>
                )}
              </span>
            </div>
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground pt-1">
              Mode
            </div>
            <PillToggle
              value={budgetMode}
              onChange={(v) =>
                updateSettings.mutate({
                  data: { budgetMode: v as "budgeted" | "actual" },
                })
              }
              options={[
                { value: "budgeted", label: "Budgeted", sub: "Plan numbers" },
                { value: "actual", label: "Actual", sub: "From transactions" },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              Plan numbers from your Budget. Switch to Actual to drive the plan
              from real transactions this month.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Your next 3 moves / Kill order placeholder */}
      <div>
        <div className="flex items-baseline gap-3 mb-3">
          <h2 className="text-2xl font-serif font-bold text-foreground">
            Your next 3 moves
          </h2>
          <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Kill order
          </span>
        </div>
        {next3.length === 0 ? (
          <Card className="rounded-2xl">
            <CardContent className="p-6 text-sm text-muted-foreground">
              Add a debt above to see which one gets killed first.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {next3.map((d, i) => {
              const k = killById.get(d.id);
              const killEntry = sim.killedOrder.find((x) => x.id === d.id);
              const cascadeFreed = killEntry?.minFreed ?? 0;
              const nextDebt = next3[i + 1];
              return (
                <Card key={d.id} className="rounded-2xl">
                  <CardContent className="p-4 space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="h-6 w-6 rounded-full bg-foreground text-background text-xs font-semibold flex items-center justify-center">
                        {i + 1}
                      </div>
                      {i === 0 && (
                        <Flame className="h-4 w-4 text-destructive" aria-hidden />
                      )}
                      <div className="font-medium truncate">{d.name}</div>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center justify-between">
                      <span className={aprToneClass(d.apr)}>{fmtPct(d.apr)} APR</span>
                      <span className="tabular-nums">{fmtMoney(d.balance)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Payoff:{" "}
                      <span className="text-foreground tabular-nums">
                        {k ? fmtMonth(k.date) : "—"}
                      </span>
                    </div>
                    {cascadeFreed > 0 && (
                      <div className="text-xs text-emerald-700 dark:text-emerald-400">
                        +{fmtMoney(cascadeFreed)}/mo{" "}
                        {nextDebt ? (
                          <>
                            rolls into{" "}
                            <span className="font-medium">{nextDebt.name}</span>
                          </>
                        ) : (
                          <>rolls forward to the next debt</>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Tabs: debts table + projection */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
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
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedActive.length === 0 && (
                    <tr>
                      <td colSpan={11} className="text-center py-8 text-muted-foreground">
                        All clear — no active debts. Add one above to get started.
                      </td>
                    </tr>
                  )}
                  {sortedActive.map((d, i) => {
                    const dbt = (debts ?? []).find((x) => x.id === d.id)!;
                    const k = killById.get(d.id);
                    const isTarget = planTargetIds.has(d.id);
                    const isHighlighted = highlightedDebtId === d.id;
                    const dueChip = renderDueChip(dbt.dueDay ?? null);
                    return (
                      <tr
                        key={d.id}
                        ref={(el) => {
                          rowRefs.current.set(d.id, el);
                        }}
                        data-testid={`row-debt-${d.id}`}
                        className={`border-t hover:bg-muted/30 cursor-pointer transition-colors duration-700 ${
                          isHighlighted
                            ? "bg-primary/20 ring-2 ring-primary"
                            : isTarget
                            ? "bg-primary/5"
                            : ""
                        }`}
                        onClick={() => setDrillDown(d.id)}
                      >
                        <td className="px-3 py-2 font-medium">
                          <div className="flex items-center gap-2">
                            <PayoffRing
                              originalBalance={
                                dbt.originalBalance != null
                                  ? Number(dbt.originalBalance)
                                  : null
                              }
                              balance={Number(dbt.balance)}
                            />
                            <div className="min-w-0">
                              {isTarget && (
                                <Badge className="mr-2" variant="default">
                                  Target
                                </Badge>
                              )}
                              {d.name}
                              <DebtPlaidSource debt={dbt} />
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{dbt.type ?? "—"}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${aprToneClass(d.apr)}`}
                        >
                          <div className="flex items-center justify-end gap-1">
                            <span>{fmtPct(d.apr)}</span>
                            <DebtPlaidIndicator debt={dbt} field="apr" />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <div className="flex items-center justify-end gap-1">
                            <span>{fmtMoney(d.balance)}</span>
                            <DebtPlaidIndicator debt={dbt} field="balance" />
                          </div>
                          <DebtLastSynced debt={dbt} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <div className="flex items-center justify-end gap-1">
                            <span>{fmtMoney(d.minPayment)}</span>
                            <DebtPlaidIndicator debt={dbt} field="minPayment" />
                          </div>
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
                        <td
                          className="px-3 py-2 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DebtPlaidActions debt={dbt} />
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
                      <td colSpan={6}></td>
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
                        {m.targets.length === 0 ? (
                          m.activeTargetName ?? "—"
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {m.targets.map((t) => (
                              <span
                                key={t.id}
                                className={
                                  t.killedThisMonth
                                    ? "text-emerald-600 dark:text-emerald-400 line-through decoration-emerald-600/60 dark:decoration-emerald-400/60"
                                    : ""
                                }
                                title={
                                  t.killedThisMonth
                                    ? `Paid off this month (+${fmtMoney(t.extraPaid)} extra)`
                                    : `+${fmtMoney(t.extraPaid)} extra`
                                }
                              >
                                {t.name}
                              </span>
                            ))}
                          </div>
                        )}
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
                      stroke="hsl(var(--chart-1))"
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
        isTarget={paying ? planTargetIds.has(paying.id) : false}
        suggestedExtra={
          paying
            ? planTargets.length > 1
              ? planTargets.find((t) => t.id === paying.id)?.extraForTarget ?? 0
              : totalExtra
            : 0
        }
        defaultAccount={appSettings?.primaryAccount ?? ""}
        submitting={createPayment.isPending}
        onSubmit={async (data) => {
          if (!paying) return;
          try {
            const payingDebt = paying;
            const result = await createPayment.mutateAsync({
              id: payingDebt.id,
              data,
            });
            setPaying(null);
            if (result?.killed) {
              setKilledBanner({ id: payingDebt.id, name: payingDebt.name });
              toast({
                title: `🎉 ${payingDebt.name} is paid off!`,
                description: "Archived automatically. One less debt — keep going!",
              });
            } else {
              toast({ title: "Payment recorded" });
            }
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

function StatStripCell({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
}) {
  return (
    <div className="px-5 py-4 border-l border-border first:border-l-0 first:pl-0 md:first:pl-5">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`text-3xl font-serif font-bold tabular-nums mt-2 ${
          valueClassName ?? ""
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-1 tabular-nums">{sub}</div>
      )}
    </div>
  );
}

function PillToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; sub: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-1 p-1 rounded-full bg-muted/60">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-full px-4 py-2 text-left transition-colors ${
              active
                ? "bg-foreground text-background shadow"
                : "text-foreground hover:bg-background/60"
            }`}
          >
            <div className="text-sm font-semibold leading-tight">{opt.label}</div>
            <div
              className={`text-[10px] uppercase tracking-[0.18em] mt-0.5 ${
                active ? "text-background/70" : "text-muted-foreground"
              }`}
            >
              {opt.sub}
            </div>
          </button>
        );
      })}
    </div>
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
          {initial?.plaidAccountId ? (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              This debt is linked to Plaid. Editing balance, APR, or minimum
              payment will switch that field to a manual override and stop
              auto-syncing it.
            </p>
          ) : null}
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
      const prefillExtra = isTarget && suggestedExtra > 0;
      setPayExtra(prefillExtra);
      setAmount((m + (prefillExtra ? suggestedExtra : 0)).toFixed(2));
      setOccurredOn(new Date().toISOString().slice(0, 10));
      setAccount(defaultAccount);
      setNotes("");
    }
  }, [open, debt, defaultAccount, isTarget, suggestedExtra]);

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

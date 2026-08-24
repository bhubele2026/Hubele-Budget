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
  getGetBillsSummaryQueryKey,
  getGetForecastQueryKey,
} from "@workspace/api-client-react";
import type { Debt } from "@workspace/api-client-react";
import { Slider } from "@/components/ui/slider";
import { PageSkeleton } from "@/components/page-skeleton";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { useSpine } from "@/hooks/useSpine";
import { AvalancheCardConfig } from "@/components/avalanche-card-config";
import { AvalancheScheduleCard } from "@/components/avalanche-schedule-card";
import {
  DebtPlaidActions,
  DebtLastSynced,
  DebtPlaidSource,
  DebtReauthBanner,
} from "@/components/debt-plaid-link";
import {
  Page,
  Stat,
  Help,
  Foot,
  Field,
  card,
  cardHead,
  btn,
  btnSecondary,
  btnLink,
  btnLinkDanger,
  input,
  fieldLabel,
  th,
  td,
  tdNum,
  emptyNote,
} from "@/ui";
import { LineTrend, CHART, type SeriesDef } from "@/lib/charts";
import { CssBars, type CssBarRow } from "@/lib/cssBars";
import { cn } from "@/lib/utils";
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
import { debtToSim, effectiveDebtBalance } from "@/lib/debtBalance";
import { DebtPendingHint } from "@/components/debt-pending-hint";
import { Trash2, Plus, RefreshCw, X, ClipboardPaste } from "lucide-react";

const MANUAL_EXTRA_CAP = 5000;

// (#421/C10) The pending-payment netting basis and the `Debt` → `SimDebt`
// mapper both live in `@/lib/debtBalance` now, so every page's simulation
// enters through the same function — see that module's header for why.

// Single, row-level source chip for the Debts table. The source is shown once
// per row in the creditor cell, never repeated in the APR/Balance/Min columns.
function DebtSourceChip({ debt }: { debt: Debt }) {
  const linked = !!debt.plaidAccountId;
  return (
    <span
      className="chip gray shrink-0"
      title={linked ? "Synced from Plaid" : "Manually entered"}
    >
      {linked ? "Plaid" : "Manual"}
    </span>
  );
}

/** The strategy verdict, as ONE plain sentence. It used to be five nested
 *  `<strong>`s inside a coloured callout; the numbers are the emphasis. */
function strategyVerdict(args: {
  strategy: Strategy;
  totalExtra: number;
  bothInfinite: boolean;
  minOnlyForever: boolean;
  ranOutOfTime: boolean;
  usingSolvableSubset: boolean;
  excludedUnderwaterCount: number;
  interestSavedVsMin: number | null;
  monthsSavedVsMin: number | null;
  interestDelta: number;
  monthsDelta: number;
}): string {
  const {
    strategy,
    totalExtra,
    bothInfinite,
    minOnlyForever,
    ranOutOfTime,
    usingSolvableSubset,
    excludedUnderwaterCount,
    interestSavedVsMin,
    monthsSavedVsMin,
    interestDelta,
    monthsDelta,
  } = args;
  const name = strategy === "avalanche" ? "Avalanche" : "Snowball";
  const other = strategy === "avalanche" ? "snowball" : "avalanche";
  const extra = `${fmtMoney(totalExtra)}/mo`;
  const plural = excludedUnderwaterCount === 1 ? "" : "s";

  if (bothInfinite) {
    return `Neither strategy beats minimums at ${extra} extra. Raise the extra or refinance the underwater debt.`;
  }
  if (minOnlyForever && !ranOutOfTime) {
    const scope = usingSolvableSubset
      ? `the solvable portion (excludes ${excludedUnderwaterCount} underwater debt${plural} above)`
      : "the plan";
    return `${name} with ${extra} extra finishes ${scope}. Minimums alone never do.`;
  }
  if (
    interestSavedVsMin !== null &&
    monthsSavedVsMin !== null &&
    (interestSavedVsMin > 0 || monthsSavedVsMin > 0)
  ) {
    const time = monthsSavedVsMin > 0 ? ` and ${monthsSavedVsMin} mo` : "";
    return `${name} with ${extra} extra saves ${fmtMoney(interestSavedVsMin)}${time} vs minimums only.`;
  }
  if (interestDelta > 0 || monthsDelta > 0) {
    const time = monthsDelta > 0 ? ` and ${monthsDelta} mo` : "";
    return `${name} saves ${fmtMoney(Math.max(0, interestDelta))}${time} vs ${other}.`;
  }
  if (interestDelta < 0 || monthsDelta < 0) {
    const time = monthsDelta < 0 ? ` and ${-monthsDelta} mo` : "";
    return `Switching to ${other} would save ${fmtMoney(Math.max(0, -interestDelta))}${time}.`;
  }
  return `Both strategies cost the same at ${extra} extra.`;
}

export default function AvalanchePage() {
  const { data: debts, isLoading } = useListDebts();
  const { data: settings } = useGetAvalancheSettings();
  const qc = useQueryClient();
  const { toast } = useToast();

  // ⭐ THE HERO NUMBER COMES FROM THE SPINE, NOT FROM THIS PAGE.
  //
  // `debt.payoffPct` is computed server-side by `payoffPct()` in
  // @workspace/avalanche-core over the same `/debts` rows this page lists, and
  // a CI integration test asserts the two agree. Recomputing it here is how the
  // landing tile and this page would come to quote two different percentages
  // for the same household — the exact failure /api/spine exists to prevent.
  const { data: spine } = useSpine();
  const payoffPct = spine?.debt?.payoffPct ?? null;

  // ⚠️ CssBars' label and value columns are FIXED PIXEL widths, and the bar is
  // whatever is left over. At the desktop widths those two columns eat a phone
  // card whole and the bars collapse to nothing — the list silently stops being
  // a chart. Narrow both on small screens so the bar always has room to mean
  // something.
  const isMobile = useIsMobile();

  // (#823) Debt changes shift the forecast (debt minimums are bills) and
  // the cash-signal "lowest balance" projection. Broadly invalidate the whole
  // forecast namespace so every cached horizon + cash-signal refreshes after a
  // debt mutation, matching the prefix-based invalidation used on Forecast.
  const invalidateForecast = () => {
    qc.invalidateQueries({
      predicate: (q) => {
        const key = q.queryKey[0];
        return typeof key === "string" && key.startsWith("/api/forecast");
      },
    });
  };

  const updateSettings = useUpdateAvalancheSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAvalancheSettingsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAvalancheExtraQueryKey() });
        // The slider amount also drives the synthetic "Avalanche extra
        // payment" row on Bills + Forecast — invalidate those so the
        // UI stays in sync the moment the slider commits.
        qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        // The slider commit also writes the current month's "Avalanche
        // payment" budget line on the server, so invalidate every cached
        // getBudgetMonth so the Budget page card refreshes immediately.
        // The query key is `[`/api/budget/months/${monthStart}`]`, so we
        // match the family by URL prefix rather than a fixed key.
        qc.invalidateQueries({
          predicate: (q) => {
            const first = q.queryKey[0];
            return (
              typeof first === "string" &&
              first.startsWith("/api/budget/months/")
            );
          },
        });
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
        invalidateForecast();
      },
    },
  });
  const createDebt = useCreateDebt({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        invalidateForecast();
      },
    },
  });
  const updateDebt = useUpdateDebt({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        invalidateForecast();
      },
    },
  });
  const deleteDebt = useDeleteDebt({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        invalidateForecast();
      },
    },
  });
  const syncMinimums = useSyncDebtMinimums({
    mutation: {
      onSuccess: (res) => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        invalidateForecast();
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
  // Local drag state for the Avalanche budget slider. While the user is
  // dragging the thumb we read from this so the UI tracks the cursor; on
  // release we persist via `onValueCommit` and clear local state once the
  // server-backed `manualExtra` catches up (see effect below).
  const [manualExtraDraft, setManualExtraDraft] = useState<number | null>(null);
  useEffect(() => {
    setManualExtraDraft(null);
  }, [manualExtra]);
  const liveManualExtra = manualExtraDraft ?? manualExtra;
  const rawResolvedExtraAmount = Number(resolvedExtra?.amount ?? manualExtra);
  // When the source is manual, the API echoes the raw saved manualExtra back
  // as `resolvedExtra.amount`. Clamp it here too so a stale > $5k value can't
  // drive the headline or the simulation past the cap.
  const isManualSource =
    (resolvedExtra?.source ?? settings?.extraSource ?? "manual") === "manual";
  // (#652) While the user is actively dragging the Avalanche budget slider,
  // drive the simulation/projection/What-if math from the *live* draft value
  // instead of waiting for the server-side `resolvedExtra` to round-trip.
  const resolvedExtraAmount = isManualSource
    ? clampManual(manualExtraDraft ?? rawResolvedExtraAmount)
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

  // ⚠️ A FRESH `lines` ARRAY ON EVERY RENDER RESTARTS THE RECHARTS DRAW.
  // Held steady here so the payoff line finishes growing instead of snapping.
  const chartLines: SeriesDef[] = useMemo(
    () => [
      { key: "balance", name: "Balance left", color: CHART.navy },
      { key: "interest", name: "Interest paid", color: CHART.orangeDeep },
    ],
    [],
  );

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

  const underwaterIds = useMemo(
    () => new Set(sim.underwater.map((u) => u.id)),
    [sim.underwater],
  );

  // ── The payoff-order bar list ──────────────────────────────────────────────
  // Rank is the month each debt dies, NOT how big it is — see `rankBy` on
  // CssBars. Rows are held in a stable id order so the component can glide a
  // rank change instead of tearing the row down and rebuilding it.
  const payoffRank = useMemo(() => {
    const m = new Map<string, number>();
    sim.killedOrder.forEach((k, i) => m.set(k.id, i));
    return m;
  }, [sim.killedOrder]);

  const originalById = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of debts ?? []) {
      const orig = d.originalBalance != null ? Number(d.originalBalance) : 0;
      if (Number.isFinite(orig) && orig > 0) m.set(d.id, orig);
    }
    return m;
  }, [debts]);

  const payoffRows: CssBarRow[] = useMemo(() => {
    const stable = [...activeDebts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return stable.map((d) => {
      const orig = originalById.get(d.id) ?? 0;
      const pct = orig > 0 ? Math.round(Math.max(0, Math.min(1, (orig - d.balance) / orig)) * 100) : null;
      // ⚠️ THE STATE IS A WORD. The ramp encodes payoff order and nothing else,
      // so "this one is unpayable" has to be readable without reading a colour.
      const state = underwaterIds.has(d.id)
        ? "underwater"
        : planTargetIds.has(d.id)
          ? "target"
          : pct != null
            ? `${pct}% paid`
            : "";
      return { id: d.id, label: d.name, value: d.balance, hint: state };
    });
  }, [activeDebts, originalById, underwaterIds, planTargetIds]);

  const rankOfRow = useMemo(
    () => (row: CssBarRow) => payoffRank.get(row.id) ?? Number.MAX_SAFE_INTEGER,
    [payoffRank],
  );

  // Stale-while-revalidate: only skeleton on a genuine cold load (no cached
  // debts yet); once data exists, render it and revalidate in the background.
  if (isLoading && !debts) {
    return <PageSkeleton />;
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
  const roomLeft = availableMoney - liveManualExtra;
  const overBudget = roomLeft < 0;

  const budgetMode = (settings?.budgetMode ?? "budgeted") as "budgeted" | "actual";
  const verdict = strategyVerdict({
    strategy,
    totalExtra,
    bothInfinite,
    minOnlyForever,
    ranOutOfTime: sim.ranOutOfTime,
    usingSolvableSubset,
    excludedUnderwaterCount,
    interestSavedVsMin,
    monthsSavedVsMin,
    interestDelta,
    monthsDelta,
  });

  return (
    <Page title="Future Goal">
      <DebtReauthBanner debts={debts} />

      {killedBanner && (
        <div className={cn(card, "mb-4 flex items-center gap-3 px-4 py-3")}>
          <span className="chip ok">Paid off</span>
          <span className="text-body text-neutral-600">
            <span className="font-medium text-brand-navy">{killedBanner.name}</span> is
            paid in full and archived.
          </span>
          <button
            type="button"
            className={cn(btnLink, "ml-auto")}
            onClick={() => setKilledBanner(null)}
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ══ THE ONE BIG NUMBER ═══════════════════════════════════════════════
          This app exists to get the household out of debt, so the screen leads
          with how much of it is gone — a percentage, never an amount owed. The
          balance is real detail and lives further down, in the table that can
          disclose what it is counting. */}
      <section className={cn(card, "mb-5")} data-testid="avalanche-hero">
        <div className="flex flex-col gap-4 px-5 pb-5 pt-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className={fieldLabel}>Debt paid off</div>
            <div
              data-testid="avalanche-payoff-pct"
              className="mt-1 font-mono text-hero font-semibold leading-none tabular-nums text-brand-navy"
            >
              {payoffPct != null ? `${Math.round(payoffPct)}%` : "—"}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-label text-neutral-500">
              <span data-testid="avalanche-debt-free-hint">
                {sim.ranOutOfTime
                  ? "No payoff date at this extra"
                  : sim.debtFreeDate
                    ? `Debt-free ${fmtMonth(sim.debtFreeDate)} · ${sim.monthsToFreedom} mo`
                    : "No payoff date yet"}
              </span>
              <Help>
                Percent paid is the share of the original balances that is gone,
                across every debt that has a recorded starting balance. It comes
                from the shared snapshot the front door reads, so the two always
                agree.
              </Help>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={cn(btnSecondary, "inline-flex items-center gap-1.5")}
              onClick={() => syncMinimums.mutate()}
              disabled={syncMinimums.isPending}
              title="Sync minimums from recent payments"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", syncMinimums.isPending && "animate-spin")} />
              <span className="hidden sm:inline">Sync minimums</span>
            </button>
            <button
              type="button"
              className={cn(btnSecondary, "inline-flex items-center gap-1.5")}
              onClick={() => setAddOpen(true)}
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
              Paste debts
            </button>
            <button
              type="button"
              className={cn(btn, "inline-flex items-center gap-1.5")}
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Add debt
            </button>
          </div>
        </div>

        {/* The percentage, drawn. Track is platinum, fill is navy — one bar,
            no second colour, and it sweeps on the kit's move curve. */}
        <div
          className="h-1.5 w-full bg-platinum-4"
          role="img"
          aria-label={
            payoffPct != null
              ? `${Math.round(payoffPct)} percent of the original debt is paid off`
              : "Payoff progress not available"
          }
        >
          <div
            className="bar-sweep h-full bg-brand-navy"
            style={{ width: `${payoffPct != null ? Math.max(0, Math.min(100, payoffPct)) : 0}%` }}
          />
        </div>
      </section>

      {/* Headline detail. `Months to freedom` carries the underwater caveat as
          its hint — a drill has to disclose what it is leaving out. */}
      <div className="mb-5 flex flex-wrap gap-3">
        <Stat
          index={0}
          label="Months to freedom"
          value={sim.ranOutOfTime ? "∞" : String(sim.monthsToFreedom)}
          hint={
            sim.ranOutOfTime
              ? sim.underwater.length > 0
                ? `${sim.underwater[0]!.name} interest > minimum`
                : "raise the extra"
              : excludedUnderwaterCount > 0
                ? `excludes ${excludedUnderwaterCount} underwater debt${excludedUnderwaterCount === 1 ? "" : "s"}`
                : `${(sim.monthsToFreedom / 12).toFixed(1)} yrs`
          }
        />
        <Stat
          index={1}
          label="Debt-free date"
          value={sim.debtFreeDate ? fmtMonth(sim.debtFreeDate) : "—"}
        />
        <Stat
          index={2}
          label="Total interest"
          value={sim.ranOutOfTime ? "∞" : fmtMoneyCompact(sim.totalInterestPaid)}
          hint="remaining, at this plan"
        />
        <Stat
          index={3}
          label="Total debt"
          value={fmtMoneyCompact(totalBalance)}
          hint={`${activeDebts.length} active`}
        />
      </div>

      {/* Payoff order — bars are CSS, never recharts: this list re-reads itself
          whenever the extra changes, and a recharts list would restart its draw
          on every keystroke of the slider. */}
      {payoffRows.length > 0 && (
        <div className={cn(card, "mb-5")}>
          <div className={cardHead}>
            <span className="text-title font-semibold text-brand-navy">Payoff order</span>
            <span className="text-micro uppercase tracking-wide text-neutral-400">
              Balance left
            </span>
            <Help className="ml-auto">
              Ordered by the month each debt is projected to be paid off, darkest
              first — not by size. Bar length is the balance still owed.
            </Help>
          </div>
          <div className="px-4 py-3">
            <CssBars
              rows={payoffRows}
              format={fmtMoney}
              ramp
              rankBy={rankOfRow}
              rowHeight={30}
              labelWidth={isMobile ? 84 : 130}
              valueWidth={isMobile ? 132 : 150}
              ariaLabel="Balance remaining by debt, in projected payoff order"
            />
          </div>
        </div>
      )}

      {/* This month — full plan amount + target debt(s) + projected kill date. */}
      {(() => {
        if (planTargets.length === 0) return null;
        const allMins = activeDebts.reduce((s, d) => s + d.minPayment, 0);
        const planTotal = allMins + totalExtra;
        const isMulti = planTargets.length > 1;
        const primary = planTargets[0]!;
        const primaryDebt = (debts ?? []).find((x) => x.id === primary.id);
        return (
          <div className={cn(card, "mb-5")} data-testid="panel-this-month">
            <div className={cardHead}>
              <span className="text-title font-semibold text-brand-navy">This month</span>
              <span className="ml-auto font-mono text-label font-semibold tabular-nums text-brand-navy">
                {fmtMoney(planTotal)}
              </span>
            </div>
            <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                {isMulti ? (
                  <>
                    <p className="text-body text-neutral-600">
                      {fmtMoney(allMins)} in minimums on every debt plus{" "}
                      {fmtMoney(totalExtra)} extra split across {planTargets.length} debts
                    </p>
                    <ul className="mt-3 space-y-1.5" data-testid="this-month-targets">
                      {planTargets.map((t) => {
                        const killDate =
                          sim.killedOrder.find((k) => k.id === t.id)?.date ?? null;
                        return (
                          <li
                            key={t.id}
                            data-testid={`this-month-target-${t.id}`}
                            className="flex flex-wrap items-baseline gap-x-2 text-label"
                          >
                            <span className="font-medium text-brand-navy">{t.name}</span>
                            <span className="font-mono tabular-nums text-neutral-600">
                              {fmtMoney(t.minPayment + t.extraForTarget)}
                            </span>
                            <span className="text-micro text-neutral-400">
                              {fmtMoney(t.minPayment)} min + {fmtMoney(t.extraForTarget)} extra
                            </span>
                            {t.killedThisMonth ? (
                              <span className="chip ok">killed this month</span>
                            ) : killDate ? (
                              <span className="text-micro text-neutral-400">
                                projected kill{" "}
                                <span className="font-mono tabular-nums text-neutral-600">
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
                      sim.killedOrder.find((k) => k.id === target.id)?.date ?? null;
                    return (
                      <>
                        <p className="text-body text-neutral-600">
                          {fmtMoney(allMins)} in minimums on every debt plus{" "}
                          {fmtMoney(totalExtra)} extra onto{" "}
                          <span className="font-medium text-brand-navy">{target.name}</span>
                        </p>
                        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5">
                          <div>
                            <dt className={fieldLabel}>Target gets</dt>
                            <dd className="font-mono text-label tabular-nums text-brand-navy">
                              {fmtMoney(targetPayment)}
                            </dd>
                          </div>
                          <div>
                            <dt className={fieldLabel}>Interest / day</dt>
                            <dd className="font-mono text-label tabular-nums text-brand-navy">
                              {fmtMoney(dailyCost)}
                            </dd>
                          </div>
                          {killDate && (
                            <div>
                              <dt className={fieldLabel}>Projected kill</dt>
                              <dd className="font-mono text-label tabular-nums text-brand-navy">
                                {fmtMonth(killDate)}
                              </dd>
                            </div>
                          )}
                        </dl>
                      </>
                    );
                  })()
                )}
              </div>
              {isMulti ? (
                <div
                  className="flex shrink-0 flex-col gap-2 md:items-end"
                  data-testid="this-month-pay-buttons"
                >
                  {planTargets.map((t) => {
                    const dbt = (debts ?? []).find((x) => x.id === t.id);
                    if (!dbt) return null;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={t.id === primary.id ? btn : btnSecondary}
                        data-testid={`btn-pay-target-${t.id}`}
                        onClick={() => setPaying(dbt)}
                      >
                        Pay {t.name}
                      </button>
                    );
                  })}
                </div>
              ) : (
                primaryDebt && (
                  <button
                    type="button"
                    className={cn(btn, "shrink-0")}
                    data-testid="btn-pay-target"
                    onClick={() => setPaying(primaryDebt)}
                  >
                    Pay {primary.name}
                  </button>
                )
              )}
            </div>
          </div>
        );
      })()}

      {/* Two cards: Extra per month + Strategy */}
      <div className="mb-5 grid gap-4 md:grid-cols-2">
        {/* Extra per month */}
        <div className={card}>
          <div className={cardHead}>
            <span className="text-title font-semibold text-brand-navy">Extra per month</span>
            <span className="ml-auto font-mono text-label font-semibold tabular-nums text-brand-navy">
              {fmtMoney(resolvedExtraAmount)}
            </span>
          </div>
          <div className="space-y-3 p-4">
            <Field label="Source">
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
            </Field>

            {settings?.extraSource === "budget_line" && (
              <>
                <Field label="Budget category">
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
                </Field>
                <table className="w-full">
                  <tbody>
                    <tr>
                      <td className={cn(td, "text-neutral-500")}>Planned</td>
                      <td className={tdNum}>
                        {resolvedExtra?.breakdown?.planned != null
                          ? fmtMoney(Number(resolvedExtra.breakdown.planned))
                          : "—"}
                      </td>
                    </tr>
                    <tr>
                      <td className={cn(td, "text-neutral-500")}>Actual</td>
                      <td className={tdNum}>
                        {resolvedExtra?.breakdown?.actual != null
                          ? fmtMoney(Number(resolvedExtra.breakdown.actual))
                          : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-micro text-neutral-400">
                  {resolvedExtra?.mode === "actual" ? "Actual" : "Planned"} amount of{" "}
                  {resolvedExtra?.breakdown?.categoryName ?? "—"} for{" "}
                  {resolvedExtra?.monthStart?.slice(0, 7) ?? "this month"}.
                </p>
              </>
            )}

            {settings?.extraSource === "budget_net" && (
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className={cn(td, "text-neutral-500")}>
                      {resolvedExtra?.mode === "actual" ? "Actual" : "Planned"} income
                    </td>
                    <td className={tdNum}>
                      {fmtMoney(Number(resolvedExtra?.breakdown?.income ?? 0))}
                    </td>
                  </tr>
                  <tr>
                    <td className={cn(td, "text-neutral-500")}>
                      − {resolvedExtra?.mode === "actual" ? "Actual" : "Planned"} expenses
                    </td>
                    <td className={tdNum}>
                      {fmtMoney(Number(resolvedExtra?.breakdown?.expenses ?? 0))}
                    </td>
                  </tr>
                  <tr>
                    <td className={cn(td, "font-medium text-neutral-600")}>Net surplus</td>
                    <td className={cn(tdNum, "font-semibold text-brand-navy")}>
                      {fmtMoney(resolvedExtraAmount)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            {settings?.extraSource === "manual" && (
              <>
                <div className="pt-1">
                  <div className="mb-2 flex items-center justify-between">
                    <span className={fieldLabel}>Avalanche budget</span>
                    <span
                      className="font-mono text-label font-semibold tabular-nums text-brand-navy"
                      data-testid="text-avalanche-budget-live"
                    >
                      {fmtMoney(Math.min(liveManualExtra, budgetCap))}
                      <span className="font-normal text-neutral-400">
                        {" / "}
                        {fmtMoney(budgetCap)}
                      </span>
                    </span>
                  </div>
                  <Slider
                    value={[Math.min(liveManualExtra, budgetCap)]}
                    min={0}
                    max={budgetCap}
                    step={25}
                    onValueChange={(v) => setManualExtraDraft(v[0] ?? 0)}
                    onValueCommit={(v) => {
                      const next = v[0] ?? 0;
                      setManualExtraDraft(next);
                      updateSettings.mutate({
                        data: { manualExtra: next.toFixed(2) },
                      });
                    }}
                  />
                  <div
                    className={cn(
                      "mt-2 text-micro",
                      overBudget ? "font-medium text-bad" : "text-neutral-400",
                    )}
                    data-testid="text-room-left"
                  >
                    {overBudget ? (
                      <>
                        Over budget by{" "}
                        <span className="font-mono tabular-nums">
                          {fmtMoney(Math.abs(roomLeft))}
                        </span>{" "}
                        — <span className="font-mono tabular-nums">{fmtMoney(availableMoney)}</span>{" "}
                        free this month
                      </>
                    ) : (
                      <>
                        Room left{" "}
                        <span className="font-mono tabular-nums text-neutral-600">
                          {fmtMoney(roomLeft)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className={btnLink}
                  onClick={() => updateSettings.mutate({ data: { manualExtra: "0" } })}
                >
                  Reset to $0
                </button>
              </>
            )}
          </div>
        </div>

        {/* Strategy */}
        <div className={card}>
          <div className={cardHead}>
            <span className="text-title font-semibold text-brand-navy">Strategy</span>
            <Help className="ml-auto">
              Avalanche pays the highest APR first and costs the least interest.
              Snowball pays the smallest balance first and clears debts sooner.
              Mode picks whether the extra comes from plan numbers or from real
              transactions this month.
            </Help>
          </div>
          <div className="space-y-3 p-4">
            <PillToggle
              value={strategy}
              onChange={(v) => updateSettings.mutate({ data: { strategy: v as Strategy } })}
              options={[
                { value: "avalanche", label: "Avalanche", sub: "Highest APR first" },
                { value: "snowball", label: "Snowball", sub: "Smallest balance first" },
              ]}
            />
            <p className="text-body text-neutral-600" data-testid="strategy-verdict">
              {verdict}
            </p>
            <div className={cn(fieldLabel, "pt-1")}>Mode</div>
            <PillToggle
              value={budgetMode}
              onChange={(v) =>
                updateSettings.mutate({ data: { budgetMode: v as "budgeted" | "actual" } })
              }
              options={[
                { value: "budgeted", label: "Budgeted", sub: "Plan numbers" },
                { value: "actual", label: "Actual", sub: "From transactions" },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Your next 3 moves / Kill order.
          ⚠️ `space-y-3` + a `.grid` of card divs is asserted by
          avalanchePagePlan.test.tsx — keep both when restyling. */}
      <div className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-title font-semibold text-brand-navy">Your next 3 moves</h2>
          <span className="text-micro uppercase tracking-wide text-neutral-400">Kill order</span>
        </div>
        {next3.length === 0 ? (
          <div className={cn(card, emptyNote)}>Add a debt to see which one dies first.</div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-3">
            {next3.map((d, i) => {
              const k = killById.get(d.id);
              const killEntry = sim.killedOrder.find((x) => x.id === d.id);
              const cascadeFreed = killEntry?.minFreed ?? 0;
              const nextDebt = next3[i + 1];
              return (
                <div key={d.id} className={cn(card, "tile-in p-4")} style={{ animationDelay: `calc(${i} * var(--stagger))` }}>
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-navy font-mono text-[10px] font-bold tabular-nums text-white">
                      {i + 1}
                    </span>
                    <span className="truncate font-medium text-brand-navy">{d.name}</span>
                  </div>
                  <dl className="mt-2.5 space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className={fieldLabel}>APR</dt>
                      <dd className="font-mono text-label tabular-nums text-neutral-600">
                        {fmtPct(d.apr)}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className={fieldLabel}>Balance</dt>
                      <dd className="font-mono text-label tabular-nums text-neutral-600">
                        {fmtMoney(d.balance)}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className={fieldLabel}>Payoff</dt>
                      <dd className="font-mono text-label tabular-nums text-brand-navy">
                        {k ? fmtMonth(k.date) : "—"}
                      </dd>
                    </div>
                  </dl>
                  {cascadeFreed > 0 && (
                    <p className="mt-2.5 border-t border-brand-line pt-2 text-micro text-neutral-400">
                      <span className="font-mono tabular-nums text-neutral-600">
                        +{fmtMoney(cascadeFreed)}
                      </span>
                      /mo rolls into {nextDebt ? nextDebt.name : "the next debt"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Dated avalanche extra-payment schedule (server-computed). */}
      <div className="mt-5">
        <AvalancheScheduleCard />
      </div>

      {/* Amex cards → payoff: tier/name config + add-to-avalanche. */}
      <div className="mt-5">
        <AvalancheCardConfig />
      </div>

      {/* Tabs: debts table + projection */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-5">
        <TabsList>
          <TabsTrigger value="debts">Debts ({activeDebts.length})</TabsTrigger>
          <TabsTrigger value="projection">Projection</TabsTrigger>
          <TabsTrigger value="chart">Chart</TabsTrigger>
          {archivedDebts.length > 0 && (
            <TabsTrigger value="archived">Archived ({archivedDebts.length})</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="debts" className="mt-4">
          <div className={card}>
            <div className={cardHead}>
              <span className="text-title font-semibold text-brand-navy">Debts</span>
              <span className="text-micro uppercase tracking-wide text-neutral-400">
                Highest APR first
              </span>
              <Help className="ml-auto">
                Balance nets out payments you have tagged but the creditor has
                not reported yet. Daily is what this debt costs in interest per
                day at its current balance.
              </Help>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Creditor</th>
                    <th className={cn(th, "text-right")}>APR</th>
                    <th className={cn(th, "text-right")}>Balance</th>
                    <th className={cn(th, "text-right")}>Min</th>
                    <th className={th}>Due</th>
                    <th className={cn(th, "text-right")}>Payoff</th>
                    <th className={cn(th, "text-right")}>Daily</th>
                    <th className={cn(th, "w-[1%] text-right")}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedActive.length === 0 && (
                    <tr>
                      <td colSpan={8} className={emptyNote}>
                        No active debts.
                      </td>
                    </tr>
                  )}
                  {sortedActive.map((d) => {
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
                        className={cn(
                          "cursor-pointer transition-colors duration-[--dur-soft] hover:bg-platinum-3",
                          isHighlighted
                            ? "bg-platinum-4 ring-1 ring-inset ring-brand-navy"
                            : isTarget && "bg-brand-tint",
                        )}
                        onClick={() => setDrillDown(d.id)}
                      >
                        <td className={td}>
                          <div className="flex min-w-0 items-center gap-2">
                            {isTarget && <span className="chip bg-brand-navy text-white">Target</span>}
                            <span className="truncate font-medium text-neutral-700" title={d.name}>
                              {d.name}
                            </span>
                            <DebtSourceChip debt={dbt} />
                          </div>
                          {(dbt.plaidAccountId || dbt.type) && (
                            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-micro text-neutral-400">
                              {dbt.type && <span className="capitalize">{dbt.type}</span>}
                              <DebtPlaidSource debt={dbt} />
                              <DebtLastSynced debt={dbt} />
                            </div>
                          )}
                        </td>
                        <td className={tdNum}>{fmtPct(d.apr)}</td>
                        <td className={tdNum}>
                          <div>{fmtMoney(d.balance)}</div>
                          {/* (#421) The displayed balance already nets tagged
                              payments the creditor hasn't reflected; the hint
                              shows the delta and the arithmetic. */}
                          <DebtPendingHint debt={dbt} fmt={fmtMoney} />
                        </td>
                        <td className={tdNum}>{fmtMoney(d.minPayment)}</td>
                        <td className={td}>{dueChip}</td>
                        <td className={cn(tdNum, "whitespace-nowrap text-neutral-500")}>
                          {k ? fmtMonth(k.date) : "—"}
                        </td>
                        <td className={cn(tdNum, "text-neutral-500")}>
                          {fmtMoney(dailyInterest(d))}
                        </td>
                        <td
                          className={cn(td, "whitespace-nowrap text-right")}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              className={btnLink}
                              onClick={(e) => {
                                e.stopPropagation();
                                setPaying(dbt);
                              }}
                            >
                              Pay
                            </button>
                            <DebtPlaidActions debt={dbt} onEdit={() => setEditing(dbt)} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {sortedActive.length > 0 && (
                  <tfoot>
                    <tr className="bg-platinum-3 font-semibold">
                      <td className={cn(td, "text-micro uppercase tracking-wide text-neutral-500")} colSpan={2}>
                        Totals
                      </td>
                      <td className={tdNum}>{fmtMoney(totalBalance)}</td>
                      <td className={tdNum}>{fmtMoney(totalMin)}</td>
                      <td className={td} colSpan={4} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <Foot>Click a row for its month-by-month payoff schedule.</Foot>
          </div>
        </TabsContent>

        <TabsContent value="projection" className="mt-4 space-y-4">
          <div className={card}>
            <div className={cardHead}>
              <span className="text-title font-semibold text-brand-navy">What-if extra</span>
              <span className="ml-auto font-mono text-label font-semibold tabular-nums text-brand-navy">
                +{fmtMoney(whatIf)}
              </span>
            </div>
            <div className="space-y-2 p-4">
              <Slider
                min={0}
                max={2000}
                step={25}
                value={[whatIf]}
                onValueChange={([v]) => setWhatIf(v ?? 0)}
              />
              <div className="text-micro text-neutral-400">
                {whatIf > 0 && whatIfInterestSaved > 0 ? (
                  <>
                    Adding {fmtMoney(whatIf)}/mo saves{" "}
                    <span className="font-mono tabular-nums text-neutral-600">
                      {fmtMoney(whatIfInterestSaved)}
                    </span>
                    {whatIfMonthsSaved > 0 ? <> and {whatIfMonthsSaved} mo</> : null} vs your
                    baseline of {fmtMoney(resolvedExtraAmount)}/mo
                  </>
                ) : (
                  <>Drag to test a bigger extra payment.</>
                )}
              </div>
            </div>
          </div>

          <div className={card}>
            <div className={cardHead}>
              <span className="text-title font-semibold text-brand-navy">Schedule</span>
              <span className="text-micro uppercase tracking-wide text-neutral-400">
                Month by month
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Month</th>
                    <th className={th}>Target</th>
                    <th className={cn(th, "text-right")}>Interest</th>
                    <th className={cn(th, "text-right")}>Mins</th>
                    <th className={cn(th, "text-right")}>Extra</th>
                    <th className={cn(th, "text-right")}>Balance end</th>
                    <th className={th}>Killed</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllMonths ? sim.months : sim.months.slice(0, 24)).map((m) => (
                    <tr key={m.monthIndex}>
                      <td className={cn(td, "whitespace-nowrap font-mono text-label tabular-nums")}>
                        {fmtMonth(m.date)}
                      </td>
                      <td className={cn(td, "text-neutral-500")}>
                        {m.targets.length === 0 ? (
                          m.activeTargetName ?? "—"
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {m.targets.map((t) => (
                              <span
                                key={t.id}
                                className={cn(
                                  t.killedThisMonth && "line-through decoration-neutral-400",
                                )}
                                title={
                                  t.killedThisMonth
                                    ? `Paid off this month (+${fmtMoney(t.extraPaid)} extra)`
                                    : `+${fmtMoney(t.extraPaid)} extra`
                                }
                              >
                                {t.name}
                                {t.extraPaid > 0 ? ` +${fmtMoney(t.extraPaid)}` : ""}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className={tdNum}>{fmtMoney(m.totalInterest)}</td>
                      <td className={tdNum}>{fmtMoney(m.totalMinsPaid)}</td>
                      <td className={tdNum}>{fmtMoney(m.totalExtraPaid)}</td>
                      <td className={tdNum}>{fmtMoney(m.totalBalanceEnd)}</td>
                      <td className={cn(td, "text-micro text-neutral-500")}>
                        {m.killedThisMonth.map((k) => k.name).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sim.months.length > 24 && (
              <div className="border-t border-brand-line p-3 text-center">
                <button
                  type="button"
                  className={btnLink}
                  onClick={() => setShowAllMonths((s) => !s)}
                >
                  {showAllMonths ? "Show first 24 months" : `Show all ${sim.months.length} months`}
                </button>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="chart" className="mt-4">
          <div className={card}>
            <div className={cardHead}>
              <span className="text-title font-semibold text-brand-navy">Payoff projection</span>
              <Help className="ml-auto">
                Balance left is what you still owe at the end of each month;
                interest paid is the running total of interest since today. Both
                come from the same simulation the schedule table lists.
              </Help>
            </div>
            <div className="p-4">
              <LineTrend
                data={chartData}
                xKey="month"
                lines={chartLines}
                height={320}
                fmt="usd"
                labelMode="none"
                ariaLabel="Remaining balance and cumulative interest by month"
              />
            </div>
          </div>
        </TabsContent>

        {archivedDebts.length > 0 && (
          <TabsContent value="archived" className="mt-4">
            <div className={card}>
              <div className={cardHead}>
                <span className="text-title font-semibold text-brand-navy">Archived</span>
              </div>
              <table className="w-full">
                <tbody>
                  {archivedDebts.map((d) => (
                    <tr key={d.id}>
                      <td className={td}>{d.name}</td>
                      {/* (C10) Netted like every other balance cell in the app —
                          an archived row is still a debt row, and a reader
                          comparing it to the active table must not find two
                          bases side by side. */}
                      <td className={tdNum}>{fmtMoney(effectiveDebtBalance(d))}</td>
                      <td className={cn(td, "text-right")}>
                        <button
                          type="button"
                          className={btnLink}
                          onClick={() => handleSave(d.id, { status: "active" })}
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                title: `${payingDebt.name} is paid off`,
                description: "Archived automatically. The next target is set.",
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
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{drillDebt?.name} — payoff schedule</DialogTitle>
          </DialogHeader>
          {drillDebt && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3">
                <Stat
                  label="If min only"
                  value={(() => {
                    const m = monthsIfMinOnly(debtToSim(drillDebt));
                    return m === null ? "Never" : `${m} mo`;
                  })()}
                  hint="minimum < interest never clears"
                />
                <Stat
                  label="Min-only interest"
                  value={(() => {
                    const i = interestIfMinOnly(debtToSim(drillDebt));
                    return i === null ? "—" : fmtMoney(i);
                  })()}
                  tone="bad"
                />
                <Stat
                  label="Interest / day"
                  value={fmtMoney(dailyInterest(debtToSim(drillDebt)))}
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={th}>Month</th>
                      <th className={cn(th, "text-right")}>Start</th>
                      <th className={cn(th, "text-right")}>Interest</th>
                      <th className={cn(th, "text-right")}>Min</th>
                      <th className={cn(th, "text-right")}>Extra</th>
                      <th className={cn(th, "text-right")}>End</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillSchedule.map((r, i) => (
                      <tr key={i} className={cn(r.paidOff && "bg-platinum-3 font-medium")}>
                        <td className={cn(td, "whitespace-nowrap font-mono text-label tabular-nums")}>
                          {fmtMonth(r.date)}
                        </td>
                        <td className={tdNum}>{fmtMoney(r.startBalance)}</td>
                        <td className={cn(tdNum, "text-bad")}>{fmtMoney(r.interest)}</td>
                        <td className={tdNum}>{fmtMoney(r.minPaid)}</td>
                        <td className={tdNum}>{fmtMoney(r.extraPaid)}</td>
                        <td className={tdNum}>{r.paidOff ? fmtMoney(0) : fmtMoney(r.endBalance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/** A two-option segmented control. Flat, hairline-ringed, navy when chosen. */
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
    <div className="grid grid-cols-2 gap-1 rounded-control bg-platinum-3 p-1 ring-1 ring-brand-line">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              "press rounded-control px-3 py-1.5 text-left",
              active ? "bg-brand-navy text-white" : "text-neutral-600 hover:bg-white",
            )}
          >
            <div className="text-body font-semibold leading-tight">{opt.label}</div>
            <div
              className={cn(
                "mt-0.5 text-micro uppercase tracking-wide",
                active ? "text-white/70" : "text-neutral-400",
              )}
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
        </DialogHeader>
        {initial?.plaidAccountId ? (
          <p className="rounded-control bg-bad-bg px-3 py-2 text-micro text-neutral-600 ring-1 ring-bad/25">
            Linked to Plaid. Editing balance, APR or minimum switches that field
            to a manual override and stops auto-syncing it.
          </p>
        ) : null}
        <div>
          <Field label="Creditor">
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="APR (%)">
              <input
                className={input}
                type="number"
                step="0.01"
                value={aprPct}
                onChange={(e) => setAprPct(e.target.value)}
              />
            </Field>
            <Field label="Type">
              <input
                className={input}
                value={type}
                placeholder="card, loan, …"
                onChange={(e) => setType(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Balance ($)">
              <input
                className={input}
                type="number"
                step="0.01"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
              />
            </Field>
            <Field label="Min payment ($)">
              <input
                className={input}
                type="number"
                step="0.01"
                value={minPayment}
                onChange={(e) => setMinPayment(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Due day (1-31)">
            <input
              className={input}
              type="number"
              min="1"
              max="31"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
            />
          </Field>
          <Field label="Notes">
            <input className={input} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {onArchive && (
              <button type="button" className={btnLink} onClick={onArchive}>
                Archive
              </button>
            )}
            {onDelete && (
              <button type="button" className={btnLinkDanger} onClick={onDelete} aria-label="Delete debt">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnSecondary} onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={btn}
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
            </button>
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

/** Days-to-due as a `.chip`. The label is the state — "overdue" / "today" /
 *  "12d" — so the tone only reinforces what the word already says. */
function renderDueChip(dueDay: number | null) {
  const days = daysUntilDue(dueDay);
  if (days === null) {
    return <span className="text-micro text-neutral-400">—</span>;
  }
  const tone = days <= 2 ? "bad" : days <= 13 ? "warn" : "ok";
  const label = days < 0 ? "overdue" : days === 0 ? "today" : `${days}d`;
  return <span className={`chip ${tone}`}>{label}</span>;
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
        <table className="w-full">
          <tbody>
            <tr>
              <td className={cn(td, "text-neutral-500")}>Current balance</td>
              {/* Same netted basis as the row this dialog was opened from —
                  it used to print the RAW balance, so the dialog contradicted
                  the table one click away from it. */}
              <td className={tdNum}>
                {debt ? fmtMoney(effectiveDebtBalance(debt)) : "—"}
                {debt ? <DebtPendingHint debt={debt} fmt={fmtMoney} /> : null}
              </td>
            </tr>
            <tr>
              <td className={cn(td, "text-neutral-500")}>Minimum</td>
              <td className={tdNum}>{fmtMoney(min)}</td>
            </tr>
            {isTarget && recommendedTopUp > 0 && (
              <tr>
                <td className={cn(td, "text-neutral-500")}>Avalanche top-up</td>
                <td className={cn(tdNum, "text-brand-navy")}>+{fmtMoney(recommendedTopUp)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div>
          {isTarget && recommendedTopUp > 0 && (
            <label className="mb-3 flex items-center gap-2 text-body text-neutral-600">
              <input
                type="checkbox"
                checked={payExtra}
                onChange={(e) => togglePayExtra(e.target.checked)}
              />
              Pay extra ({fmtMoney(min + recommendedTopUp)})
            </label>
          )}
          <Field label="Amount ($)">
            <input
              className={input}
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <input
                className={input}
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
              />
            </Field>
            <Field label="Account">
              <input
                className={input}
                value={account}
                placeholder="e.g. Checking"
                onChange={(e) => setAccount(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Notes">
            <input className={input} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <button type="button" className={btnSecondary} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={btn}
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
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { DebtBalanceHistoryEntry } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { Trophy, Calendar, TrendingDown } from "lucide-react";
import {
  H2_PALETTE,
  CHART_SERIES,
  fmtMonthLabel,
  debtToSim,
  payoffStackedSeries,
  snowballWaterfall,
  interestVsPrincipal,
  perDebtProgress,
  totalPaidOffSoFar,
  totalBalanceHistory,
  debtsKilledOrder,
  debtFreeCountdown,
  totalsForDebts,
  simulate,
  interestIfMinimumsOnly,
  payoffProjectionGauge,
} from "@/lib/reportsAnalytics";
import {
  ResponsiveContainer,
  AreaChart,
  BarChart,
  CartesianGrid,
  Area,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  fireMilestoneConfetti,
  HeroTile,
  SectionHeader,
  ChartCard,
  tooltipMoney,
  tooltipStyle,
} from "./shared";

export function DebtSection({
  debts,
  balanceHistory,
  strategy,
  extraPerMonth,
  today,
}: {
  debts: import("@workspace/api-client-react").Debt[];
  balanceHistory: DebtBalanceHistoryEntry[];
  strategy: "avalanche" | "snowball";
  extraPerMonth: number;
  today: Date;
}) {
  const simDebts = useMemo(() => debts.map(debtToSim), [debts]);
  const sim = useMemo(
    () => simulate({ debts: simDebts, extraPerMonth, strategy }),
    [simDebts, extraPerMonth, strategy],
  );
  const { totalBalance, totalMin } = useMemo(() => totalsForDebts(debts), [debts]);

  const countdown = useMemo(() => debtFreeCountdown(sim, today), [sim, today]);
  const stacked = useMemo(
    () => payoffStackedSeries(sim, simDebts.filter((d) => (d.status ?? "active") === "active")),
    [sim, simDebts],
  );
  const waterfall = useMemo(() => snowballWaterfall(sim), [sim]);
  const ipBars = useMemo(() => interestVsPrincipal(sim, 24), [sim]);
  const killed = useMemo(() => debtsKilledOrder(sim), [sim]);
  const progress = useMemo(
    () => perDebtProgress(debts, sim, balanceHistory),
    [debts, sim, balanceHistory],
  );
  const totalPaid = useMemo(
    () => totalPaidOffSoFar(debts, balanceHistory),
    [debts, balanceHistory],
  );
  const pastBalanceCurve = useMemo(
    () => totalBalanceHistory(debts, balanceHistory),
    [debts, balanceHistory],
  );
  const minOnlyInterest = useMemo(() => interestIfMinimumsOnly(simDebts), [simDebts]);
  const interestSaved =
    Number.isFinite(minOnlyInterest) && minOnlyInterest > sim.totalInterestPaid
      ? minOnlyInterest - sim.totalInterestPaid
      : 0;
  const gauge = useMemo(() => payoffProjectionGauge(sim, 12), [sim]);
  const [gaugeFill, setGaugeFill] = useState(0);
  useEffect(() => {
    setGaugeFill(0);
    const id = window.setTimeout(() => setGaugeFill(totalPaid.pct), 80);
    return () => window.clearTimeout(id);
  }, [totalPaid.pct]);

  // Confetti when entering this tab if we project a kill within 30 days.
  const confettiFiredRef = useRef(false);
  useEffect(() => {
    if (confettiFiredRef.current) return;
    if (!countdown.date) return;
    const next = sim.killedOrder[0];
    if (next) {
      const days = Math.floor((next.date.getTime() - today.getTime()) / 86_400_000);
      if (days >= 0 && days <= 30) {
        fireMilestoneConfetti();
        confettiFiredRef.current = true;
      }
    }
  }, [countdown.date, sim.killedOrder, today]);

  const activeDebts = simDebts.filter((d) => (d.status ?? "active") === "active");
  const maxMonthsLeft = Math.max(
    1,
    ...progress.map((p) => p.monthsLeft ?? sim.monthsToFreedom),
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Debt Payoff"
        title="The road to debt-free"
        blurb="Watch each balance fall, the snowball roll, and the finish line crawl closer."
      />

      {/* Hero tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile
          label="Total debt"
          value={formatCurrency(totalBalance)}
          sub={`${activeDebts.length} active`}
          tone="bad"
          icon={<TrendingDown className="w-4 h-4" />}
        />
        <HeroTile
          label="Months to debt-free"
          value={countdown.months !== null ? String(countdown.months) : "∞"}
          sub={
            countdown.date
              ? `${(countdown.months! / 12).toFixed(1)} yrs`
              : "raise extra to escape"
          }
          tone="amber"
          icon={<Calendar className="w-4 h-4" />}
        />
        <HeroTile
          label="Debt-free date"
          value={countdown.date ? fmtMonthLabel(countdown.date) : "—"}
          sub={countdown.days !== null ? `~${countdown.days} days` : "—"}
          tone="good"
          icon={<Trophy className="w-4 h-4" />}
        />
        <HeroTile
          label="Interest avoided vs minimums"
          value={
            Number.isFinite(minOnlyInterest)
              ? formatCurrency(interestSaved)
              : "∞"
          }
          sub={`vs ${formatCurrency(sim.totalInterestPaid)} on plan`}
          tone="good"
        />
      </div>

      {/* Debt thermometer + per-debt progress rings */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="rounded-lg lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-display">Debt thermometer</CardTitle>
            <p className="text-xs text-muted-foreground">
              How much of your starting total balance you've paid off since you
              began tracking.
            </p>
          </CardHeader>
          <CardContent className="flex items-center justify-center pt-2">
            <div className="flex items-center gap-5">
              <div className="relative w-12 h-56 rounded-full bg-muted overflow-hidden border border-border">
                <div
                  className="absolute inset-x-0 bottom-0 transition-[height] duration-[1400ms] ease-out"
                  style={{
                    height: `${gaugeFill}%`,
                    background: `linear-gradient(to top, ${H2_PALETTE.red}, ${H2_PALETTE.amber}, ${H2_PALETTE.primary})`,
                  }}
                />
                <div className="absolute inset-x-0 bottom-2 w-3 h-3 rounded-full bg-negative mx-auto shadow" />
              </div>
              <div>
                <div className="text-4xl font-bold tabular-nums">
                  {totalPaid.pct.toFixed(1)}%
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {formatCurrency(totalPaid.paidOff)} of{" "}
                  {formatCurrency(totalPaid.startingBalance)} paid
                </div>
                <div className="text-[11px] text-muted-foreground mt-1 italic">
                  {totalPaid.trackingSince
                    ? `since ${totalPaid.trackingSince}`
                    : "tracking starts today"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-2">
                  Plan projects {gauge.pct.toFixed(0)}% more in the next 12 mo.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-display">
              Per-debt progress rings
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Filled fraction = % of each debt's starting balance you've
              already paid off since tracking began.
            </p>
          </CardHeader>
          <CardContent>
            {progress.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">
                All clear — no debts to track yet.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {progress.map((p, i) => {
                  const color = CHART_SERIES[i % CHART_SERIES.length];
                  const paidPct = Math.round(p.paidPct);
                  const circ = 2 * Math.PI * 26;
                  const dash = (paidPct / 100) * circ;
                  return (
                    <div key={p.id} className="text-center">
                      <div className="relative inline-block">
                        <svg width="72" height="72" viewBox="0 0 72 72">
                          <circle
                            cx="36"
                            cy="36"
                            r="26"
                            fill="none"
                            stroke="hsl(var(--muted))"
                            strokeWidth="8"
                          />
                          <circle
                            cx="36"
                            cy="36"
                            r="26"
                            fill="none"
                            stroke={color}
                            strokeWidth="8"
                            strokeLinecap="round"
                            strokeDasharray={`${dash} ${circ}`}
                            transform="rotate(-90 36 36)"
                            style={{ transition: "stroke-dasharray 900ms ease-out" }}
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center text-xs font-mono tabular-nums">
                          {paidPct}%
                        </div>
                      </div>
                      <div className="text-[11px] font-medium truncate mt-1">
                        {p.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground tabular-nums">
                        paid {formatCurrency(p.paidOff)} of{" "}
                        {formatCurrency(p.startingBalance)}
                      </div>
                      <div className="text-[10px] text-muted-foreground tabular-nums">
                        {p.monthsLeft !== null ? `${p.monthsLeft} mo left` : "∞"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Real past curve, then projected timeline */}
      <ChartCard
        title="Total balance — actual history"
        caption={
          pastBalanceCurve.length > 1
            ? "Total household debt over time, trending down as you pay off. Balances before a debt was linked are approximated, and the final point reflects current balances (paid-off debts drop to $0)."
            : "We're collecting daily snapshots — the curve fills in as you pay down."
        }
        empty={
          pastBalanceCurve.length === 0
            ? "All clear — no history yet. The projection below shows where you're headed."
            : null
        }
        hideWhenEmpty
        height={220}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={pastBalanceCurve}
            margin={{ top: 10, right: 16, bottom: 16, left: 0 }}
          >
            <defs>
              <linearGradient id="past-balance" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={H2_PALETTE.primary} stopOpacity={0.7} />
                <stop offset="100%" stopColor={H2_PALETTE.primary} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => tooltipMoney(v)}
            />
            <Area
              type="monotone"
              dataKey="total"
              stroke={H2_PALETTE.primary}
              fill="url(#past-balance)"
              strokeWidth={2}
              name="Total balance"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Stacked payoff timeline */}
      <ChartCard
        title="Payoff timeline"
        caption="Stacked balance per debt over time. Each layer disappears as that debt is killed."
        empty={
          activeDebts.length === 0 ? "All clear — no active debts to project." : null
        }
        hideWhenEmpty
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={stacked} margin={{ top: 10, right: 16, bottom: 16, left: 0 }}>
            <defs>
              {activeDebts.map((d, i) => (
                <linearGradient
                  key={d.id}
                  id={`payoff-${d.id}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={CHART_SERIES[i % CHART_SERIES.length]}
                    stopOpacity={0.85}
                  />
                  <stop
                    offset="100%"
                    stopColor={CHART_SERIES[i % CHART_SERIES.length]}
                    stopOpacity={0.25}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => tooltipMoney(v)}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {activeDebts.map((d, i) => (
              <Area
                key={d.id}
                type="monotone"
                dataKey={d.name}
                stackId="1"
                stroke={CHART_SERIES[i % CHART_SERIES.length]}
                fill={`url(#payoff-${d.id})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Snowball waterfall"
          caption="Freed-up minimums roll into the next debt as each one falls."
          empty={waterfall.length === 0 ? "All clear — no projected payoffs in this window." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={waterfall} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="freed" fill={H2_PALETTE.amber} name="Freed this kill" radius={[6, 6, 0, 0]} />
              <Bar dataKey="cumulative" fill={H2_PALETTE.primary} name="Snowball total" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Interest vs principal"
          caption="Stacked monthly payment split. The interest slice should shrink as smaller debts die."
          empty={ipBars.length === 0 ? "All clear — no projection to draw yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={ipBars} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} interval={2} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="principal" stackId="1" fill={H2_PALETTE.primary} name="Principal" />
              <Bar dataKey="interest" stackId="1" fill={H2_PALETTE.red} name="Interest" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Killed milestones */}
        <ChartCard
          title="Debts killed — milestone timeline"
          caption="Projected payoff date for every debt, in order."
          empty={killed.length === 0 ? "All clear — no projected payoffs yet." : null}
          hideWhenEmpty
          height={Math.max(220, 60 + killed.length * 40)}
        >
          <div className="relative h-full overflow-y-auto pr-1">
            <div className="absolute left-4 top-2 bottom-2 w-px bg-border" />
            <ul className="space-y-3 py-1">
              {killed.map((k) => (
                <li key={`${k.name}-${k.monthIndex}`} className="relative pl-10">
                  <div className="absolute left-2 top-1.5 w-5 h-5 rounded-full bg-[hsl(45_95%_50%)] border-4 border-background flex items-center justify-center">
                    <Trophy className="w-2.5 h-2.5 text-[hsl(202_55%_32%)]" />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-sm">{k.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Month {k.monthIndex} · {k.label}
                      </div>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      #{k.rank}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>

        {/* Per-debt months-to-payoff bars */}
        <ChartCard
          title="Per-debt months remaining"
          caption="How long each balance has left at your current plan. Shorter = closer to done."
          empty={progress.length === 0 ? "All clear — no active debts on the books." : null}
          hideWhenEmpty
          height={Math.max(220, 40 + progress.length * 36)}
        >
          <div className="space-y-3 h-full overflow-y-auto pr-1">
            {progress.map((p, i) => {
              const fill = CHART_SERIES[i % CHART_SERIES.length];
              const widthPct =
                p.monthsLeft !== null
                  ? Math.max(4, (p.monthsLeft / maxMonthsLeft) * 100)
                  : 100;
              return (
                <div key={p.id}>
                  <div className="flex items-baseline justify-between text-xs mb-1">
                    <div className="font-medium truncate">{p.name}</div>
                    <div className="font-mono tabular-nums text-muted-foreground">
                      {p.monthsLeft !== null ? `${p.monthsLeft} mo` : "∞"}
                      {" · "}
                      {formatCurrency(p.balance)}
                    </div>
                  </div>
                  <div className="h-3 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${widthPct}%`, background: fill }}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {p.payoffDate ? `payoff: ${fmtMonthLabel(p.payoffDate)}` : "won't pay off in window"}
                    {" · "}
                    {(p.apr * 100).toFixed(2)}% APR · min {formatCurrency(p.minPayment)}
                  </div>
                </div>
              );
            })}
          </div>
        </ChartCard>
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        Projection assumes total monthly payment of{" "}
        {formatCurrency(totalMin + extraPerMonth)} ({formatCurrency(totalMin)}{" "}
        minimums + {formatCurrency(extraPerMonth)} extra), strategy:{" "}
        {strategy === "avalanche" ? "avalanche (highest APR first)" : "snowball (smallest balance first)"}.
      </p>
    </div>
  );
}

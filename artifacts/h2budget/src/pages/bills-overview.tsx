import { useMemo } from "react";
import { ArrowUpCircle, ArrowDownCircle, Sparkles, Repeat, Wallet } from "lucide-react";
import {
  useGetBillsSummary,
  getGetBillsSummaryQueryKey,
  useGetBillsInsightsSummary,
  getGetBillsInsightsSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader, RingMeter, Callout } from "@/components/stat";
import { MiniBars, StackBar } from "@/components/viz";
import { StatTile } from "@/components/stat-tile";
import { formatCurrency } from "@/lib/utils";

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Bills → Overview tab. A clean, at-a-glance read on the month's money: income,
 * recurring bills, debt minimums, one-off spend, and where Fable 5 thinks we
 * could save. Every figure is computed server-side (`/bills/summary` +
 * `/bills/insights-summary`); Fable 5 only writes the savings language.
 */
export default function BillsOverviewPage() {
  const { data: summary } = useGetBillsSummary(undefined, {
    query: { queryKey: getGetBillsSummaryQueryKey(), staleTime: 5 * 60_000 },
  });
  const { data: insight } = useGetBillsInsightsSummary(undefined, {
    query: {
      queryKey: getGetBillsInsightsSummaryQueryKey(),
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
    },
  });

  const m = summary?.monthly;
  const income = num(m?.income);
  const bills = num(m?.bills);
  const debtMin = num(m?.debtMin);
  const outflow = num(m?.totalOutflow);
  const net = num(m?.net);
  const oneOff = insight?.oneOffTotal ?? 0;

  const topBills = useMemo(
    () =>
      (summary?.bills ?? [])
        .map((r) => ({ name: r.item.name, monthly: num(r.monthlyAmount) }))
        .filter((b) => b.monthly > 0)
        .sort((a, b) => b.monthly - a.monthly)
        .slice(0, 6),
    [summary],
  );

  const outflowRatio = income > 0 ? outflow / income : 0;
  const netStatus = net >= 0 ? "good" : "danger";

  return (
    <div className="space-y-4" data-testid="bills-overview">
      <SectionHeader
        eyebrow="Bills"
        title="Overview"
        sub="Your month at a glance — income in, bills out, and where to save."
      />

      {/* Fable 5 savings read */}
      <Callout
        tone={net >= 0 ? "good" : "warning"}
        icon={<Sparkles className="h-4 w-4" />}
      >
        <div className="space-y-1.5">
          <div className="text-[15px] font-bold tracking-tight leading-snug">
            {insight?.headline ?? "Reading your bills…"}
          </div>
          {insight?.bullets?.length ? (
            <ul className="space-y-1 text-[13px] font-normal text-muted-foreground">
              {insight.bullets.map((b, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
                  <span className="leading-snug">{b}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Callout>

      {/* Hero KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Income"
          value={formatCurrency(income)}
          sub="/ month"
          icon={<ArrowUpCircle />}
        />
        <StatTile
          label="Recurring bills"
          value={formatCurrency(bills)}
          sub={`+ ${formatCurrency(debtMin)} debt minimums`}
          icon={<Repeat />}
        />
        <StatTile
          label="One-off this month"
          value={formatCurrency(oneOff)}
          sub={`${insight?.oneOffCount ?? 0} non-recurring charges`}
          icon={<Wallet />}
        />
        <StatTile
          label="Net"
          value={formatCurrency(net)}
          sub={net >= 0 ? "kept each month" : "short each month"}
          icon={<ArrowDownCircle />}
        />
      </div>

      {/* Graphics */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Income vs outflow ring */}
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 p-5">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Income vs outflow
            </div>
            <RingMeter
              ratio={outflowRatio}
              status={netStatus}
              centerTop={formatCurrency(net)}
              centerBottom={net >= 0 ? "net / mo" : "short / mo"}
              size={132}
              stroke={11}
            />
            <div className="text-center text-xs text-muted-foreground">
              {formatCurrency(outflow)} out of {formatCurrency(income)} in —{" "}
              {income > 0 ? Math.round(outflowRatio * 100) : 0}% committed
            </div>
          </CardContent>
        </Card>

        {/* Top recurring bills */}
        <Card className="lg:col-span-2">
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Biggest recurring bills
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                per month
              </div>
            </div>
            {topBills.length ? (
              <>
                <MiniBars
                  data={topBills.map((b) => ({
                    value: b.monthly,
                    label: `${b.name}: ${formatCurrency(b.monthly)}`,
                    color: "hsl(var(--chart-1))",
                  }))}
                  height={72}
                />
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                  {topBills.map((b) => (
                    <div key={b.name} className="flex justify-between gap-2">
                      <span className="truncate text-muted-foreground">{b.name}</span>
                      <span className="shrink-0 font-semibold tabular-nums">
                        {formatCurrency(b.monthly)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No recurring bills yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Where the outflow goes */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Where the money goes
          </div>
          <StackBar
            segments={[
              { label: "Recurring bills", value: bills, color: "hsl(var(--chart-1))" },
              { label: "Debt minimums", value: debtMin, color: "hsl(var(--negative))" },
              { label: "One-off", value: oneOff, color: "hsl(var(--warning))" },
            ]}
            height={14}
            money
          />
        </CardContent>
      </Card>
    </div>
  );
}

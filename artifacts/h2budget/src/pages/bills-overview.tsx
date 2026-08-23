import { useMemo } from "react";
import { ArrowUpCircle, ArrowDownCircle, Repeat } from "lucide-react";
import {
  useGetBillsSummary,
  getGetBillsSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader, RingMeter } from "@/components/stat";
import { StackBar } from "@/components/viz";
import { StatTile } from "@/components/stat-tile";
import { formatCurrency } from "@/lib/utils";

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Bills → Overview tab. A clean, at-a-glance read on the month's money: income,
 * recurring bills, debt minimums, and net. Every figure is computed
 * server-side (`/bills/summary`).
 */
export default function BillsOverviewPage() {
  const { data: summary } = useGetBillsSummary(undefined, {
    query: { queryKey: getGetBillsSummaryQueryKey(), staleTime: 5 * 60_000 },
  });

  const m = summary?.monthly;
  const income = num(m?.income);
  const bills = num(m?.bills);
  const debtMin = num(m?.debtMin);
  const outflow = num(m?.totalOutflow);
  const net = num(m?.net);

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
        sub="Your month at a glance — income in, bills out."
      />

      {/* Hero KPIs */}
      <div className="stagger-children grid grid-cols-2 gap-3 lg:grid-cols-3">
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
          label="Net"
          value={formatCurrency(net)}
          sub={net >= 0 ? "kept each month" : "short each month"}
          icon={<ArrowDownCircle />}
        />
      </div>

      {/* Graphics */}
      <div className="stagger-children grid gap-4 lg:grid-cols-3">
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
              size={120}
              stroke={8}
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
              (() => {
                const max = Math.max(...topBills.map((b) => b.monthly), 1);
                return (
                  <div className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                    {topBills.map((b) => (
                      <div key={b.name}>
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                          <span className="truncate text-muted-foreground">{b.name}</span>
                          <span className="shrink-0 font-semibold tabular-nums text-foreground">
                            {formatCurrency(b.monthly)}
                          </span>
                        </div>
                        {/* Thin proportional meter — quiet magnitude, no slabs. */}
                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full transition-[width] duration-700 ease-out"
                            style={{
                              width: `${(b.monthly / max) * 100}%`,
                              background: "hsl(var(--chart-1))",
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()
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
            ]}
            height={10}
            money
          />
        </CardContent>
      </Card>
    </div>
  );
}

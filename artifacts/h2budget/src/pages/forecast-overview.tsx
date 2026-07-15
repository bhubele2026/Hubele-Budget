import { useMemo } from "react";
import { Wallet, TrendingDown, CalendarClock, Landmark } from "lucide-react";
import {
  useGetForecastCashSignal,
  getGetForecastCashSignalQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader, RingMeter } from "@/components/stat";
import { Sparkline, MiniBars, StackBar } from "@/components/viz";
import { StatTile } from "@/components/stat-tile";
import { formatCurrency } from "@/lib/utils";

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Forecast → Overview tab. A graphics-first cash-flow snapshot: where the money
 * sits today, the projected low point, and runway. Every figure comes from the
 * server cash-signal endpoint.
 */
export default function ForecastOverviewPage() {
  const { data: signal } = useGetForecastCashSignal(
    { horizonDays: 90 },
    {
      query: {
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        staleTime: 5 * 60_000,
      },
    },
  );

  const bankToday = num(signal?.bankToday);
  const lowest = num(signal?.lowestProjected);
  const buffer = num(signal?.cashBuffer);
  const ending = num(signal?.endingBalance);
  const income = num(signal?.projectedIncome);
  const expenses = num(signal?.projectedExpenses);
  const status = signal?.status ?? "no_data";

  const daily = signal?.daily ?? [];
  const dailyValues = useMemo(() => daily.map((d) => num(d.balance)), [daily]);

  // Runway = days until the projected balance first goes negative.
  const runwayDays = useMemo(() => {
    if (!daily.length) return null;
    const first = daily[0].date;
    for (const d of daily) if (num(d.balance) < 0) return daysBetween(first, d.date);
    return null;
  }, [daily]);

  // Upcoming big bills — biggest expense events in the window.
  const bigBills = useMemo(
    () =>
      (signal?.events ?? [])
        .map((e) => ({ label: e.label, amount: num(e.amount), date: e.date }))
        .filter((e) => e.amount < 0)
        .sort((a, b) => a.amount - b.amount) // most negative first
        .slice(0, 6),
    [signal],
  );

  const lowStatus =
    status === "ready" ? "good" : status === "tight" ? "warning" : "danger";
  const lowRatio = buffer > 0 ? Math.max(0, Math.min(1, lowest / (buffer * 2))) : 0.5;

  return (
    <div className="space-y-4" data-testid="forecast-overview">
      <SectionHeader
        eyebrow="Forecast"
        title="Overview"
        sub="Where your cash is headed over the next 90 days."
      />

      {/* Hero KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Bank today"
          value={formatCurrency(bankToday)}
          sub="checking balance"
          icon={<Wallet />}
        />
        <StatTile
          label="Projected low"
          value={formatCurrency(lowest)}
          sub={signal?.lowestDate ? `on ${signal.lowestDate}` : "—"}
          icon={<TrendingDown />}
        />
        <StatTile
          label="Ending balance"
          value={formatCurrency(ending)}
          sub="at 90 days"
          icon={<Landmark />}
        />
        <StatTile
          label="Runway"
          value={runwayDays == null ? "Clear" : `${runwayDays} days`}
          sub={runwayDays == null ? "stays positive" : "until negative"}
          icon={<CalendarClock />}
        />
      </div>

      {/* Graphics */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Low point vs buffer ring */}
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 p-5">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Low point vs buffer
            </div>
            <RingMeter
              ratio={lowRatio}
              status={lowStatus}
              centerTop={formatCurrency(lowest)}
              centerBottom="lowest"
              size={132}
              stroke={11}
            />
            <div className="text-center text-xs text-muted-foreground">
              Buffer is {formatCurrency(buffer)} ·{" "}
              {lowest >= buffer ? "above the line" : "dips below"}
            </div>
          </CardContent>
        </Card>

        {/* Projected balance curve */}
        <Card className="lg:col-span-2">
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Projected balance · next 90 days
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {formatCurrency(bankToday)} → {formatCurrency(ending)}
              </div>
            </div>
            {dailyValues.length > 1 ? (
              <Sparkline
                data={dailyValues}
                variant="area"
                color={
                  lowest >= buffer ? "hsl(var(--positive))" : "hsl(var(--negative))"
                }
                height={120}
              />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No projection yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* In vs out + upcoming big bills */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Money in vs out · 90 days
            </div>
            <StackBar
              segments={[
                { label: "Income", value: income, color: "hsl(var(--positive))" },
                { label: "Expenses", value: expenses, color: "hsl(var(--negative))" },
              ]}
              height={14}
              money
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Biggest bills ahead
            </div>
            {bigBills.length ? (
              <>
                <MiniBars
                  data={bigBills.map((b) => ({
                    value: Math.abs(b.amount),
                    label: `${b.label}: ${formatCurrency(Math.abs(b.amount))}`,
                    color: "hsl(var(--chart-1))",
                  }))}
                  height={56}
                />
                <div className="grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-2">
                  {bigBills.slice(0, 6).map((b, i) => (
                    <div key={`${b.label}-${i}`} className="flex justify-between gap-2">
                      <span className="truncate text-muted-foreground">{b.label}</span>
                      <span className="shrink-0 font-semibold tabular-nums">
                        {formatCurrency(Math.abs(b.amount))}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No big bills in the window.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

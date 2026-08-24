import { useMemo } from "react";
import {
  useGetForecastCashSignal,
  getGetForecastCashSignalQueryKey,
} from "@workspace/api-client-react";
import { useSpine } from "@/hooks/useSpine";
import { Sparkline, StackBar } from "@/components/viz";
import { CssBars, type CssBarRow } from "@/lib/cssBars";
import { CHART } from "@/lib/chartTokens";
import { card, cardHead, emptyNote, Foot, Help, Stat } from "@/ui";
import { formatCurrency } from "@/lib/utils";

/**
 * ⭐ FORECAST → OVERVIEW. Where cash stands, where it bottoms out, how long it
 * lasts — four numbers and three quiet panels, on the kit.
 *
 * ⚠️ THE SPINE RULE. Bank today, the cash low point (and its date) and runway
 * all come from `useSpine()` and are NEVER recomputed here — see
 * `hooks/useSpine.ts`. This page used to derive runway itself by walking the
 * daily series for the first negative day, which is exactly how two surfaces
 * come to quote the household two different ways. `forecastOverview.test.tsx`
 * asserts the rendered figures equal the spine's to the character.
 *
 * The cash-signal query stays for the things the spine does not carry — the
 * daily curve, the ending balance, the buffer, and the bill events. Those are
 * detail, not headline, and the endpoint is already cached app-wide.
 *
 * ⚠️ NO RECHARTS ON THIS PAGE. The curve is the dependency-free `Sparkline`
 * (plain inline SVG). Importing `@/lib/charts` here would pull ~450 KB into
 * this 5 KB chunk to draw a 120px preview — the full themed area chart lives
 * one tab over on `/forecast`, where the recharts cost is already paid.
 */

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/** Money for a Stat face. `null` reads as an em dash, never as $0 — a figure
 *  that has not arrived yet must not render as a real balance of zero. */
function money(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? formatCurrency(n) : "—";
}

/** Compact money for the bar list, where the value column is ~96px wide. */
function barMoney(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

/** "Sep 1" from a date-only ISO.
 *  ⚠️ The `T00:00:00` suffix is load-bearing: a bare `new Date("2026-09-01")`
 *  parses as UTC midnight and renders as Aug 31 west of Greenwich. */
function shortDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? undefined
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ForecastOverviewPage() {
  const { data: spine } = useSpine();
  const { data: signal } = useGetForecastCashSignal(
    { horizonDays: 90 },
    {
      query: {
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        staleTime: 5 * 60_000,
      },
    },
  );

  // ── Headline figures: the spine owns these three. ──────────────────────────
  const bankToday = spine?.bank?.balance ?? null;
  const lowPoint = spine?.forecast?.lowPoint ?? null;
  const lowPointDate = spine?.forecast?.lowPointDate ?? null;
  const runwayDays = spine?.forecast?.runwayDays ?? null;

  // ── Detail figures: the spine does not carry these. ────────────────────────
  const buffer = num(signal?.cashBuffer);
  const ending = num(signal?.endingBalance);
  const income = num(signal?.projectedIncome);
  const expenses = num(signal?.projectedExpenses);

  const daily = signal?.daily ?? [];
  const dailyValues = useMemo(() => daily.map((d) => num(d.balance)), [daily]);

  // Biggest outflows in the window, largest first. Same selection the page has
  // always used: expense events only, most negative first, capped at six.
  const billRows = useMemo<CssBarRow[]>(
    () =>
      (signal?.events ?? [])
        .map((e) => ({ label: e.label, amount: num(e.amount), date: e.date }))
        .filter((e) => e.amount < 0)
        .sort((a, b) => a.amount - b.amount)
        .slice(0, 6)
        .map((e, i) => ({
          id: `${e.date}|${e.label}|${i}`,
          label: e.label,
          value: Math.abs(e.amount),
          // ⚠️ The date is load-bearing, not decoration. A recurring bill
          // appears once per OCCURRENCE, so a 90-day window lists "Rent"
          // three times — without the date those read as one bill triplicated
          // rather than three months of rent.
          hint: shortDate(e.date),
        })),
    [signal],
  );

  // The one comparison this page exists to make: does the projection dip under
  // the buffer? Colour reinforces it; the chip's LABEL is what says it.
  const lowNum = lowPoint == null ? null : Number(lowPoint);
  const dipsBelowBuffer = lowNum != null && Number.isFinite(lowNum) && lowNum < buffer;

  return (
    <div className="space-y-4" data-testid="forecast-overview">
      {/* ── The spine row. Three of these four are the shared snapshot. ────── */}
      <div
        data-testid="fo-spine-stats"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <Stat
          index={0}
          data-testid="fo-stat-bank"
          label="Bank today"
          value={money(bankToday)}
          hint="checking"
        />
        {/* ⚠️ The hint SAYS which side of the buffer this lands on. The tone
            below only reinforces it — under this palette a reader who cannot
            separate navy from deep orange must still get the answer. */}
        <Stat
          index={1}
          data-testid="fo-stat-low-point"
          label="Cash low point"
          value={money(lowPoint)}
          tone={dipsBelowBuffer ? "bad" : "navy"}
          hint={`${dipsBelowBuffer ? "under buffer" : "above buffer"}${
            lowPointDate ? ` · ${lowPointDate}` : ""
          }`}
        />
        <Stat
          index={2}
          data-testid="fo-stat-runway"
          label="Runway"
          value={runwayDays == null ? "Clear" : `${runwayDays} days`}
          hint={runwayDays == null ? "stays positive" : "until negative"}
        />
        <Stat
          index={3}
          data-testid="fo-stat-ending"
          label="Ending balance"
          value={money(signal?.endingBalance)}
          hint="at 90 days"
        />
      </div>

      {/* ── The curve ─────────────────────────────────────────────────────── */}
      <section className={card} data-testid="fo-curve">
        <div className={cardHead}>
          <h2 className="text-title font-semibold text-brand-navy">
            Projected balance
          </h2>
          <Help>
            Bank balance rolled forward through every planned bill and income
            event for the next 90 days. Navy is the projection; it is not a
            record of what happened.
          </Help>
          <span className="ml-auto font-mono text-label tabular-nums text-neutral-600">
            {money(bankToday)} → {money(signal?.endingBalance)}
          </span>
        </div>
        {dailyValues.length > 1 ? (
          <>
            <div className="px-4 py-4">
              <Sparkline
                data={dailyValues}
                variant="area"
                color={dipsBelowBuffer ? CHART.orangeDeep : CHART.navy}
                height={128}
              />
            </div>
            <Foot>
              {dipsBelowBuffer
                ? `Dips under the ${formatCurrency(buffer)} buffer on the way.`
                : `Stays above the ${formatCurrency(buffer)} buffer throughout.`}
            </Foot>
          </>
        ) : (
          <div className={emptyNote}>No projection yet.</div>
        )}
      </section>

      {/* ── In vs out, and what is coming ─────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={card} data-testid="fo-in-out">
          <div className={cardHead}>
            <h2 className="text-title font-semibold text-brand-navy">
              Money in vs out
            </h2>
            <Help>
              Totals of every projected income and expense event over the 90-day
              window. Navy is money in, deep orange is money out.
            </Help>
            <span className="ml-auto text-micro uppercase tracking-wider text-neutral-400">
              90 days
            </span>
          </div>
          <div className="px-4 py-4">
            <StackBar
              segments={[
                { label: "In", value: income, color: CHART.navy },
                { label: "Out", value: expenses, color: CHART.orangeDeep },
              ]}
              height={14}
              money
            />
          </div>
        </section>

        <section className={card} data-testid="fo-big-bills">
          <div className={cardHead}>
            <h2 className="text-title font-semibold text-brand-navy">
              Biggest bills ahead
            </h2>
            <Help>
              The six largest single expense events in the 90-day window,
              largest first. Recurring bills appear once per occurrence.
            </Help>
          </div>
          {billRows.length ? (
            <>
              <div className="px-4 py-3">
                <CssBars
                  rows={billRows}
                  topN={6}
                  ramp
                  format={barMoney}
                  labelWidth={150}
                  valueWidth={96}
                  ariaLabel="Biggest bills ahead, largest first"
                />
              </div>
              <Foot>Darkest bar is the largest bill.</Foot>
            </>
          ) : (
            <div className={emptyNote}>No big bills in the window.</div>
          )}
        </section>
      </div>
    </div>
  );
}

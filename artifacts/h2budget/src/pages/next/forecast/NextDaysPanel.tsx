import { useMemo, useState } from "react";
import { Panel } from "@/components/next";
import { formatCurrency } from "@/lib/utils";
import { householdToday } from "@/lib/householdDay";
import { upcomingDays, type BankDayRow, type KindedEvent, type UpcomingDay } from "@/lib/forecastEventKinds";
import type { ForecastNextCtx } from "./types";

/**
 * "Fri, Nov 13" for a YYYY-MM-DD day. Local on purpose: `lib/dates`' `weekdayDate` says the same, but that
 * module sits on the open path, and using its export from here would pull the formatter into the landing
 * chunk (the entry-graph budget). Calendar day, no time zone.
 */
const WEEKDAY_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
function weekdayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? WEEKDAY_DAY.format(new Date(Date.UTC(y, m - 1, d))) : "";
}

/** At most this many names on a line; the rest read "+N more" (the day panel lists them all). */
const NAMES_SHOWN = 3;

function names(xs: string[]): string {
  if (xs.length <= NAMES_SHOWN) return xs.join(", ");
  return `${xs.slice(0, NAMES_SHOWN).join(", ")} +${xs.length - NAMES_SHOWN} more`;
}

function Row({
  r,
  selected,
  onSelect,
  lowestDate,
  days,
}: {
  r: UpcomingDay;
  selected: boolean;
  onSelect: (date: string) => void;
  /** The cash signal's own low day: its row says "Lowest"; another window's low says "Lowest in N days". */
  lowestDate: string | null;
  days: number;
}) {
  const tone = r.belowZero ? "text-bad-ink" : r.underBuffer ? "text-warn" : "text-brand-navy";
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(r.date)}
        aria-pressed={selected}
        data-testid={`next-day-${r.date}`}
        data-lowest={r.lowest ? "true" : undefined}
        data-under-buffer={r.underBuffer ? "true" : undefined}
        data-below-zero={r.belowZero ? "true" : undefined}
        className={`press block w-full border-b border-brand-line/70 px-4 py-2 text-left hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-navy/40 ${
          selected ? "bg-brand-tint ring-1 ring-inset ring-brand-navy/30" : ""
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-label font-semibold text-brand-navy" data-testid={`next-day-date-${r.date}`}>
              {weekdayDate(r.date)}
            </span>
            {r.isToday ? <span className="chip gray">Today</span> : null}
            {r.lowest ? (
              <span className={r.belowZero ? "chip bad" : "chip warn"} data-testid="next-day-lowest">
                {r.date === lowestDate ? "Lowest" : `Lowest in ${days} days`}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <span className={`fig text-label font-semibold ${tone}`} data-testid={`next-day-balance-${r.date}`}>
              {formatCurrency(r.close)}
            </span>
            {r.belowZero ? (
              <span className="text-micro text-bad-ink">below zero</span>
            ) : r.underBuffer ? (
              <span className="text-micro text-warn">under buffer</span>
            ) : null}
          </span>
        </div>
        {r.moneyIn !== 0 ? (
          <div className="mt-0.5 flex min-w-0 gap-1.5 text-micro text-neutral-600" data-testid={`next-day-in-${r.date}`}>
            <span className="shrink-0 font-semibold text-brand-navy">In</span>
            <span className="shrink-0 fig text-foreground">{formatCurrency(r.moneyIn)}</span>
            <span className="min-w-0 truncate" title={r.inNames.join(", ")}>{names(r.inNames)}</span>
          </div>
        ) : null}
        {r.moneyOut !== 0 ? (
          <div className="mt-0.5 flex min-w-0 gap-1.5 text-micro text-neutral-600" data-testid={`next-day-out-${r.date}`}>
            <span className="shrink-0 font-semibold text-neutral-700">Out</span>
            <span className="shrink-0 fig text-neutral-700">{formatCurrency(Math.abs(r.moneyOut))}</span>
            <span className="min-w-0 truncate" title={r.outNames.join(", ")}>{names(r.outNames)}</span>
          </div>
        ) : null}
        {r.moneyIn === 0 && r.moneyOut === 0 ? (
          <div className="mt-0.5 text-micro text-neutral-500">Nothing moves</div>
        ) : null}
      </button>
    </li>
  );
}

/**
 * ⭐ (Readable forecast) NEXT 14 DAYS — "what comes in, what goes out, where it
 * leaves you", one row per day with money moving (and today), read off the
 * same cash signal as the chart: the close is the curve's own, in and out are
 * the day panel's grouping (`upcomingDays`). The lowest day is flagged; a day
 * under the buffer is in the quiet warning tone, below zero in rust, and each
 * says so in words. A row selects its day — the same selection the chart and
 * the day panel use. "Show 30 days" widens it.
 */
export function NextDaysPanel({
  ctx,
  kinded,
  bank,
  selectedDate,
  onSelectDate,
  className,
}: {
  ctx: ForecastNextCtx;
  kinded: KindedEvent[];
  bank: BankDayRow[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  className?: string;
}) {
  const [days, setDays] = useState<14 | 30>(14);
  const today = householdToday();
  const noCurve = ctx.dailySeries.length === 0 || ctx.proj?.status === "no_data";
  const rows = useMemo(
    () =>
      noCurve
        ? []
        : upcomingDays(ctx.dailySeries, kinded, bank, {
            today,
            days,
            buffer: ctx.cashBufferNum,
            lowestDate: ctx.proj?.lowestDate ?? null,
          }),
    [noCurve, ctx.dailySeries, kinded, bank, today, days, ctx.cashBufferNum, ctx.proj?.lowestDate],
  );
  return (
    <Panel
      title={`Next ${days} days`}
      sub="Money in, money out, and the balance after each day"
      span={4}
      variant={["flush", "static"]}
      className={className}
      data-testid="next-days-panel"
      actions={
        <button
          type="button"
          onClick={() => setDays((d) => (d === 14 ? 30 : 14))}
          aria-pressed={days === 30}
          className="press rounded-control px-2.5 py-1 text-micro font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
          data-testid="next-days-toggle"
        >
          {days === 14 ? "Show 30 days" : "Show 14 days"}
        </button>
      }
    >
      {ctx.cashProjectionLoading && ctx.dailySeries.length === 0 ? (
        <p className="px-4 py-3 text-body text-neutral-600">Loading the forecast…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-body text-neutral-600" data-testid="next-days-empty">
          Sync to read the bank balance, or add planned items.
        </p>
      ) : (
        <ul className="lg:max-h-[500px] lg:overflow-y-auto" data-testid="next-days-list" aria-label={`Next ${days} days`}>
          {rows.map((r) => (
            <Row
              key={r.date}
              r={r}
              selected={r.date === selectedDate}
              onSelect={onSelectDate}
              lowestDate={ctx.proj?.lowestDate ?? null}
              days={days}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

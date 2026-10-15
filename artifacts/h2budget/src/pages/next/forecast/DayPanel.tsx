import { useMemo } from "react";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  daySummary,
  MARKER_LABEL,
  type BankDayRow,
  type KindedEvent,
} from "@/lib/forecastEventKinds";
import { buildDraggingPlans, tooltipPlanLine } from "@/lib/forecastPastDue";
import { MARKER } from "@/lib/chartTokens";
import type { ForecastNextCtx } from "./types";

const NO_BANK: BankDayRow[] = [];

const money = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : formatCurrency(n));

function Row({ label, value, tone, testid }: { label: string; value: string; tone?: "bad"; testid?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-micro text-neutral-600">{label}</dt>
      <dd
        data-testid={testid}
        className={`font-mono text-label tabular-nums ${tone === "bad" ? "text-bad" : "text-brand-navy"}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** The selected day: where it opened, what came in and went out by kind (the
 *  counted bank rows included), where it closes, and each item with its
 *  existing actions. ⭐ (T3) Every figure is read off the same series and the
 *  cash signal's `dayItems` (the items the walk applied), so
 *  opening + in − out = close; the first day opens on the curve's own start. */
export function DayPanel({
  ctx,
  kinded,
  bank = NO_BANK,
  selectedDate,
  onClear,
  onOpenRegister,
}: {
  ctx: ForecastNextCtx;
  kinded: KindedEvent[];
  /** (T3) Counted checking rows (`dayItems` kind `bank_row`). */
  bank?: BankDayRow[];
  selectedDate: string | null;
  onClear: () => void;
  /** Make the register visible, then run `then` once it is on screen. */
  onOpenRegister: (then: () => void) => void;
}) {
  const start = ctx.proj?.startingBalance != null ? Number(ctx.proj.startingBalance) : null;
  const sum = useMemo(
    () => (selectedDate ? daySummary(selectedDate, ctx.dailySeries, kinded, { bank, startingBalance: start }) : null),
    [selectedDate, ctx.dailySeries, kinded, bank, start],
  );
  const dragging = useMemo(() => buildDraggingPlans(ctx.proj?.events ?? []), [ctx.proj?.events]);

  if (!selectedDate || !sum) {
    return (
      <p className="text-body text-neutral-600" data-testid="day-panel-empty">
        Pick a day on the chart.
      </p>
    );
  }
  const bufferText = Number.isFinite(ctx.cashBufferNum) ? formatCurrency(ctx.cashBufferNum).replace(/\.00$/, "") : null;
  // (T2) Rust only below zero; under the buffer at or above $0 is a quiet note.
  const belowZero = sum.close != null && sum.close < 0;
  const underBuffer =
    !belowZero && sum.close != null && Number.isFinite(ctx.cashBufferNum) && sum.close < ctx.cashBufferNum;
  const hasBank = sum.bankRows.length > 0;
  return (
    <div data-testid="day-panel" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-label font-semibold text-brand-navy" data-testid="day-panel-date">
          {formatDate(selectedDate)}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="press rounded-control px-2 py-1 text-micro font-semibold text-neutral-600 ring-1 ring-brand-line hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
          data-testid="day-panel-clear"
        >
          Clear
        </button>
      </div>
      {!sum.inWindow && (
        <p className="rounded-control bg-neutral-50 px-3 py-2 text-micro text-neutral-600" data-testid="day-outside-window">
          Outside this window. Widen the horizon to see it.
        </p>
      )}
      <dl className="divide-y divide-brand-line/70">
        <Row label="Opening balance" value={money(sum.opening)} testid="day-opening" />
        <Row label="Money in" value={money(sum.income)} testid="day-income" />
        {/* (T3) Counted bank rows: a line per side only when that side moved (the sum still ties). */}
        {sum.bankIn !== 0 && <Row label="Bank activity in" value={money(sum.bankIn)} testid="day-bank-in" />}
        <Row label="Bills" value={money(sum.outflows.bill)} testid="day-out-bill" />
        <Row label="Card payments" value={money(sum.outflows.card)} testid="day-out-card" />
        <Row label="Debt payments" value={money(sum.outflows.debt)} testid="day-out-debt" />
        {sum.bankOut !== 0 && <Row label="Bank activity out" value={money(sum.bankOut)} testid="day-bank-out" />}
        <Row label="Projected close" value={money(sum.close)} tone={belowZero ? "bad" : undefined} testid="day-close" />
      </dl>
      {belowZero ? (
        <p className="text-micro text-bad" data-testid="day-below-zero">Below zero this day.</p>
      ) : underBuffer && bufferText ? (
        <p className="text-micro text-neutral-600" data-testid="day-under-buffer">Under the {bufferText} buffer.</p>
      ) : null}

      <div>
        <h3 className="text-micro font-semibold uppercase tracking-wide text-neutral-600">Events</h3>
        {sum.events.length === 0 && !hasBank ? (
          <p className="mt-1 text-micro text-neutral-600">Nothing on this day.</p>
        ) : (
          <ul className="mt-1 divide-y divide-brand-line/70" data-testid="day-events">
            {sum.events.map((ev, i) => {
              const locked =
                !!ev.itemId &&
                (ctx.partialPlanKeys.has(`${ev.itemId}|${ev.originalDate}`) ||
                  ctx.partialPlanKeys.has(`${ev.itemId}|${ev.occurrenceDate}`));
              const canMissed = ev.dragged && !!ev.itemId && !!ev.originalDate && !locked;
              const dragRow = ev.dragged
                ? dragging.find((r) => r.itemId === ev.itemId && r.originalDate === ev.originalDate)
                : undefined;
              return (
                <li key={`${ev.itemId ?? "_"}-${i}`} className="py-2" data-testid={`day-event-${ev.itemId ?? i}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: MARKER[ev.kind] }}
                      />
                      <span className="truncate text-body text-neutral-700">{ev.label}</span>
                    </span>
                    <span
                      className={`font-mono text-label tabular-nums ${ev.amount < 0 ? "text-bad" : "text-brand-navy"}`}
                    >
                      {formatCurrency(ev.amount)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-micro text-neutral-600">
                    {MARKER_LABEL[ev.kind]}
                    {ev.dragged && ev.originalDate ? ` · past due since ${formatDate(ev.originalDate)}` : " · scheduled"}
                    {locked ? " · partly paid" : ""}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {ev.itemId && (
                      <button
                        type="button"
                        className="press rounded-control px-2 py-1 text-micro font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                        onClick={() => onOpenRegister(() => ctx.jumpToPlan(ev.itemId!, selectedDate))}
                        aria-label={`Open ${ev.label} in the register`}
                        data-testid={`day-jump-${ev.itemId}`}
                      >
                        Open in register
                      </button>
                    )}
                    {canMissed && (
                      <button
                        type="button"
                        className="press rounded-control px-2 py-1 text-micro font-semibold text-bad ring-1 ring-bad/25 hover:bg-bad-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bad/40"
                        onClick={() =>
                          ctx.onMarkMissed(
                            tooltipPlanLine(
                              {
                                label: ev.label,
                                amount: ev.amount,
                                itemId: ev.itemId!,
                                dragged: true,
                                originalDate: ev.originalDate,
                                occurrenceDate: ev.occurrenceDate,
                              },
                              selectedDate,
                            ),
                          )
                        }
                        data-testid={`day-mark-missed-${ev.itemId}`}
                      >
                        Mark missed
                      </button>
                    )}
                    {dragRow && !locked && (
                      <button
                        type="button"
                        className="press rounded-control px-2 py-1 text-micro font-semibold text-neutral-600 ring-1 ring-brand-line hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                        onClick={() => ctx.onSkipDraggingPlan(dragRow)}
                        data-testid={`day-skip-${ev.itemId}`}
                      >
                        Skip
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {sum.bankRows.map((b) => (
              <li key={`bank-${b.txnId}`} className="py-2" data-testid={`day-bank-${b.txnId}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-body text-neutral-700">{b.label}</span>
                  <span className={`font-mono text-label tabular-nums ${b.amount < 0 ? "text-bad" : "text-brand-navy"}`}>
                    {formatCurrency(b.amount)}
                  </span>
                </div>
                <div className="mt-0.5 text-micro text-neutral-600">
                  Bank activity{b.matched ? " · matched" : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import { Link } from "wouter";
import type { AvalancheWeeklyLastPaid, AvalancheWeeklyWeek } from "@workspace/api-client-react";
// The lazy `features` module: this box lives in the below-the-fold chunk, never on the landing path.
import { getGetAvalancheWeeklyQueryKey, useGetAvalancheWeekly } from "@workspace/api-client-react/features";
import { Panel } from "@/components/next";
import { cn } from "@/lib/utils";
import { householdToday } from "@/lib/householdDay";
import { linkedNote, paidCardLabel, payDayLabel, weekCardLabel, weekPayView } from "@/lib/avalancheWeekPay";
import { useAvalancheWeekPay, type AvalancheWeekPayControls } from "@/hooks/useAvalancheWeekPay";
import { WeekPayButton, WeekPayError, WeekUndoButton } from "@/components/avalanche-week-pay";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { LINK, money, rise } from "./shared";

const MIN = 60_000;

/** "Next: $450 → Card A on Friday, Nov 20" — the next week that pays something. */
function NextLine({ next, today }: { next: AvalancheWeeklyWeek | null; today: string }) {
  if (!next) return null;
  return (
    <p className="text-label text-neutral-600" data-testid="avalanche-week-next">
      Next: <span className={NUM}>{money(next.paid)}</span> → {weekCardLabel(next)} on{" "}
      {payDayLabel(next.date, today)}
    </p>
  );
}

/** A previous week's press that can still be undone: one quiet line. */
function EarlierLine({ earlier, controls, today }: { earlier: AvalancheWeeklyLastPaid | null; controls: AvalancheWeekPayControls; today: string }) {
  if (!earlier) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-label text-neutral-500" data-testid="avalanche-week-earlier">
      <span>
        Paid <span className={NUM}>{money(earlier.total)}</span> to {paidCardLabel(earlier)} on{" "}
        {payDayLabel(earlier.date, today)}
      </span>
      <WeekUndoButton controls={controls} paid={earlier} />
    </p>
  );
}

/** The box's one figure line: the money in mono tabular numerals, the cards in the text face. */
const BIG = "text-kpi font-semibold text-brand-navy";
const NUM = "font-mono tabular-nums";

type WeeklyQ = ReturnType<typeof useWeeklyQ>;

/** The same key and cache as the Debt page's weekly panel: one plan for both. */
const useWeeklyQ = () =>
  useGetAvalancheWeekly({ query: { queryKey: getGetAvalancheWeeklyQueryKey(), staleTime: 5 * MIN, gcTime: 30 * MIN } });

function Body({ q, controls }: { q: WeeklyQ; controls: AvalancheWeekPayControls }) {
  const today = householdToday();
  if (q.data === undefined) {
    if (q.isError) {
      return (
        <div role="alert" className="text-body text-neutral-600" data-testid="avalanche-week-error">
          <p>This week's avalanche did not load.</p>
          <button type="button" onClick={() => void q.refetch()} className="mt-1 text-label font-semibold text-brand-navy underline">
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="space-y-2" aria-busy="true" data-testid="avalanche-week-loading">
        <div className="skeleton h-8 w-2/3 rounded-control" />
        <div className="skeleton h-4 w-1/3 rounded" />
      </div>
    );
  }
  const view = weekPayView(q.data);
  switch (view.kind) {
    case "hidden":
      return null;
    case "none":
      return <p className="text-body text-neutral-600" data-testid="avalanche-week-none">No debt left for the avalanche to pay.</p>;
    case "toPay": {
      const { week } = view;
      return (
        <div className="space-y-2" data-testid="avalanche-week-topay">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className={BIG} data-testid="avalanche-week-line">
                <span className={NUM}>{money(week.paid)}</span> → {weekCardLabel(week)}
              </div>
              {week.targets.length > 1 &&
                week.targets.map((t) => (
                  <p key={t.debtId} className="text-label text-neutral-600" data-testid="avalanche-week-target">
                    <span className={NUM}>{money(t.amount)}</span> → {t.name}
                  </p>
                ))}
              <p className="mt-1 text-label font-semibold text-neutral-600" data-testid="avalanche-week-when">
                {payDayLabel(week.date, today)}
              </p>
            </div>
            <WeekPayButton controls={controls} date={week.date} className="w-full sm:w-auto" />
          </div>
          <WeekPayError controls={controls} />
          <EarlierLine earlier={view.earlier} controls={controls} today={today} />
        </div>
      );
    }
    case "paid": {
      const { paid } = view;
      return (
        <div className="space-y-2" data-testid="avalanche-week-paid">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className={BIG} data-testid="avalanche-week-paid-line">
                Paid <span className={NUM}>{money(paid.total)}</span> to {paidCardLabel(paid)}
              </span>
              {paid.targets.length === 1 && paid.targets[0]!.paidOff && <span className="chip ok">PAID OFF</span>}
            </div>
            <WeekUndoButton controls={controls} paid={paid} />
          </div>
          {paid.targets.length > 1 &&
            paid.targets.map((t) => (
              <p key={t.debtId} className="flex flex-wrap items-center gap-2 text-label text-neutral-600" data-testid="avalanche-week-target">
                <span>
                  <span className={NUM}>{money(t.amount)}</span> to {t.name}
                </span>
                {t.paidOff && <span className="chip ok">PAID OFF</span>}
              </p>
            ))}
          {linkedNote(paid) && (
            <p className="text-label text-neutral-500" data-testid="avalanche-week-linked">
              {linkedNote(paid)}
            </p>
          )}
          <NextLine next={view.next} today={today} />
          <WeekPayError controls={controls} />
        </div>
      );
    }
    case "answered":
    case "nothingSafe":
      return (
        <div className="space-y-1" data-testid={`avalanche-week-${view.kind === "answered" ? "answered" : "nothing"}`}>
          <p className="text-body font-semibold text-brand-navy">
            {view.kind === "answered" ? "Answered on the Forecast" : "Nothing is safe to pay this week."}
          </p>
          <NextLine next={view.next} today={today} />
          <EarlierLine earlier={view.earlier} controls={controls} today={today} />
          <WeekPayError controls={controls} />
        </div>
      );
  }
}

/**
 * ⭐ (AVAL-W) "Which avalanche we are paying, when, and a button to say we did"
 * (owner, 2026-11-10). Sits in the below-the-fold chunk above the forecast:
 * this week's payment and the card it goes to, "We paid it" (closes the week
 * and lowers that card's balance), then "Paid $X to <card>" with Undo and the
 * next payment. Nothing at all with the monthly cadence.
 *
 * Its size: the same `BELOW_FOLD.avalanche` minimum height as the slot's
 * skeleton, so nothing below it moves when it arrives. Presentation only: every
 * figure is the server's weekly plan (`lib/avalancheWeekPay.ts` picks the state).
 */
export default function AvalancheWeekBox() {
  const minH = useFoldMinH("avalanche");
  const controls = useAvalancheWeekPay();
  const q = useWeeklyQ();
  if (q.data !== undefined && weekPayView(q.data).kind === "hidden") return null;
  return (
    <Panel
      title="Avalanche this week"
      span={BELOW_FOLD.avalanche.span}
      variant="static"
      className={cn(rise(BELOW_FOLD.avalanche.rise), minH)}
      data-testid="dash-avalanche-week"
      actions={
        <Link href="/avalanche" className={cn(LINK, "text-label")} data-testid="dash-avalanche-week-link">
          Payoff plan
        </Link>
      }
    >
      <Body q={q} controls={controls} />
    </Panel>
  );
}

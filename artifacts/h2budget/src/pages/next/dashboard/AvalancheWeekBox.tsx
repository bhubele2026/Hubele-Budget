import { Link } from "wouter";
import type { QueryClient } from "@tanstack/react-query";
import type { AvalancheWeeklyLastPaid, AvalancheWeeklyWeek } from "@workspace/api-client-react";
// The lazy `features` module: this box is its own lazy chunk, never on the landing path.
import { getAvalancheWeekly, getGetAvalancheWeeklyQueryKey, useGetAvalancheWeekly } from "@workspace/api-client-react/features";
import { Panel } from "@/components/next";
import { cn } from "@/lib/utils";
import { householdToday } from "@/lib/householdDay";
import { linkedNote, paidCardLabel, payDayLabel, weekCardLabel, weekPayView } from "@/lib/avalancheWeekPay";
import { useAvalancheWeekPay, type AvalancheWeekPayControls } from "@/hooks/useAvalancheWeekPay";
import { WeekPayButton, WeekPayError, WeekUndoButton } from "@/components/avalanche-week-pay";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { LINK, money, weekdayLabel } from "./shared";
import { useReadyMark } from "@/lib/perfMarks";

const MIN = 60_000;

/** A row's small label ("Paid", "Next payment"): one column on a desktop, so the two rows line up. */
const ROW_LABEL = "shrink-0 text-label font-semibold text-neutral-600 sm:w-28";
/** A row's own words: the money in mono tabular numerals, the card in the text face. */
const ROW_VALUE = "min-w-0 text-body font-semibold text-brand-navy";
/** A row that opens: the native marker, then the row's words. */
const ROW_SUMMARY =
  "w-fit cursor-pointer rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";
const Dot = () => <span aria-hidden className="px-1.5 font-normal text-neutral-400">·</span>;

/** "2 cards" — a row that pays more than one debt names how many; its detail names each. */
const cardCount = (n: number) => `${n} cards`;

/**
 * "Next payment · Fri Nov 20 · $450.00 · Card A" — the next week that pays something, as one compact row.
 * More than one card: "2 cards", and the row opens to each card's own line.
 */
function NextRow({ next }: { next: AvalancheWeeklyWeek | null }) {
  if (!next) return null;
  const many = next.targets.length > 1;
  const words = (
    <span className={ROW_VALUE} data-testid="avalanche-week-next-line">
      {weekdayLabel(next.date) ?? next.date}
      <Dot />
      <span className={NUM}>{money(next.paid)}</span>
      <Dot />
      {many ? cardCount(next.targets.length) : weekCardLabel(next)}
    </span>
  );
  return (
    <div className="flex items-baseline gap-x-2 sm:gap-x-3" data-testid="avalanche-week-next">
      <span className={ROW_LABEL}>Next payment</span>
      {many ? (
        <details className="disclose min-w-0 flex-1" data-testid="avalanche-week-next-cards">
          <summary className={ROW_SUMMARY}>{words}</summary>
          <div className="mt-1 space-y-0.5">
            {next.targets.map((t) => (
              <p key={t.debtId} className="text-label text-neutral-600" data-testid="avalanche-week-next-target">
                <span className={NUM}>{money(t.amount)}</span> → {t.name}
              </p>
            ))}
          </div>
        </details>
      ) : (
        words
      )}
    </div>
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

const WEEKLY_CACHE = { staleTime: 5 * MIN, gcTime: 30 * MIN } as const;

/** The same key and cache as the Debt page's weekly panel: one plan for both. */
const useWeeklyQ = () => useGetAvalancheWeekly({ query: { queryKey: getGetAvalancheWeeklyQueryKey(), ...WEEKLY_CACHE } });

/**
 * (perf phase 2) Ask for the plan as soon as this chunk has run, under the box's own key and cache: the open
 * starts it beside the spine (`warmPayThisWeek` in Dashboard.tsx), so it no longer waits for the landing to
 * render and Suspense to let the box in.
 */
export function warmWeekly(qc: QueryClient): void {
  void qc.prefetchQuery({
    queryKey: getGetAvalancheWeeklyQueryKey(),
    queryFn: ({ signal }) => getAvalancheWeekly({ signal }),
    ...WEEKLY_CACHE,
  });
}

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
      const many = paid.targets.length > 1;
      const note = linkedNote(paid);
      const words = (
        <span className={ROW_VALUE} data-testid="avalanche-week-paid-line">
          <span className={NUM}>{money(paid.total)}</span>
          <Dot />
          {many ? cardCount(paid.targets.length) : paidCardLabel(paid)}
        </span>
      );
      const linked = note ? (
        <p className="text-label text-neutral-500" data-testid="avalanche-week-linked">
          {note}
        </p>
      ) : null;
      return (
        <div className="space-y-2" data-testid="avalanche-week-paid">
          <div className="flex items-start justify-between gap-3" data-testid="avalanche-week-paid-row">
            <div className="flex min-w-0 flex-1 items-baseline gap-x-2 sm:gap-x-3">
              <span className={ROW_LABEL}>Paid</span>
              {many ? (
                <details className="disclose min-w-0 flex-1" data-testid="avalanche-week-paid-cards">
                  <summary className={ROW_SUMMARY}>{words}</summary>
                  <div className="mt-1 space-y-0.5">
                    {paid.targets.map((t) => (
                      <p key={t.debtId} className="flex flex-wrap items-center gap-2 text-label text-neutral-600" data-testid="avalanche-week-target">
                        <span>
                          <span className={NUM}>{money(t.amount)}</span> to {t.name}
                        </span>
                        {t.paidOff && <span className="chip ok">PAID OFF</span>}
                      </p>
                    ))}
                    {linked}
                  </div>
                </details>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {words}
                    {paid.targets.length === 1 && paid.targets[0]!.paidOff && <span className="chip ok">PAID OFF</span>}
                  </div>
                  {linked}
                </div>
              )}
            </div>
            <WeekUndoButton controls={controls} paid={paid} />
          </div>
          <NextRow next={view.next} />
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
          <NextRow next={view.next} />
          <EarlierLine earlier={view.earlier} controls={controls} today={today} />
          <WeekPayError controls={controls} />
        </div>
      );
  }
}

/**
 * ⭐ (AVAL-W) "Which avalanche we are paying, when, and a button to say we did"
 * (owner, 2026-11-10). (Home is four numbers, 2026-11-11) Titled "Pay this week"
 * and directly under the header, in its own lazy chunk: this week's payment and the card it goes to, "We paid it" (closes the week
 * and lowers that card's balance). (Home says less, 2026-11-11) Once paid, two
 * compact labelled rows: "Paid · $X · card" with Undo, and "Next payment ·
 * Fri Nov 20 · $X · card". A row for more than one card says "2 cards" and
 * opens to each card's own line. Nothing at all with the monthly cadence.
 *
 * Its size: the same `BELOW_FOLD.avalanche` minimum height as the slot's
 * skeleton, so nothing below it moves when it arrives. Presentation only: every
 * figure is the server's weekly plan (`lib/avalancheWeekPay.ts` picks the state).
 */
export default function AvalancheWeekBox() {
  const minH = useFoldMinH("avalanche");
  const controls = useAvalancheWeekPay();
  const q = useWeeklyQ();
  // (PERF-0) The week's payment (or its answer) is on screen.
  useReadyMark("h2:weekly-pay-ready", q.data !== undefined);
  if (q.data !== undefined && weekPayView(q.data).kind === "hidden") return null;
  return (
    <Panel
      title="Pay this week"
      span={BELOW_FOLD.avalanche.span}
      variant="static"
      // No entrance of its own: it replaces a skeleton of the same size that is already on screen (a second
      // fade here blinked the box out and back in). The page's own lift is its entrance.
      className={minH}
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

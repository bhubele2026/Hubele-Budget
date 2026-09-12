import { btnLink, btnSm, Help } from "@/ui";
import { formatCurrency, formatDate } from "@/lib/utils";
import { canRecordPartial, type PlanLine } from "@/lib/forecastMatch";
import {
  AmountDifference,
  DayDelta,
  curveHelp,
  curveLabel,
  RemainderNote,
  remainderHelp,
  type SuggestionAnswer,
} from "./probablyPaidText";

/**
 * (PR5) The server's "probably paid" pair for one pending bank row, under its
 * inbox card. It replaces the client's own suggestion chips for that row: a
 * plan never carries two suggestions.
 *
 * ⚠️ These are ordinary rules on the server (`planMatch.ts`: amount, date,
 * label words) — no model, no generated text. The curve already leaves the
 * plan out; nothing is written until one of the three answers is clicked.
 */
export function ProbablyPaidStrip({
  plan,
  txnId,
  onAnswer,
  disabled,
}: {
  plan: PlanLine;
  txnId: string;
  onAnswer: (answer: SuggestionAnswer) => void;
  disabled?: boolean;
}) {
  const pp = plan.probablyPaid;
  if (!pp) return null;
  const partial = canRecordPartial(plan, pp);
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control bg-white px-2 py-1.5 text-micro ring-1 ring-brand-navy/25"
      data-testid={`probably-paid-${txnId}`}
    >
      <span className="chip info">Suggested</span>
      <span className="max-w-[160px] truncate font-semibold text-neutral-700">
        {plan.label}
      </span>
      <span className="text-neutral-500">
        Planned{" "}
        <span className="font-mono tabular-nums">{formatDate(plan.date)}</span>{" "}
        <span className="font-mono tabular-nums">
          {formatCurrency(plan.amount)}
        </span>
      </span>
      <span className="text-neutral-500" data-testid={`probably-paid-difference-${txnId}`}>
        <AmountDifference difference={pp.difference} />
      </span>
      <span className="text-neutral-500" data-testid={`probably-paid-days-${txnId}`}>
        <DayDelta days={pp.dayDelta} />
      </span>
      <span className="uppercase tracking-wide text-neutral-400">
        {pp.confidence}
        {pp.ambiguous ? " · close call" : ""}
      </span>
      <span className="text-neutral-500" data-testid={`probably-paid-curve-${txnId}`}>
        {pp.remainderAmount !== undefined ? (
          <RemainderNote remainderAmount={pp.remainderAmount} />
        ) : (
          curveLabel(pp.offCurve)
        )}
      </span>
      <Help>{pp.remainderAmount !== undefined ? remainderHelp() : curveHelp(pp.offCurve)}</Help>
      <span className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          className={btnSm}
          disabled={disabled}
          onClick={() => onAnswer("matched")}
          data-testid={`probably-paid-confirm-${txnId}`}
          aria-label={`Confirm ${plan.label} on ${plan.date}`}
        >
          Confirm
        </button>
        <button
          type="button"
          className={btnLink}
          disabled={disabled}
          onClick={() => onAnswer("not_match")}
          data-testid={`probably-paid-reject-${txnId}`}
          aria-label={`Not ${plan.label} on ${plan.date}`}
        >
          Not this
        </button>
        {partial && (
          <button
            type="button"
            className={btnLink}
            disabled={disabled}
            onClick={() => onAnswer("partial")}
            data-testid={`probably-paid-partial-${txnId}`}
            aria-label={`Partial payment of ${plan.label} on ${plan.date}`}
          >
            Partial
          </button>
        )}
      </span>
    </div>
  );
}

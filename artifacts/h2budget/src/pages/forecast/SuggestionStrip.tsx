import { formatCurrency, formatDate } from "@/lib/utils";
import type { PlanLine, PlanSuggestion } from "@/lib/forecastMatch";

/**
 * Candidate plan rows for one bank transaction, as a row of quiet chips.
 *
 * ⚠️ These are ORDINARY MATCHES, ranked by date distance, amount delta and
 * label overlap (`lib/forecastMatch`) — there is no model here and no
 * generated text; the app contains no AI. The strip used to render them as
 * filled buttons with a coloured confidence pill each, which made a list of
 * guesses look more certain than the ranking behind it. Now the confidence is
 * a WORD on a hairline chip, and picking one still takes one click.
 */

/** Confidence reads as a label; only the low tier drops to plain grey. */
const TONE: Record<string, string> = {
  high: "text-brand-navy ring-brand-navy/30",
  medium: "text-neutral-600 ring-brand-line",
  low: "text-neutral-500 ring-brand-line",
};

export function SuggestionStrip({
  suggestions,
  onPick,
  txnId,
}: {
  suggestions: PlanSuggestion[];
  onPick: (p: PlanLine) => void;
  txnId: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
      data-testid={`bank-suggestions-${txnId}`}
    >
      <span className="mr-0.5 text-micro font-semibold uppercase tracking-wide text-neutral-400">
        Suggested
      </span>
      {suggestions.map((s) => (
        <button
          key={`${s.plan.itemId}|${s.plan.date}`}
          type="button"
          onClick={() => onPick(s.plan)}
          data-testid={`suggest-match-${txnId}-${s.plan.itemId}-${s.plan.date}`}
          title={`${s.daysAway}d away · Δ ${formatCurrency(s.amountDelta)}${s.labelMatch ? " · label match" : ""}`}
          aria-label={`Match to ${s.plan.label} on ${s.plan.date}, ${s.confidence} confidence`}
          className={`press inline-flex items-center gap-1.5 rounded-control bg-white px-2 py-1 text-micro ring-1 hover:bg-neutral-50 ${
            TONE[s.confidence] ?? TONE.low
          }`}
        >
          <span className="max-w-[140px] truncate font-semibold">
            {s.plan.label}
          </span>
          <span className="font-mono tabular-nums text-neutral-400">
            {formatDate(s.plan.date)}
          </span>
          <span className="uppercase tracking-wide text-neutral-400">
            {s.confidence}
          </span>
        </button>
      ))}
    </div>
  );
}

import { formatCurrency } from "@/lib/utils";

/** The three answers to a "Suggested" pair, as the statuses they post. */
export type SuggestionAnswer = "matched" | "not_match" | "partial";

/** Whether the forecast still counts the plan — said in words, not colour. */
export function curveLabel(offCurve: boolean): string {
  return offCurve ? "Out of forecast" : "Still in forecast";
}

export function curveHelp(offCurve: boolean): string {
  return offCurve
    ? "This bank row probably paid the plan, so the forecast already leaves the plan out. Confirm matches them, Not this puts the plan back, Partial keeps the unpaid rest planned."
    : "This bank row may have paid the plan. The forecast still counts the plan until you Confirm. Not this dismisses the suggestion, Partial keeps the unpaid rest planned.";
}

/** (One-time bill move) What a "Match needs review" pair means. */
export const REVIEW_HELP =
  "This bill was edited, and the bank row matched to it no longer fits the new date or amount on its own. The forecast counts the bill again until you answer. Confirm keeps the match, Not this frees the row.";

/** (One-time bill move, review M3) What a "Partial payment needs review" pair means. */
export const REVIEW_PARTIAL_HELP =
  "This bill was edited, and the part payment matched to it no longer fits the new date or amount on its own. The forecast counts the whole bill until you answer. Partial keeps the unpaid rest planned, Confirm full treats the row as paying all of it, Not this frees the row.";

/**
 * (PR5) How far the paying row sits from the plan, as a mono figure plus a
 * word — the word carries the meaning, never a colour.
 */
export function DayDelta({ days }: { days: number }) {
  if (days === 0) return <span>same day</span>;
  return (
    <span>
      <span className="font-mono tabular-nums">{Math.abs(days)}d</span>{" "}
      {days < 0 ? "early" : "late"}
    </span>
  );
}

/** |row| − |plan|: "exact", or the gap and "over" / "under". */
export function AmountDifference({ difference }: { difference: number }) {
  if (Math.abs(difference) < 0.005) return <span>exact</span>;
  return (
    <span>
      <span className="font-mono tabular-nums">
        {formatCurrency(Math.abs(difference))}
      </span>{" "}
      {difference > 0 ? "over" : "under"}
    </span>
  );
}

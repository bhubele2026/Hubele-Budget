import type { PlanLine } from "@/lib/forecastMatch";

// (#456) Shared predicate: a plan row can accept a drag-to-match drop iff
// it's a still-open occurrence (pending or upcoming). Used by both the
// `PlanDropRow` visual treatment and the page-level `onDragEnd` handler so
// the rendered "blocked" state and the actual rejection logic can never
// drift apart.
export function isPlanRowMatchEligible(row: Pick<PlanLine, "status">): boolean {
  return row.status === "pending_plan" || row.status === "future";
}

/**
 * Row status as a `.chip` — the kit's one badge shape.
 *
 * ⚠️ THE LABEL CARRIES THE STATE, NOT THE COLOUR. On this palette good is
 * navy and does not shout, "watch" is grey and only `missed` earns the deep
 * orange; a reader who cannot separate the hues still gets the answer from the
 * word. That is why every entry below has a written label and why an unknown
 * status falls through to printing itself rather than to a neutral colour.
 */
const CHIP: Record<string, { label: string; tone: string }> = {
  pending_plan: { label: "Pending plan", tone: "warn" },
  pending_bank: { label: "Pending bank", tone: "info" },
  future: { label: "Upcoming", tone: "gray" },
  /** (PR5) A bank row probably paid it. Whether the curve still counts it is
   *  said separately ("Out of forecast" / "Still in forecast"). */
  suggested: { label: "Suggested", tone: "info" },
  /** (One-time bill move) A confirmed match the bill's new date put in question. */
  needs_review: { label: "Match needs review", tone: "warn" },
  /** (One-time bill move, review M3) The same for a partial payment. */
  needs_review_partial: { label: "Partial payment needs review", tone: "warn" },
  matched: { label: "Matched", tone: "ok" },
  partial: { label: "Partly paid", tone: "warn" },
  missed: { label: "Missed", tone: "bad" },
  rescheduled: { label: "Rescheduled", tone: "info" },
  ignored_unforecasted: { label: "Unplanned", tone: "gray" },
  unplanned: { label: "Unplanned", tone: "gray" },
};

export function statusBadge(s: string) {
  const v = CHIP[s] ?? { label: s, tone: "gray" };
  return <span className={`chip ${v.tone}`}>{v.label}</span>;
}

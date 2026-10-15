import type { Spine } from "@workspace/api-client-react";

/**
 * (Q5) THE WEEK'S ONE STORY on the landing: the plan is compared with what
 * COUNTS TOWARD IT (the known figure), and the unconfirmed part is said beside
 * it. The cautious total (known + unconfirmed) stays the money position's, for
 * "Room to spend"; it is never called "over the plan" here.
 *
 * Nothing is worked out: `knownWeek`, `unresolvedWeek`, `provisional` and
 * `remainingWeekKnown` are the spine's own (GET /money/position). A sign test
 * picks a word. "Plan not set" is `remainingWeekKnown === null`, never zero.
 */
export interface WeekStory {
  planSet: boolean;
  /** Remaining against the known figure; null when the plan is not set */
  remainingKnown: number | null;
  /** Known figure is past the plan (never true without a plan) */
  over: boolean;
  /** Unconfirmed rows exceed the provisional threshold */
  provisional: boolean;
  known: string;
  unconfirmed: string;
}

export function weekStory(p: Spine["position"]): WeekStory {
  const rem = p.remainingWeekKnown == null ? null : Number(p.remainingWeekKnown);
  const planSet = rem != null && Number.isFinite(rem);
  return {
    planSet,
    remainingKnown: planSet ? rem : null,
    over: planSet && rem < 0,
    provisional: p.provisional,
    known: p.knownWeek,
    unconfirmed: p.unresolvedWeek,
  };
}

/**
 * The attention list's "withinPlan" on the KNOWN figure. Over only when what
 * counts toward the plan is over; a cautious total that is over while the known
 * figure is not reads "tight" (unconfirmed rows could tip it), never "over".
 */
export function knownWithinPlan(p: Spine["position"]): "yes" | "tight" | "over" | null {
  const w = weekStory(p);
  if (!w.planSet) return null;
  if (w.over) return "over";
  return p.withinPlan === "over" ? "tight" : p.withinPlan;
}

/**
 * (Round 3) The status word for a week, from `knownWithinPlan` and the provisional flag: ONE rule for the landing's
 * tile and the Spending drill-down it opens. Over on the known figure is certain (unconfirmed rows are outflows, so
 * the known figure can only rise), so it reads Over even when the week is not final.
 */
export type WeekStatusWord = "Plan not set" | "Over" | "Not final" | "Tight" | "On plan";
export function weekStatus(within: ReturnType<typeof knownWithinPlan>, provisional: boolean): { word: WeekStatusWord; tone: "neutral" | "ok" | "bad" } {
  if (within == null) return { word: "Plan not set", tone: "neutral" };
  if (within === "over") return { word: "Over", tone: "bad" };
  if (provisional) return { word: "Not final", tone: "neutral" };
  if (within === "tight") return { word: "Tight", tone: "neutral" };
  return { word: "On plan", tone: "ok" };
}

/** A period's own remaining figure (the known one, or null with no plan) as the within-plan input of `weekStatus`. */
export const withinOfRemaining = (remaining: string | number | null | undefined): "yes" | "over" | null =>
  remaining == null ? null : Number(remaining) < 0 ? "over" : "yes";

export const hasCents = (v: string | null | undefined): boolean => Math.round(Number(v ?? 0) * 100) !== 0;

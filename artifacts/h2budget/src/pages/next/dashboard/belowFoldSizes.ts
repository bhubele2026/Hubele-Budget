/**
 * (C11b, dashboard refinement) The panels that load after first paint, in two
 * slots of ONE lazy chunk: the forecast row (forecast + coming up), which sits
 * above the eager account list, and the lower rows (spending pace, debt
 * progress, needs attention, recent activity). Each panel has a fixed minimum
 * height applied to BOTH the real panel and its skeleton, so nothing below it
 * jumps when it arrives. One constant per panel keeps the two in step by
 * construction (a test pins it).
 */
export const BELOW_FOLD = {
  // (AVAL-W) "Pay this week": sized for one card's payment and its button
  // (taller on a phone, where the button sits below). With the monthly cadence
  // the box draws nothing once the plan says so. (Home is four numbers,
  // 2026-11-11) Its own lazy chunk and slot now, directly under the header.
  // (2026-11-12) One aligned action row on a desktop; amount, then date and status side by side, then the button on
  // a phone.
  avalanche: { span: 12, minH: "min-h-[14rem] sm:min-h-[8.25rem]", rise: 1, slot: "pay" },
  forecast: { span: 12, minH: "min-h-[29rem]", rise: 3, slot: "forecast" },
  upcoming: { span: 4, minH: "min-h-[29rem]", rise: 4, slot: "off" },
  spending: { span: 6, minH: "min-h-[19rem]", rise: 5, slot: "off" },
  debt: { span: 6, minH: "min-h-[19rem]", rise: 6, slot: "off" },
  // The last row sizes to its own content (lead, 2026-10-09): nothing below it
  // but the version line, and both panels arrive in the same slot together.
  attention: { span: 7, minH: "", rise: 7, slot: "off" },
  activity: { span: 5, minH: "", rise: 8, slot: "off" },
} as const;

export type BelowFoldKey = keyof typeof BELOW_FOLD;
export type BelowFoldSlot = (typeof BELOW_FOLD)[BelowFoldKey]["slot"];

/** The keys of one slot, in page order. */
export function slotKeys(slot: BelowFoldSlot): BelowFoldKey[] {
  return (Object.keys(BELOW_FOLD) as BelowFoldKey[]).filter((k) => BELOW_FOLD[k].slot === slot);
}

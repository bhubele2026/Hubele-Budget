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
  forecast: { span: 8, minH: "min-h-[29rem]", rise: 3, slot: "forecast" },
  upcoming: { span: 4, minH: "min-h-[29rem]", rise: 4, slot: "forecast" },
  spending: { span: 6, minH: "min-h-[19rem]", rise: 5, slot: "lower" },
  debt: { span: 6, minH: "min-h-[19rem]", rise: 6, slot: "lower" },
  attention: { span: 7, minH: "min-h-[20rem]", rise: 7, slot: "lower" },
  activity: { span: 5, minH: "min-h-[20rem]", rise: 8, slot: "lower" },
} as const;

export type BelowFoldKey = keyof typeof BELOW_FOLD;
export type BelowFoldSlot = (typeof BELOW_FOLD)[BelowFoldKey]["slot"];

/** The keys of one slot, in page order. */
export function slotKeys(slot: BelowFoldSlot): BelowFoldKey[] {
  return (Object.keys(BELOW_FOLD) as BelowFoldKey[]).filter((k) => BELOW_FOLD[k].slot === slot);
}

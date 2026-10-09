/**
 * (C11b) The below-the-fold panels load after first paint. Each has a fixed
 * minimum height, applied to BOTH the real panel and its skeleton, so the
 * page does not jump when a panel arrives. One constant per panel keeps the
 * two in step by construction (a test pins it).
 */
export const BELOW_FOLD = {
  forecast: { span: 8, minH: "min-h-[26rem]", rise: 4 },
  debt: { span: 4, minH: "min-h-[26rem]", rise: 5 },
  activity: { span: 8, minH: "min-h-[24rem]", rise: 6 },
  review: { span: 4, minH: "min-h-[24rem]", rise: 7 },
} as const;

export type BelowFoldKey = keyof typeof BELOW_FOLD;

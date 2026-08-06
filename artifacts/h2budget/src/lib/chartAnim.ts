/**
 * The one recharts animation setting, shared by every chart in the app so
 * they all draw in with the same slow, calm sweep (chart durations were
 * previously 900/1100/1200/1500ms depending on the page). Spread into each
 * series element: `<Line {...CHART_ANIM} … />`.
 *
 * Recharts animates in JS, so the global CSS reduced-motion guard can't
 * reach it — gate here instead (module-load check is enough; the preference
 * rarely changes mid-session).
 */
const REDUCE =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const CHART_ANIM = {
  isAnimationActive: !REDUCE,
  animationDuration: 1300,
  animationEasing: "ease-out",
} as const;

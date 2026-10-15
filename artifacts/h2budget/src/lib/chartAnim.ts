import { PREFERS_REDUCED_MOTION, REVEAL_MS } from "@/lib/chartTokens";

/**
 * The one recharts animation setting, shared by every chart in the app so
 * they all draw in with the same calm sweep (the kit's `REVEAL_MS`, one
 * source for the duration and for the reduced-motion flag). Spread into each
 * series element: `<Line {...CHART_ANIM} … />`.
 *
 * Recharts animates in JS, so the global CSS reduced-motion guard can't
 * reach it; the kit's flag gates it (module-load check is enough).
 */
export const CHART_ANIM = {
  isAnimationActive: !PREFERS_REDUCED_MOTION,
  animationDuration: REVEAL_MS,
  animationEasing: "ease-out",
} as const;

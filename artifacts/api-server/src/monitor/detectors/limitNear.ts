import { r2, toCents, type Detector } from "../types";

// limit_near: this week's remaining cap is at most 15% of the weekly cap and
// not negative. Over the cap is the Today meter's job — no finding.

export const LIMIT_NEAR_SHARE_PCT = 15;

export const detectLimitNear: Detector = ({ position }) => {
  if (position.weekCap === null || position.remainingWeek === null) return [];
  const capC = toCents(Number(position.weekCap));
  const remC = toCents(Number(position.remainingWeek));
  if (capC <= 0 || remC < 0) return [];
  // remaining ≤ 15% of cap  <=>  remaining × 100 ≤ cap × 15.
  if (!(remC * 100 <= capC * LIMIT_NEAR_SHARE_PCT)) return [];
  return [
    {
      kind: "limit_near",
      dedupeKey: `limit_near:household:${position.weekStart}`,
      severity: "info",
      confidence: position.degraded ? "estimate" : "confirmed",
      payload: {
        weekStart: position.weekStart,
        weekEnd: position.weekEnd,
        weekCap: r2(capC / 100),
        remainingWeek: r2(remC / 100),
        spentWeek: r2(Number(position.spentWeekDiscretionary)),
        degraded: position.degraded,
      },
    },
  ];
};

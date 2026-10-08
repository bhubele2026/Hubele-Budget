import { r2, type Detector } from "../types";

// bank_stale: the bank feed is stale (the freshness verdict) and has been quiet
// for more than 72 hours (or for an unknown time). One finding per week.

export const BANK_STALE_HOURS = 72;

export const detectBankStale: Detector = ({ freshness, weekStart }) => {
  if (!freshness.stale) return [];
  if (freshness.quietHours !== null && !(freshness.quietHours > BANK_STALE_HOURS)) return [];
  return [
    {
      kind: "bank_stale",
      dedupeKey: `bank_stale:household:${weekStart}`,
      severity: "watch",
      confidence: "confirmed",
      payload: {
        weekStart,
        reason: freshness.staleReason,
        quietHours: freshness.quietHours === null ? null : r2(freshness.quietHours),
      },
    },
  ];
};

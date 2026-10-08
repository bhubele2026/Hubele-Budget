import { r2, type Detector } from "../types";

// shortfall_before_income: nothing is available until payday
// (`availableUntilPayday` is exactly 0) and the lowest expected balance before
// payday sits under the cash buffer. High; an estimate when the position
// itself is estimated or the bank data is degraded.

export const detectShortfall: Detector = ({ position }) => {
  if (position.availableUntilPayday === null || position.lowestUntilPayday === null) return [];
  if (Number(position.availableUntilPayday) !== 0) return [];
  const lowest = Number(position.lowestUntilPayday);
  const buffer = Number(position.cashBuffer);
  if (!(lowest < buffer)) return [];
  return [
    {
      kind: "shortfall_before_income",
      dedupeKey: `shortfall_before_income:household:${position.horizon.endDate}`,
      severity: "high",
      confidence: position.confidence === "estimated" || position.degraded ? "estimate" : "confirmed",
      payload: {
        horizonKind: position.horizon.kind,
        endDate: position.horizon.endDate,
        lowestDate: position.lowestUntilPaydayDate,
        lowestUntilPayday: r2(lowest),
        cashBuffer: r2(buffer),
        shortBy: r2(buffer - lowest),
        estimateCount: position.estimates.length,
        degraded: position.degraded,
      },
    },
  ];
};

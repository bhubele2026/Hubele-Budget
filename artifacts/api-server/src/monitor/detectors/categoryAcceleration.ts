import { r2, toCents, type Detector, type Finding } from "../types";

// category_acceleration: a budgeted category whose month-to-date pace
// (spend ÷ elapsed days × days in the month) is more than 1.25 × its planned
// line, with at least 10 days of the month left. Guards (named below): bill
// categories are skipped (lumpy by design, watched by bill_increase) and a
// line under $20 is noise.

export const ACCEL_RATIO = 1.25;
export const ACCEL_MIN_DAYS_LEFT = 10;
export const ACCEL_MIN_PLANNED_DOLLARS = 20;

export const detectCategoryAcceleration: Detector = (facts) => {
  const { dayOfMonth, daysInMonth, daysLeft } = facts.month;
  if (daysLeft < ACCEL_MIN_DAYS_LEFT || dayOfMonth < 1) return [];
  const out: Finding[] = [];
  for (const c of facts.categories) {
    if (c.isBillCategory || c.planned < ACCEL_MIN_PLANNED_DOLLARS || c.spentMtd <= 0) continue;
    const spentC = toCents(c.spentMtd);
    const plannedC = toCents(c.planned);
    // spent / day × days > 1.25 × planned  <=>  spent × days × 4 > planned × 5 × day.
    if (!(spentC * daysInMonth * 4 > plannedC * 5 * dayOfMonth)) continue;
    const pace = (spentC / dayOfMonth) * daysInMonth;
    out.push({
      kind: "category_acceleration",
      dedupeKey: `category_acceleration:${c.categoryId}:${facts.month.start.slice(0, 7)}`,
      severity: "watch",
      confidence: "estimate",
      payload: {
        categoryId: c.categoryId,
        month: facts.month.start.slice(0, 7),
        spentMtd: r2(c.spentMtd),
        planned: r2(c.planned),
        projected: r2(pace / 100),
        overBy: r2((pace - plannedC) / 100),
        daysLeft,
        trailingMonthlyAvg: c.trailingMonthlyAvg === null ? null : r2(c.trailingMonthlyAvg),
      },
    });
  }
  return out;
};

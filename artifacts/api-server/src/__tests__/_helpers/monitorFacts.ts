import type { MoneyPosition } from "@workspace/avalanche-core";
import type { MonitorFacts } from "../../monitor/types";

/** A calm position: bank fresh, payday ahead, plenty available, no cap pressure. Synthetic. */
export function calmPosition(over: Partial<MoneyPosition> = {}): MoneyPosition {
  return {
    todayISO: "2026-10-07",
    status: "ready",
    paydayDate: "2026-10-09",
    payday: { itemId: "00000000-0000-4000-8000-0000000000a1", label: "Paycheck", amount: "2000.00" },
    horizon: { kind: "payday", endDate: "2026-10-09", lastDay: "2026-10-08" },
    lowestUntilPayday: "2400.00",
    lowestUntilPaydayDate: "2026-10-08",
    committedUntilPayday: "340.00",
    cashBuffer: "500.00",
    reservesHeld: "0.00",
    availableUntilPayday: "1900.00",
    weekStart: "2026-10-04",
    weekEnd: "2026-10-10",
    weekCap: "250.00",
    spentWeekDiscretionary: "100.00",
    needsClassificationWeek: "0.00",
    unplannedWeek: "0.00",
    monthlyWeek: "0.00",
    remainingWeek: "150.00",
    paceAllowedToday: "142.86",
    withinPlan: "yes",
    safeToSpendNow: "150.00",
    confidence: "firm",
    estimates: [],
    assumptions: [],
    degraded: false,
    degradedReason: null,
    ...over,
  };
}

/** Facts on which no detector fires. Synthetic; override what a test needs. */
export function calmFacts(over: Partial<MonitorFacts> = {}): MonitorFacts {
  return {
    householdId: "00000000-0000-4000-8000-0000000000h1",
    todayISO: "2026-10-07",
    nowMs: Date.parse("2026-10-07T17:00:00Z"),
    position: calmPosition(),
    freshness: { stale: false, staleReason: null, quietHours: 2 },
    month: { start: "2026-10-01", end: "2026-10-31", daysInMonth: 31, dayOfMonth: 7, daysLeft: 24 },
    weekStart: "2026-10-04",
    categories: [],
    bills: [],
    recentRows: [],
    ...over,
  };
}

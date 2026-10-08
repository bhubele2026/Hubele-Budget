import { goalProgress } from "@workspace/avalanche-core";
import { r2, toCents, type Detector, type Finding } from "../types";

// (PR-C) goal_behind: an active goal with a target and a target date whose
// required monthly pace (remaining ÷ months left) is more than 1.2 × its
// monthly contribution — avalanche-core's `goalProgress().behind`, the same
// rule the metrics' `goalsOnTrackCount` reads. A goal whose current amount is
// unknown (its account has no balance yet) is never judged. Severity watch,
// confidence estimate (a pace is a projection); one finding per goal per month.

export const detectGoalBehind: Detector = ({ goals, todayISO }) => {
  const out: Finding[] = [];
  for (const g of goals ?? []) {
    if (g.status !== "active" || !g.targetDate) continue;
    const current = g.current === null ? null : toCents(Number(g.current));
    const p = goalProgress(g, current, todayISO);
    if (p.behind !== true) continue;
    out.push({
      kind: "goal_behind",
      dedupeKey: `goal_behind:${g.goalId}:${todayISO.slice(0, 7)}`,
      severity: "watch",
      confidence: "estimate",
      payload: {
        goalId: g.goalId,
        targetDate: g.targetDate,
        daysLeft: p.daysLeft,
        overdue: (p.daysLeft ?? 0) <= 0,
        target: r2(Number(g.targetAmount)),
        current: r2((p.currentCents ?? 0) / 100),
        remaining: r2((p.remainingCents ?? 0) / 100),
        monthlyContribution: r2(Number(g.monthlyContribution)),
        requiredMonthly: r2((p.requiredMonthlyCents ?? 0) / 100),
      },
    });
  }
  return out;
};

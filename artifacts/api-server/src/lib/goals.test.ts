// ⭐ (PR-C) GOALS AND RESERVES, pure: the reserve, the goals line of the
// weekly-limit derivation, progress, the goal_behind rule and detector, and the
// two metrics fields. Synthetic figures, each worked by hand beside it.

import { describe, it, expect } from "vitest";
import {
  computeDailyMetrics,
  deriveWeeklyLimit,
  goalCurrentCents,
  goalProgress,
  goalReserveCents,
  goalsMonthlyCents,
  reservesHeldCents,
  POINT_IN_TIME_FIELDS,
  type GoalMathRow,
} from "@workspace/avalanche-core";
import { DETECTED_KINDS, runDetectors } from "../monitor/detectors";
import { detectGoalBehind } from "../monitor/detectors/goalBehind";
import type { GoalFacts } from "../monitor/types";
import { calmFacts } from "../__tests__/_helpers/monitorFacts";

const goal = (o: Partial<GoalMathRow> = {}): GoalMathRow => ({
  status: "active",
  targetAmount: null,
  manualCurrentAmount: "0",
  plaidAccountId: null,
  monthlyContribution: "0",
  targetDate: null,
  reservedInChecking: false,
  ...o,
});
const ACCT = "00000000-0000-4000-8000-0000000000ac";
const TODAY = "2026-10-07";
// 2026-10-07 → 2027-10-07 is 365 days (2027 is not a leap year): exactly 12 months.
const YEAR_OUT = "2027-10-07";

describe("the reserve", () => {
  it("sums active goals reserved in checking, to the cent", () => {
    const goals = [
      goal({ reservedInChecking: true, manualCurrentAmount: "100.10" }),
      goal({ reservedInChecking: true, manualCurrentAmount: "23.35" }),
    ];
    expect(reservesHeldCents(goals)).toBe(12345);
  });
  it("a goal backed by an account never enters it, whatever its flags", () => {
    expect(goalReserveCents(goal({ reservedInChecking: true, manualCurrentAmount: "500", plaidAccountId: ACCT }))).toBe(0);
  });
  it("only active goals hold money back; unreserved goals hold none", () => {
    for (const status of ["paused", "reached", "archived"]) {
      expect(goalReserveCents(goal({ status, reservedInChecking: true, manualCurrentAmount: "40" }))).toBe(0);
    }
    expect(goalReserveCents(goal({ manualCurrentAmount: "40" }))).toBe(0);
  });
  it("a negative amount never raises available", () => {
    expect(goalReserveCents(goal({ reservedInChecking: true, manualCurrentAmount: "-50" }))).toBe(0);
    expect(
      reservesHeldCents([
        goal({ reservedInChecking: true, manualCurrentAmount: "-50" }),
        goal({ reservedInChecking: true, manualCurrentAmount: "10" }),
      ]),
    ).toBe(1000);
  });
});

describe("the goals line", () => {
  it("sums active goals' contributions; paused and negative ones add nothing", () => {
    expect(
      goalsMonthlyCents([
        goal({ monthlyContribution: "100.00" }),
        goal({ monthlyContribution: "25.50" }),
        goal({ monthlyContribution: "75", status: "paused" }),
        goal({ monthlyContribution: "-10" }),
      ]),
    ).toBe(12550);
  });
  it("moves the suggested weekly cap: $200 a month of goals takes $45 off the week (rounded to $5)", () => {
    const base = {
      incomeItems: [{ amount: "2000", frequency: "biweekly", active: true }],
      billItems: [],
      debts: [],
      avalancheExtra: 0,
    };
    // take-home 2000 × 26/12 = 4,333.33 → × 12/52 = 999.99… → $995.
    expect(deriveWeeklyLimit({ ...base, goalsMonthly: 0 }).suggestedWeekly).toBe("995.00");
    // 4,333.33 − 200 = 4,133.33 → × 12/52 = 953.84 → $950.
    const s = deriveWeeklyLimit({ ...base, goalsMonthly: (goalsMonthlyCents([goal({ monthlyContribution: "200" })]) / 100).toFixed(2) });
    expect(s.derivation.goalsMonthly).toBe("200.00");
    expect(s.derivation.discretionaryMonthly).toBe("4133.33");
    expect(s.suggestedWeekly).toBe("950.00");
  });
});

describe("progress", () => {
  it("reads the account's balance for a backed goal (null when unknown), else the typed amount", () => {
    expect(goalCurrentCents(goal({ plaidAccountId: ACCT, manualCurrentAmount: "9" }), "1250.00")).toBe(125000);
    expect(goalCurrentCents(goal({ plaidAccountId: ACCT, manualCurrentAmount: "9" }), null)).toBeNull();
    expect(goalCurrentCents(goal({ manualCurrentAmount: "250.25" }), "1250.00")).toBe(25025);
  });
  it("percent is whole and rounded down, capped at 100", () => {
    expect(goalProgress(goal({ targetAmount: "1000" }), 33399, TODAY).percent).toBe(33); // 33.399%
    expect(goalProgress(goal({ targetAmount: "1000" }), 99999, TODAY).percent).toBe(99);
    expect(goalProgress(goal({ targetAmount: "1000" }), 150000, TODAY).percent).toBe(100);
    expect(goalProgress(goal({ targetAmount: null }), 1000, TODAY).percent).toBeNull();
    expect(goalProgress(goal({ targetAmount: "1000" }), null, TODAY).percent).toBeNull();
  });
  it("months to target is a range, never a date", () => {
    // 750 at 100 a month: 8 contributions → 7 to 8 months.
    expect(goalProgress(goal({ targetAmount: "1000", monthlyContribution: "100" }), 25000, TODAY).monthsToTarget).toEqual({ low: 7, high: 8 });
    // 900 at 300: exactly 3 contributions → 2 to 3 months.
    expect(goalProgress(goal({ targetAmount: "1000", monthlyContribution: "300" }), 10000, TODAY).monthsToTarget).toEqual({ low: 2, high: 3 });
    expect(goalProgress(goal({ targetAmount: "1000", monthlyContribution: "300" }), 100000, TODAY).monthsToTarget).toEqual({ low: 0, high: 0 });
    expect(goalProgress(goal({ targetAmount: "1000", monthlyContribution: "0" }), 0, TODAY).monthsToTarget).toBeNull();
  });
});

describe("the behind rule (required pace > 1.2 × contribution)", () => {
  const g = (remaining: string, o: Partial<GoalMathRow> = {}) =>
    goal({ targetAmount: remaining, monthlyContribution: "100", targetDate: YEAR_OUT, ...o });
  it("boundary: exactly 1.2 × is on track, one cent more is behind", () => {
    // 12 months left, $100 a month: on track up to $1,440.00 to go ($120.00 a month).
    const at = goalProgress(g("1440.00"), 0, TODAY);
    expect(at.behind).toBe(false);
    expect(at.requiredMonthlyCents).toBe(12000);
    const over = goalProgress(g("1440.01"), 0, TODAY);
    expect(over.behind).toBe(true);
    expect(over.requiredMonthlyCents).toBe(12001); // 120.0008… rounded up
  });
  it("a date that has come with money still to go is behind; a reached goal never is", () => {
    expect(goalProgress(g("10", { targetDate: TODAY }), 0, TODAY).behind).toBe(true);
    expect(goalProgress(g("10", { targetDate: "2026-09-30" }), 0, TODAY).requiredMonthlyCents).toBe(1000);
    expect(goalProgress(g("10", { targetDate: TODAY }), 1000, TODAY).behind).toBe(false);
  });
  it("cannot be judged without a target, a date, a known current, or when not active", () => {
    expect(goalProgress(g("1440.01", { targetAmount: null }), 0, TODAY).behind).toBeNull();
    expect(goalProgress(g("1440.01", { targetDate: null }), 0, TODAY).behind).toBeNull();
    expect(goalProgress(g("1440.01"), null, TODAY).behind).toBeNull();
    expect(goalProgress(g("1440.01", { status: "paused" }), 0, TODAY).behind).toBeNull();
  });
});

describe("goal_behind detector", () => {
  const GOAL = "00000000-0000-4000-8000-00000000g001";
  const facts = (o: Partial<GoalFacts> = {}) =>
    calmFacts({
      goals: [
        {
          goalId: GOAL,
          kind: "savings",
          status: "active",
          targetAmount: "1440.01",
          manualCurrentAmount: "0",
          plaidAccountId: null,
          monthlyContribution: "100",
          targetDate: YEAR_OUT,
          reservedInChecking: false,
          current: "0.00",
          ...o,
        },
      ],
    });
  it("fires watch / estimate, once per goal per month, with ids and figures only", () => {
    const [f, ...rest] = detectGoalBehind(facts());
    expect(rest).toEqual([]);
    expect(f).toEqual({
      kind: "goal_behind",
      dedupeKey: `goal_behind:${GOAL}:2026-10`,
      severity: "watch",
      confidence: "estimate",
      payload: {
        goalId: GOAL,
        targetDate: YEAR_OUT,
        daysLeft: 365,
        overdue: false,
        target: 1440.01,
        current: 0,
        remaining: 1440.01,
        monthlyContribution: 100,
        requiredMonthly: 120.01,
      },
    });
  });
  it("does not fire one cent inside the boundary, or when paused, dateless or of unknown balance", () => {
    expect(detectGoalBehind(facts({ targetAmount: "1440.00" }))).toEqual([]);
    expect(detectGoalBehind(facts({ status: "paused" }))).toEqual([]);
    expect(detectGoalBehind(facts({ targetDate: null }))).toEqual([]);
    expect(detectGoalBehind(facts({ plaidAccountId: ACCT, current: null }))).toEqual([]);
  });
  it("is registered and runs with the others", () => {
    expect(DETECTED_KINDS).toContain("goal_behind");
    expect(runDetectors(facts()).map((f) => f.kind)).toEqual(["goal_behind"]);
    expect(runDetectors(calmFacts()).map((f) => f.kind)).toEqual([]);
  });
});

describe("metrics: goalsReservedTotal and goalsOnTrackCount", () => {
  const base = {
    asOf: TODAY,
    debts: null,
    snapshotsMtd: [],
    milestonesReached: 0,
    position: null,
    weekRows: null,
    monthRows: null,
    uncategorizedCount: null,
    reviewQueueSize: null,
    freshness: null,
    itemLastSyncedDays: null,
  };
  it("reads the reserve and counts goals on track", () => {
    const m = computeDailyMetrics({
      ...base,
      goals: [
        { ...goal({ reservedInChecking: true, manualCurrentAmount: "100.10" }), current: "100.10" },
        { ...goal({ reservedInChecking: true, manualCurrentAmount: "23.35", plaidAccountId: ACCT }), current: "5.00" },
        { ...goal({ targetAmount: "1440.00", monthlyContribution: "100", targetDate: YEAR_OUT }), current: "0" }, // on track
        { ...goal({ targetAmount: "1440.01", monthlyContribution: "100", targetDate: YEAR_OUT }), current: "0" }, // behind
        { ...goal({ targetAmount: "50", targetDate: YEAR_OUT }), current: "50" }, // reached: on track
        { ...goal({ targetAmount: "50", targetDate: YEAR_OUT, plaidAccountId: ACCT }), current: null }, // unknown
      ],
    });
    expect(m.goalsReservedTotal).toBe(100.1);
    expect(m.goalsOnTrackCount).toBe(2);
  });
  it("no goals is 0 and 0; no goals input is null (not live), and both are point-in-time", () => {
    expect(computeDailyMetrics({ ...base, goals: [] })).toMatchObject({ goalsReservedTotal: 0, goalsOnTrackCount: 0 });
    expect(computeDailyMetrics(base)).toMatchObject({ goalsReservedTotal: null, goalsOnTrackCount: null });
    expect(POINT_IN_TIME_FIELDS).toEqual(expect.arrayContaining(["goalsReservedTotal", "goalsOnTrackCount"]));
  });
});

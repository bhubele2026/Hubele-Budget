import type { Detector, Finding, FindingKind, MonitorFacts } from "../types";
import { detectBankStale } from "./bankStale";
import { detectBillIncrease } from "./billIncrease";
import { detectCategoryAcceleration } from "./categoryAcceleration";
import { detectDuplicateCharge } from "./duplicateCharge";
import { detectGoalBehind } from "./goalBehind";
import { detectLimitNear } from "./limitNear";
import { detectShortfall } from "./shortfall";

// Every detector the monitor runs. (PR-C) `goal_behind` joined with the goals
// table; its kind was already in the enum and the CHECK.

export const DETECTORS: ReadonlyArray<{ kind: FindingKind; run: Detector }> = [
  { kind: "bill_increase", run: detectBillIncrease },
  { kind: "category_acceleration", run: detectCategoryAcceleration },
  { kind: "shortfall_before_income", run: detectShortfall },
  { kind: "duplicate_charge", run: detectDuplicateCharge },
  { kind: "goal_behind", run: detectGoalBehind },
  { kind: "limit_near", run: detectLimitNear },
  { kind: "bank_stale", run: detectBankStale },
];

export const DETECTED_KINDS: ReadonlyArray<FindingKind> = DETECTORS.map((d) => d.kind);

export function runDetectors(facts: MonitorFacts): Finding[] {
  return DETECTORS.flatMap((d) => d.run(facts));
}

export {
  detectBankStale,
  detectBillIncrease,
  detectCategoryAcceleration,
  detectDuplicateCharge,
  detectGoalBehind,
  detectLimitNear,
  detectShortfall,
};

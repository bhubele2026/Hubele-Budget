import type { Detector, Finding, FindingKind, MonitorFacts } from "../types";
import { detectBankStale } from "./bankStale";
import { detectBillIncrease } from "./billIncrease";
import { detectCategoryAcceleration } from "./categoryAcceleration";
import { detectDuplicateCharge } from "./duplicateCharge";
import { detectLimitNear } from "./limitNear";
import { detectShortfall } from "./shortfall";

// Every detector the monitor runs. `goal_behind` is deliberately absent: the
// goals table arrives in PR-C (TODO in docs/reviews/2026-10-07-ai3-monitoring.md);
// the kind stays in the enum so that package adds a detector, not a migration.

export const DETECTORS: ReadonlyArray<{ kind: FindingKind; run: Detector }> = [
  { kind: "bill_increase", run: detectBillIncrease },
  { kind: "category_acceleration", run: detectCategoryAcceleration },
  { kind: "shortfall_before_income", run: detectShortfall },
  { kind: "duplicate_charge", run: detectDuplicateCharge },
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
  detectLimitNear,
  detectShortfall,
};

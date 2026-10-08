// ⭐ THE HOUSEHOLD SCENARIO — expected results, step by step.
//
// The written contract lives in docs/reviews/2026-09-11-household-scenario.md.
// This module is the same table as data, so householdScenario.integration.test
// asserts exactly what the document promises. Change one, change the other in
// the same PR.
//
// Every figure is hand-computed from the events below; the arithmetic for each
// step is written out in the document. All instants are America/Chicago
// (-05:00 in October 2026), chosen between 09:00 and 16:00 so the calendar date
// is the same in Chicago and in UTC — the scenario means the same thing on a
// Chicago laptop and on a UTC CI runner.

export const SCENARIO_START = "2026-10-04"; // Sunday
export const SCENARIO_END = "2026-10-10"; // Saturday

/** Chicago wall-clock instant. */
export const at = (isoLocal: string): Date => new Date(`${isoLocal}-05:00`);

export const SNAPSHOT = {
  balance: "2500.00",
  at: at("2026-10-04T08:00:00"),
  cashBuffer: "500.00",
};

/**
 * (PR-B1) The household's weekly cap: an `allowance_plans` row for the shared
 * pool, $300 from 2026-05-01 — the allowance the Weekly Spend bill funds.
 */
export const WEEKLY_CAP = { amount: "300.00", effectiveFrom: "2026-05-01" };

/**
 * (PR-B2, decision 7) The monthly allowance the Monthly Spend hook pays out on
 * the Blue: $400 from 2026-05-01. With the hooks, the allowance — not the bill's
 * stored amount — is the reserve, so the household's $400 lives here now.
 */
export const MONTHLY_CAP = { amount: "400.00", effectiveFrom: "2026-05-01" };

export const ACCOUNTS = {
  chase: { accountId: "hs-chase-5526", mask: "5526", name: "Chase Checking" },
  savings: { accountId: "hs-savings-8801", mask: "8801", name: "Chase Savings" },
  amexPlatinum: { accountId: "hs-amex-plat-1001", mask: "1001", name: "Amex Platinum" },
  amexBlue: { accountId: "hs-amex-blue-2002", mask: "2002", name: "Amex Blue" },
} as const;

export type StepId =
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7"
  | "S8"
  | "S9"
  | "S10";

export type StepExpectation = {
  when: Date;
  event: string;
  // ── Asserted now (what the app computes today) ─────────────────────────
  /** spine.bank.balance — the snapshot rolled forward through Chase rows. */
  cash: string;
  /** spine.spentWeek — real household spending, Sun 10/4 – Sat 10/10. */
  spentWeek: number;
  /** spine.reviewCount — unresolved Chase rows this month in the forecast. */
  reviewCount: number;
  /**
   * A column the app still gets wrong at this step, with the PR that fixes it
   * and what the app reports today. The test marks it pending instead of
   * asserting a known-wrong number.
   */
  notYet?: { column: "spentWeek"; turnsOnIn: string; appReportsToday: number };
  // ── (PR-B1) Asserted through GET /money/position at every step ─────────
  /** The weekly cap ($300) minus weekly-tagged and unfiled everyday spend. */
  remainingWeek: string;
  /** Purchases flagged unplanned this week. */
  unplannedWeek: string;
  /** Real spend that is neither planned nor unplanned (it counts against the cap). */
  needsClassificationWeek: string;
  // ── (PR-B2) Asserted at every step, now that the funding bills are hooks ──
  /** Expected end-of-day checking balance on Fri 10/16 (`GET /forecast/cash-signal`). */
  expectedFri1016: string;
  /** Lowest expected end-of-day balance from today through payday (its bills before its paycheck). */
  lowBeforePayday: { balance: string; date: string };
  // ── Contract for later PRs (it.todo until the named PR ships) ──────────
  /** Chase ledger rows this month not yet marked reviewed. PR13 / PR14. */
  chaseToReview: number;
  /** (PR-B1) Lowest before payday less the $500 buffer: what is free until payday. Asserted (PR-B2). */
  availableUntilPayday: string;
  /** (PR-B1) The smaller of remaining this week and available until payday. Asserted at every step. */
  safeToSpendNow: string;
  /** Bank freshness flag. PR3. */
  bankStale: false | "refresh_failed";
};

export const EXPECTED: Record<StepId, StepExpectation> = {
  S1: {
    when: at("2026-10-04T12:00:00"),
    event: "Household set up: $2,500 snapshot at 08:00, plans and accounts in place",
    cash: "2500.00",
    spentWeek: 0,
    reviewCount: 0,
    remainingWeek: "300.00",
    unplannedWeek: "0.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3485.00",
    lowBeforePayday: { balance: "2225.00", date: "2026-10-08" },
    chaseToReview: 0,
    availableUntilPayday: "1725.00",
    safeToSpendNow: "300.00",
    bankStale: false,
  },
  S2: {
    when: at("2026-10-05T12:00:00"),
    event: "Amex Platinum: groceries $96.60 and gas $45.00 (weekly)",
    cash: "2500.00",
    spentWeek: 141.6,
    reviewCount: 0,
    remainingWeek: "158.40",
    unplannedWeek: "0.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3485.00",
    lowBeforePayday: { balance: "2225.00", date: "2026-10-08" },
    chaseToReview: 0,
    availableUntilPayday: "1725.00",
    safeToSpendNow: "158.40",
    bankStale: false,
  },
  S3: {
    when: at("2026-10-06T12:00:00"),
    event:
      "Amex Platinum: hardware $85.00 (unplanned). Chase: $200 transfer to savings; last week's Amex payoff $180.00 posts",
    cash: "2120.00",
    spentWeek: 226.6,
    reviewCount: 2,
    remainingWeek: "158.40",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3200.00",
    lowBeforePayday: { balance: "2025.00", date: "2026-10-08" },
    chaseToReview: 2,
    availableUntilPayday: "1525.00",
    safeToSpendNow: "158.40",
    bankStale: false,
  },
  S4: {
    when: at("2026-10-07T12:00:00"),
    event: "Chase debit: Shell gas $45.00, pending (weekly)",
    cash: "2075.00",
    spentWeek: 271.6,
    reviewCount: 3,
    remainingWeek: "113.40",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3200.00",
    lowBeforePayday: { balance: "1980.00", date: "2026-10-08" },
    chaseToReview: 3,
    availableUntilPayday: "1480.00",
    safeToSpendNow: "113.40",
    bankStale: false,
  },
  S5: {
    when: at("2026-10-08T09:00:00"),
    event: "Shell posts at $47.40 (the pending row becomes the posted row)",
    cash: "2072.60",
    spentWeek: 274,
    reviewCount: 3,
    remainingWeek: "111.00",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3200.00",
    // (PR-B2) Fri 10/9: the $95 phone is due today, so it lands on the next
    // business day — payday — and counts before the paycheck (PR-B1 round 2).
    lowBeforePayday: { balance: "1977.60", date: "2026-10-09" },
    chaseToReview: 3,
    availableUntilPayday: "1477.60",
    safeToSpendNow: "111.00",
    bankStale: false,
  },
  S6: {
    when: at("2026-10-08T12:00:00"),
    event: "Phone bill ($95) moved from 10/8 to 10/14",
    cash: "2072.60",
    spentWeek: 274,
    reviewCount: 3,
    remainingWeek: "111.00",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3200.00",
    lowBeforePayday: { balance: "2072.60", date: "2026-10-08" },
    chaseToReview: 3,
    availableUntilPayday: "1572.60",
    safeToSpendNow: "111.00",
    bankStale: false,
  },
  S7: {
    when: at("2026-10-08T15:00:00"),
    event: "Electric bill on 10/13 goes from $140 to $165",
    cash: "2072.60",
    spentWeek: 274,
    reviewCount: 3,
    remainingWeek: "111.00",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3175.00",
    lowBeforePayday: { balance: "2072.60", date: "2026-10-08" },
    chaseToReview: 3,
    availableUntilPayday: "1572.60",
    safeToSpendNow: "111.00",
    bankStale: false,
  },
  S8: {
    when: at("2026-10-08T16:00:00"),
    event: "Chase refresh fails (ITEM_LOGIN_REQUIRED)",
    cash: "2072.60",
    spentWeek: 274,
    reviewCount: 3,
    remainingWeek: "111.00",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3175.00",
    lowBeforePayday: { balance: "2072.60", date: "2026-10-08" },
    chaseToReview: 3,
    availableUntilPayday: "1572.60",
    safeToSpendNow: "111.00",
    bankStale: "refresh_failed",
  },
  S9: {
    when: at("2026-10-09T09:00:00"),
    event: "Refresh succeeds; Paycheck A $2,000.00 posts on Chase",
    cash: "4072.60",
    spentWeek: 274,
    reviewCount: 4,
    remainingWeek: "111.00",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3175.00",
    lowBeforePayday: { balance: "1675.00", date: "2026-10-14" },
    chaseToReview: 4,
    availableUntilPayday: "1175.00",
    safeToSpendNow: "111.00",
    bankStale: false,
  },
  S10: {
    when: at("2026-10-10T10:00:00"),
    event:
      "Chase: Capital One card payment $150.00. Paycheck A match confirmed. Every Chase row marked reviewed",
    cash: "3922.60",
    spentWeek: 274,
    reviewCount: 4,
    remainingWeek: "111.00",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3025.00",
    lowBeforePayday: { balance: "1525.00", date: "2026-10-14" },
    chaseToReview: 0,
    availableUntilPayday: "1025.00",
    safeToSpendNow: "111.00",
    bankStale: false,
  },
};

/** Which later PR switches each contract column on. */
export const CONTRACT_COLUMNS: Array<{
  key: keyof StepExpectation;
  label: string;
  turnsOnIn: string;
}> = [
  { key: "bankStale", label: "bank freshness flag", turnsOnIn: "PR3" },
  { key: "chaseToReview", label: "Chase rows to review", turnsOnIn: "PR13 + PR14" },
];

/**
 * ⭐ (PR-B1, PR-B2) The money position's columns, read from `GET /money/position`
 * (the spine's `position` is the same call), asserted at every step. PR-B2's
 * hooks took the $300 Weekly Spend bill off the curve and put the Amex payoff
 * there, so the lowest before payday (asserted beside these) and available
 * until payday now read the contract at every step — PR-B1's pinned lower
 * values (`POSITION_LEDGER_NOT_YET`) are gone.
 */
export const POSITION_COLUMNS = [
  "remainingWeek",
  "unplannedWeek",
  "needsClassificationWeek",
  "availableUntilPayday",
  "safeToSpendNow",
] as const;

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
  // ── Contract for later PRs (it.todo until the named PR ships) ──────────
  /** Weekly Spend plan ($300) minus weekly-tagged everyday spend. PR8 / PR10. */
  remainingWeek: string;
  /** Purchases flagged unplanned this week. PR10. */
  unplannedWeek: string;
  /** Real spend that is neither planned nor unplanned. PR10. */
  needsClassificationWeek: string;
  /** Expected end-of-day checking balance on Fri 10/16. PR8 + PR9. */
  expectedFri1016: string;
  /** Lowest expected end-of-day balance from today until the next payday. PR9. */
  lowBeforePayday: { balance: string; date: string };
  /** Chase ledger rows this month not yet marked reviewed. PR13 / PR14. */
  chaseToReview: number;
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
    lowBeforePayday: { balance: "1977.60", date: "2026-10-08" },
    chaseToReview: 3,
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
    bankStale: false,
  },
  S10: {
    when: at("2026-10-10T10:00:00"),
    event:
      "Chase: Capital One card payment $150.00. Paycheck A match confirmed. Every Chase row marked reviewed",
    cash: "3922.60",
    spentWeek: 274,
    reviewCount: 4,
    notYet: { column: "spentWeek", turnsOnIn: "PR7", appReportsToday: 424 },
    remainingWeek: "111.00",
    unplannedWeek: "85.00",
    needsClassificationWeek: "0.00",
    expectedFri1016: "3025.00",
    lowBeforePayday: { balance: "1525.00", date: "2026-10-14" },
    chaseToReview: 0,
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
  { key: "remainingWeek", label: "remaining weekly allowance", turnsOnIn: "PR8" },
  { key: "expectedFri1016", label: "expected balance on Fri 10/16", turnsOnIn: "PR8 + PR9" },
  { key: "lowBeforePayday", label: "lowest before payday", turnsOnIn: "PR9" },
  { key: "unplannedWeek", label: "unplanned this week", turnsOnIn: "PR10" },
  {
    key: "needsClassificationWeek",
    label: "needs classification this week",
    turnsOnIn: "PR10",
  },
  { key: "chaseToReview", label: "Chase rows to review", turnsOnIn: "PR13 + PR14" },
];

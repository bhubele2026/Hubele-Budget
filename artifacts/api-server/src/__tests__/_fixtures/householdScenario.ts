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
  // ── Contract for later PRs (it.todo until the named PR ships) ──────────
  /** Expected end-of-day checking balance on Fri 10/16. PR8 + PR9. */
  expectedFri1016: string;
  /**
   * Lowest expected end-of-day balance from today until the next payday. PR9;
   * (PR-B1) asserted at the steps not in `POSITION_LEDGER_NOT_YET`.
   */
  lowBeforePayday: { balance: string; date: string };
  /** Chase ledger rows this month not yet marked reviewed. PR13 / PR14. */
  chaseToReview: number;
  /**
   * (PR-B1) Lowest before payday less the $500 buffer: what is free until
   * payday. Asserted with `lowBeforePayday`.
   */
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
    lowBeforePayday: { balance: "1977.60", date: "2026-10-08" },
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
  { key: "expectedFri1016", label: "expected balance on Fri 10/16", turnsOnIn: "PR8 + PR9" },
  { key: "chaseToReview", label: "Chase rows to review", turnsOnIn: "PR13 + PR14" },
];

/**
 * ⭐ (PR-B1) The money position's columns, read from `GET /money/position`
 * (the spine's `position` is the same call). Switched on at every step:
 * `remainingWeek`, `unplannedWeek`, `needsClassificationWeek` and
 * `safeToSpendNow`. Switched on where today's ledger already yields the
 * contract's value: `lowBeforePayday` and `availableUntilPayday`, at the steps
 * NOT listed in `POSITION_LEDGER_NOT_YET`.
 */
export const POSITION_COLUMNS = [
  "remainingWeek",
  "unplannedWeek",
  "needsClassificationWeek",
  "safeToSpendNow",
] as const;

/**
 * Steps where today's forecast ledger does not yet yield the contract's lowest
 * before payday (and so its available until payday), with the one-line reason
 * and what the app reports today. `it.todo` until the named package.
 */
export const POSITION_LEDGER_NOT_YET: Partial<
  Record<StepId, { turnsOnIn: string; reason: string; appReportsToday: { lowBeforePayday: string; availableUntilPayday: string } }>
> = {
  S1: {
    turnsOnIn: "the funding-bill hooks (decision 7, next package)",
    reason: "the ledger drags last Saturday's $300 Weekly Spend bill to Mon 10/5 instead of the $180 Amex payoff",
    appReportsToday: { lowBeforePayday: "2105.00 2026-10-08", availableUntilPayday: "1605.00" },
  },
  S2: {
    turnsOnIn: "the funding-bill hooks (decision 7, next package)",
    reason: "the ledger drags last Saturday's $300 Weekly Spend bill instead of the $180 Amex payoff",
    appReportsToday: { lowBeforePayday: "2105.00 2026-10-08", availableUntilPayday: "1605.00" },
  },
  S3: {
    turnsOnIn: "the funding-bill hooks (decision 7, next package)",
    reason: "the $180 payoff posted, but the ledger still drags the $300 Weekly Spend bill due 10/3 to Wed 10/7",
    appReportsToday: { lowBeforePayday: "1725.00 2026-10-08", availableUntilPayday: "1225.00" },
  },
  S4: {
    turnsOnIn: "the funding-bill hooks (decision 7, next package)",
    reason: "the ledger drags the $300 Weekly Spend bill due 10/3 to Thu 10/8",
    appReportsToday: { lowBeforePayday: "1680.00 2026-10-08", availableUntilPayday: "1180.00" },
  },
  S5: {
    turnsOnIn: "owner decision (PR6 rule)",
    reason: "a bill due today lands on the next business day (day 0 = the bank), so the $95 phone moves to payday Fri 10/9",
    appReportsToday: { lowBeforePayday: "2072.60 2026-10-08", availableUntilPayday: "1572.60" },
  },
  S9: {
    turnsOnIn: "the funding-bill hooks (decision 7, next package)",
    reason: "the ledger counts two $300 Weekly Spend bills (10/3 dragged to 10/12, and 10/10) instead of the $337.60 payoff",
    appReportsToday: { lowBeforePayday: "1412.60 2026-10-14", availableUntilPayday: "912.60" },
  },
  S10: {
    turnsOnIn: "the funding-bill hooks (decision 7, next package)",
    reason: "the ledger counts two $300 Weekly Spend bills (10/3 dragged to 10/12, and 10/10) instead of the $337.60 payoff",
    appReportsToday: { lowBeforePayday: "1262.60 2026-10-14", availableUntilPayday: "762.60" },
  },
};

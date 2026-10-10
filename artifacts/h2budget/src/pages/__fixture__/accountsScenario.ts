/**
 * (WP3) ONE household for the account parity test (`pages/accountsParity.test.tsx`):
 * every card and account case the financial-consistency audit named, on one
 * fixture, so every surface is rendered from the same payloads.
 *
 * Synthetic data. The live case is the audit's own figures: Amex Platinum
 * reported $3,842.98 with $2,615.71 of payments not posted yet.
 *
 *   case            account                         what it holds
 *   ─────────────── ─────────────────────────────── ────────────────────────────────────────────
 *   live            Amex Platinum ••1005            debt, active, 3,842.98 reported, 2,615.71 pending (2)
 *   duplicate mask  Amex Platinum ••1005 (AU twin)  its OWN debt, active, 250.00 — same last four
 *   zero            Amex Blue Cash ••1001           debt, active, 0.00 (a real zero)
 *   archived        Amex Gold ••1009                debt, ARCHIVED, 412.50 reported (still owing: "Archived", not "Paid off")
 *   missing mask    Amex Green (no mask)            debt, active, 96.40
 *   archived (A)    Amex Hilton ••1011              debt, ARCHIVED by hand at 0.00; Plaid says it owes 412.50
 *   archived (B)    Amex Delta ••1012               debt, ARCHIVED by hand holding 12.00; Plaid reported nothing
 *   off-plan        Citi Costco ••4410              no debt row; Plaid liability 684.12, min 40, due 14th
 *   missing         Citi Double Cash ••4411         no debt row; Plaid reported nothing
 *   stale           Capital One Quicksilver ••7788  debt, active, 642.18; its bank last synced 3 days ago
 *   savings         Chase Savings ••8801            snapshot 3,100.00 read Oct 6
 *   savings (none)  Chase Goal Savings ••8802       no reading
 *   checking        Chase Total Checking ••5526     the spine's account: 3,458.98 read Oct 2, +20 entries → 2,156.55
 *   (no account)    HELOC                           debt, active, 18,500.00
 *
 * The EXPECTED strings below are written out by hand, not computed with the
 * helpers under test, so the test cannot agree with itself by construction.
 */

/** Fri Oct 9 2026, 10:00 in Chicago — the harness's pinned instant. */
export const NOW = "2026-10-09T15:00:00Z";

const acct = (
  id: string, name: string, mask: string | null, type: string, subtype: string,
  snapshot: { balance: string; at: string; source: "manual" | "plaid" } | null = null,
) => ({
  id: `row-${id}`, accountId: `ext-${id}`, name, officialName: null, mask, type, subtype,
  importCutoffDate: null, firstSyncCompletedAt: "2026-09-01T00:00:00.000Z", snapshot,
});

const item = (id: string, institutionName: string, institutionSlug: string, lastSyncedAt: string, lastBankTxOn: string, accounts: unknown[]) => ({
  id: `item-${id}`, itemId: `plaid-item-${id}`, institutionId: null, institutionName, institutionSlug,
  lastSyncedAt, lastSyncError: null, lastSyncErrorCode: null, stillPreparing: false, stillPreparingSince: null,
  consentExpirationAt: null, lastBankTxOn, accounts,
});

export const ITEMS = [
  item("chase", "Chase", "chase", "2026-10-09T13:00:00.000Z", "2026-10-08", [
    acct("chk", "Total Checking", "5526", "depository", "checking", { balance: "3458.98", at: "2026-10-02T15:00:00.000Z", source: "plaid" }),
    acct("sav", "Savings", "8801", "depository", "savings", { balance: "3100.00", at: "2026-10-06T14:00:00.000Z", source: "plaid" }),
    acct("sav2", "Goal Savings", "8802", "depository", "savings", null),
  ]),
  item("amex", "American Express", "amex", "2026-10-09T12:00:00.000Z", "2026-10-08", [
    acct("plat", "Platinum Card", "1005", "credit", "credit card"),
    acct("plat2", "Platinum Card", "1005", "credit", "credit card"),
    acct("blue", "Blue Cash Preferred", "1001", "credit", "credit card"),
    acct("gold", "Gold Card", "1009", "credit", "credit card"),
    acct("green", "Green Card", null, "credit", "credit card"),
    acct("hilton", "Hilton Honors Card", "1011", "credit", "credit card"),
    acct("delta", "Delta Gold Card", "1012", "credit", "credit card"),
  ]),
  item("citi", "Citi", "citi", "2026-10-09T11:00:00.000Z", "2026-10-07", [
    acct("citi", "Costco Anywhere", "4410", "credit", "credit card"),
    acct("citi2", "Double Cash", "4411", "credit", "credit card"),
  ]),
  item("cap", "Capital One", "capone", "2026-10-06T12:00:00.000Z", "2026-10-05", [
    acct("cap", "Quicksilver", "7788", "credit", "credit card"),
  ]),
];

const debt = (id: string, name: string, balance: string, o: Record<string, unknown> = {}) => ({
  id: `d-${id}`, name, balance, originalBalance: null, apr: "0.2299", minPayment: "0", payment: "0", type: "credit_card",
  status: "active", sortOrder: 0, dueDay: null, statementDay: null, notes: null,
  lastBalanceUpdate: "2026-10-09T11:00:00.000Z", plaidAccountId: null, plaidLastSyncedAt: "2026-10-09T11:00:05.000Z",
  balanceSource: "plaid", aprSource: "plaid", minPaymentSource: "plaid", pendingPaymentTotal: null, pendingPaymentCount: null,
  ...o,
});

export const DEBTS = [
  debt("heloc", "HELOC", "18500.00", { apr: "0.0899", minPayment: "250.00", payment: "250.00", type: "heloc", originalBalance: "25000.00", balanceSource: "manual", plaidLastSyncedAt: null, sortOrder: 1 }),
  debt("plat", "Amex Platinum", "3842.98", { plaidAccountId: "row-plat", pendingPaymentTotal: "2615.71", pendingPaymentCount: 2, dueDay: 22, originalBalance: "5000.00", sortOrder: 2 }),
  debt("plat2", "Amex Platinum (AU)", "250.00", { plaidAccountId: "row-plat2", minPayment: "35.00", dueDay: 22, originalBalance: "400.00", sortOrder: 3 }),
  debt("blue", "Amex Blue Cash", "0.00", { plaidAccountId: "row-blue", dueDay: 3, originalBalance: "1200.00", sortOrder: 4 }),
  debt("gold", "Amex Gold", "412.50", { plaidAccountId: "row-gold", status: "archived", originalBalance: "900.00", sortOrder: 5 }),
  debt("green", "Amex Green", "96.40", { plaidAccountId: "row-green", minPayment: "25.00", dueDay: 9, originalBalance: "150.00", sortOrder: 6 }),
  debt("hilton", "Amex Hilton", "0.00", { plaidAccountId: "row-hilton", status: "archived", balanceSource: "manual", originalBalance: "800.00", lastBalanceUpdate: "2026-09-19T12:00:00.000Z", plaidLastSyncedAt: null, sortOrder: 8 }),
  debt("delta", "Amex Delta", "12.00", { plaidAccountId: "row-delta", status: "archived", balanceSource: "manual", originalBalance: "300.00", lastBalanceUpdate: "2026-09-20T12:00:00.000Z", plaidLastSyncedAt: null, sortOrder: 9 }),
  debt("cap", "Quicksilver", "642.18", { plaidAccountId: "row-cap", minPayment: "40.00", dueDay: 18, originalBalance: "1500.00", lastBalanceUpdate: "2026-10-06T12:00:00.000Z", plaidLastSyncedAt: "2026-10-06T12:00:05.000Z", sortOrder: 7 }),
];

/** Plaid's stored liability figures (`GET /plaid/liability-accounts`): the cards with no debt row and the archived ones. */
export const LIABILITIES = [
  { id: "row-hilton", accountId: "ext-hilton", itemId: "item-amex", name: "Hilton Honors Card", mask: "1011", type: "credit", subtype: "credit card",
    liabilityKind: "credit", balance: "412.50", apr: "0.2099", minPayment: "35.00", lastFetchedAt: "2026-10-09T10:00:00.000Z",
    institutionName: "American Express", institutionSlug: "amex", linkedDebt: { id: "d-hilton", name: "Amex Hilton" }, suggestedDebt: null },
  { id: "row-delta", accountId: "ext-delta", itemId: "item-amex", name: "Delta Gold Card", mask: "1012", type: "credit", subtype: "credit card",
    liabilityKind: "credit", balance: null, apr: null, minPayment: null, lastFetchedAt: null,
    institutionName: "American Express", institutionSlug: "amex", linkedDebt: { id: "d-delta", name: "Amex Delta" }, suggestedDebt: null },
  { id: "row-citi", accountId: "ext-citi", itemId: "item-citi", name: "Costco Anywhere", mask: "4410", type: "credit", subtype: "credit card",
    liabilityKind: "credit", balance: "684.12", apr: "0.2049", minPayment: "40.00", lastFetchedAt: "2026-10-09T10:00:00.000Z",
    institutionName: "Citi", institutionSlug: "citi", linkedDebt: null,
    suggestedDebt: { name: "Citi Costco Anywhere", type: "credit_card", balance: "684.12", apr: "0.2049", minPayment: "40.00", dueDay: 14, statementDay: 20 } },
  { id: "row-citi2", accountId: "ext-citi2", itemId: "item-citi", name: "Double Cash", mask: "4411", type: "credit", subtype: "credit card",
    liabilityKind: "credit", balance: null, apr: null, minPayment: null, lastFetchedAt: null,
    institutionName: "Citi", institutionSlug: "citi", linkedDebt: null,
    suggestedDebt: { name: "Citi Double Cash", type: "credit_card", balance: null, apr: null, minPayment: null, dueDay: null, statementDay: null } },
];

/** The weekly payoff for the Platinum (its "This week's charges"). */
export const PAYOFF = {
  cards: [
    { accountId: "ext-plat", plaidAccountId: "row-plat", name: "Platinum Card", brand: "platinum", weekCharges: 120, chargeCount: 3, statementBalance: 3842.98, pctOfStatementThisWeek: 0.031, topMerchant: null, cadence: "weekly", periodLabel: "This week", displayName: "Platinum", debtId: "d-plat" },
  ],
  combinedStatementBalance: 3842.98,
  combinedWeekCharges: 120,
};

/**
 * The spine (WP1): checking's balance today is the Oct 2 snapshot rolled
 * forward through 20 entries — 3,458.98 − 1,302.43 = 2,156.55 — on account
 * row-chk, named BY ID.
 */
export const SPINE = {
  asOf: NOW,
  bank: {
    balance: "2156.55", asOfDate: "2026-10-02T15:00:00.000Z", source: "plaid", lastContactAt: "2026-10-09T13:00:00.000Z", lastFailureAt: null, stale: false, staleReason: null,
    snapshot: { balance: "3458.98", at: "2026-10-02T15:00:00.000Z", source: "plaid" },
    sinceSnapshot: { net: "-1302.43", count: 20, through: "2026-10-09" },
    account: { rowId: "row-chk", externalId: "ext-chk", name: "Total Checking", mask: "5526", subtype: "checking", via: "pointer" },
  },
  spentMonth: 900, spentWeek: 120,
  nextBill: null, billsDueCount: 0,
  forecast: { lowPoint: "1200.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "ready" },
  debt: { payoffPct: 31, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 },
  reviewCount: 0,
  position: { safeToSpendNow: "210.00", remainingWeek: "210.00", availableUntilPayday: "400.00", paydayDate: "2026-10-16", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false, weekAdjustment: null },
};

/** Every string a surface must print, per concept, written out by hand. */
export const EXPECT = {
  checking: { ext: "ext-chk", balance: "$2,156.55", snapshotLine: "Snapshot $3,458.98 · Oct 2 · +20 entries", snapshot: "$3,458.98", caption: "Oct 2 · +20 entries", since: "Includes 20 entries since the Oct 2 snapshot" },
  live: { ext: "ext-plat", debtId: "d-plat", owed: "$1,227.27", creditor: "$3,842.98", pending: "$2,615.71" },
  twin: { ext: "ext-plat2", debtId: "d-plat2", owed: "$250.00" },
  zero: { ext: "ext-blue", debtId: "d-blue", owed: "$0.00" },
  archived: { ext: "ext-gold", debtId: "d-gold", words: "Archived · not on the payoff plan", creditor: "$412.50" },
  noMask: { ext: "ext-green", debtId: "d-green", owed: "$96.40" },
  /** (WP3c) One archived decision: Plaid's figure beats the row ($0 row, Plaid $412.50 → Archived)… */
  caseA: { ext: "ext-hilton", debtId: "d-hilton", name: "Amex Hilton", words: "Archived · not on the payoff plan", creditor: "$412.50" },
  /** …and with no Plaid figure the row's balance decides ($12 row → Archived). */
  caseB: { ext: "ext-delta", debtId: "d-delta", name: "Amex Delta", words: "Archived · not on the payoff plan", creditor: "$12.00" },
  offPlan: { ext: "ext-citi", words: "Not on the payoff plan", creditor: "$684.12" },
  missing: { ext: "ext-citi2", words: "No balance, minimum or due date reported for this card yet." },
  stale: { ext: "ext-cap", debtId: "d-cap", owed: "$642.18" },
  savings: { ext: "ext-sav", line: "Snapshot $3,100.00 · as of Oct 6 · not rolled forward", figure: "$3,100.00", caption: "as of Oct 6 · not rolled forward" },
  savingsNone: { ext: "ext-sav2", words: "Savings balance is not tracked yet." },
  /** Active debts, netted; the archived Gold (412.50) and the off-plan Costco (684.12) are not in it. */
  left: "$20,715.85",
  leftNames: "HELOC, Amex Platinum, Amex Platinum (AU), Amex Green and Quicksilver",
  /** (WP4) The cards the total leaves out that still carry (or may carry) a balance: archived Gold, off-plan Costco, Double Cash (unknown). */
  offPlanLine: "American Express Gold Card ••1009, American Express Hilton Honors Card ••1011, American Express Delta Gold Card ••1012, Citi Costco Anywhere ••4410 and Citi Double Cash ••4411 are not on the plan",
} as const;

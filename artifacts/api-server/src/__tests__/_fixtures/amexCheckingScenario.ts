// ⭐ PACKAGE B4 — THE AMEX + CHECKING SCENARIO, step by step.
//
// One household, one checking account (Chase ••1234) and one Amex card
// (American Express ••1005), five events, every figure the app shows read back
// through the real routes after each one. The contract, the hand arithmetic and
// the differences found are in docs/reviews/2026-10-08-b4-money-proof.md. This
// module is the same table as data; change one, change the other.
//
// All instants are America/Chicago (-05:00 in October 2026), between 09:00 and
// 16:00, so the calendar date is the same in Chicago and in UTC.
//
// Plaid's sign convention (positive = money out of the account) is used for the
// events below, exactly as `/transactions/sync` sends them; the sync stores the
// opposite sign (negative = spend).

/** Chicago wall-clock instant. */
export const at = (isoLocal: string): Date => new Date(`${isoLocal}-05:00`);

export const SNAPSHOT = { balance: "2500.00", at: at("2026-10-04T08:00:00"), cashBuffer: "500.00" };
export const WEEKLY_CAP = { amount: "300.00", effectiveFrom: "2026-05-01" };
/** One income plan: $2,000 on the 16th — the payday the position reads up to. */
export const PAYCHECK = { amount: "2000", anchorDate: "2026-10-16" };
/**
 * The Amex card as a debt with an anchor: a debt row named "American Express",
 * $500.00 owed of $1,000.00 at the anchor, and `settings.amexAnchor` at the same
 * $500.00. The card's earlier history is one $500.00 charge in August, so the
 * anchor the sync recomputes from the card's rows starts where the debt does.
 */
export const AMEX_DEBT = { name: "American Express", balance: "500.00", originalBalance: "1000.00" };
export const AMEX_HISTORY = { id: "b4-amex-hist-0814", date: "2026-08-14", name: "DELTA AIR LINES", amount: "-500.00" };

export const ACCOUNTS = {
  chase: { accountId: "b4-chase-chk-1234", mask: "1234", name: "Total Checking", institution: "Chase" },
  amex: { accountId: "b4-amex-plat-1005", mask: "1005", name: "Platinum Card", institution: "American Express" },
} as const;

const GROCERIES_PFC = { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" };
const CARD_PAYMENT_PFC = { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };

/** The Plaid rows each step's sync delivers (ids are suffixed per run). */
export const PLAID = {
  amexPending: { id: "b4-amex-kroger-pending", account: "amex", date: "2026-10-05", amount: 86.33, name: "KROGER #442", pending: true, pfc: GROCERIES_PFC },
  chasePurchase: { id: "b4-chase-kroger", account: "chase", date: "2026-10-05", amount: 42.1, name: "KROGER #442", pending: false, pfc: GROCERIES_PFC },
  amexPosted: { id: "b4-amex-kroger-posted", account: "amex", date: "2026-10-06", amount: 86.33, name: "KROGER #442", pending: false, pfc: GROCERIES_PFC },
  amexRefund: { id: "b4-amex-kroger-refund", account: "amex", date: "2026-10-08", amount: -20, name: "KROGER #442 REFUND", pending: false, pfc: GROCERIES_PFC },
  chasePayment: { id: "b4-chase-amex-pmt", account: "chase", date: "2026-10-12", amount: 100, name: "AMERICAN EXPRESS ACH PMT M2481", pending: false, pfc: CARD_PAYMENT_PFC },
  amexPayment: { id: "b4-amex-pmt-in", account: "amex", date: "2026-10-12", amount: -100, name: "ONLINE PAYMENT - THANK YOU", pending: false, pfc: CARD_PAYMENT_PFC },
} as const;

export type StepId = "S0" | "S1" | "S2" | "S3a" | "S3b" | "S4" | "S5";

/** Everything one step reads back, as the screens and the client read it. */
export type Observed = {
  /** GET /transactions: "<institution> ••<mask> | date | description | amount | posted/pending | category | locked?" */
  rows: string[];
  /** GET /transactions/ledger (the Chase page): rows with running balance, totals, today. */
  chase: { rows: string[]; moneyIn: string; moneyOut: string; net: string; balanceToday: string | null };
  /** GET /transactions/balances: end-of-day register balances 10/04 … 10/12 (null after today). */
  chaseEndOfDay: Array<string | null>;
  /** GET /amex/anchor + GET /amex/weekly-payoff?weekStart=2026-10-04 (the Amex page). */
  amex: { endingBalance: string | null; source: string; weekCharges: string; chargeCount: number; combinedWeekCharges: string };
  /** Spine: expense totals (household spend), cash, review count. */
  spentWeek: string;
  spentMonth: string;
  cash: string;
  reviewCount: number;
  /** Spine `debt.*` — never a balance. */
  debt: { payoffPct: string | null; paidDownMtd: string; confirmedPaymentsMtd: string; newChargesMtd: string; nextMilestone: string | null };
  /** GET /money/position (= spine.position). */
  position: {
    remainingWeek: string | null;
    unplannedWeek: string;
    needsClassificationWeek: string;
    lowestUntilPayday: string | null;
    availableUntilPayday: string | null;
    safeToSpendNow: string | null;
  };
  /**
   * GET /forecast/cash-signal (= GET /forecast's cashSignal), through Sat 10/17:
   * the payoff hook's expense events, every OTHER expense event (none: no
   * purchase or payment is ever a second expense), the curve, and the due
   * payoffs a checking payment paid ("label occurrence plan <payoff> ← row amount").
   */
  forecast: { hookEvents: string[]; otherExpenses: string[]; curve: Record<string, string | null>; assumedPaid: string[] };
  /** GET /categorization/review: "description | source | band | suggestion". */
  queue: string[];
  /**
   * (S4) GET /banking/review?from=2026-10-01&to=<today> for the checking
   * account: every row "not in the plan" as "<bucket> <reason> <kind> |
   * <description> <amount>[ | plan <label> <due> <planned> diff <difference>
   * <days>d]", the plan occurrences due ("<due> <label> <fate> <planned>"),
   * the cash flow's net, how many rows paid their plan cleanly, and what the
   * reconciliation cannot explain (always "0.00").
   */
  banking: { rows: string[]; planned: string[]; net: string; asPlanned: number; unexplained: string };
  /**
   * (S5) GET /amex/summary. `week`: the card (accountId) over the payoff week
   * 10/04 – 10/10 — owed, "amount/count" for purchases, refunds, payments and
   * "<otherCharges> <otherCredits> <notMine>", what it added to the household
   * week (`weeklyPlan`, `unfiled`), the plan it answers to ("<kind> <payoff>
   * <payoffDate> <basis>") and the purchases to resolve ("<group> |
   * <displayName> | <amount> | pending/posted | <category or —> | <flags>").
   * `month`: every Amex card ("all") from 10/01 to today.
   */
  amexSummary: {
    week: {
      owed: string | null;
      purchases: string;
      refunds: string;
      payments: string;
      other: string;
      weeklyPlan: string;
      unfiled: string;
      plan: string;
      attention: string[];
    };
    month: { owed: string | null; purchases: string; refunds: string; payments: string };
  };
};

/**
 * ⭐ EXPECTED — the contract (decision 7, the one spending rule, the bank
 * register) worked by hand for these events. Arithmetic in the review note.
 */
export const EXPECTED: Record<StepId, Observed> = {
  S0: {
    rows: ["American Express ••1005 | 2026-08-14 | DELTA AIR LINES | -500.00 | posted | Travel | locked"],
    chase: { rows: [], moneyIn: "0.00", moneyOut: "0.00", net: "0.00", balanceToday: "2500.00" },
    chaseEndOfDay: ["2500.00", null, null, null, null, null, null, null, null],
    amex: { endingBalance: "500.00", source: "debt", weekCharges: "0.00", chargeCount: 0, combinedWeekCharges: "0.00" },
    spentWeek: "0.00",
    spentMonth: "0.00",
    cash: "2500.00",
    reviewCount: 0,
    debt: { payoffPct: "50.000", paidDownMtd: "0.00", confirmedPaymentsMtd: "0.00", newChargesMtd: "0.00", nextMilestone: null },
    position: {
      remainingWeek: "300.00",
      unplannedWeek: "0.00",
      needsClassificationWeek: "0.00",
      lowestUntilPayday: "2200.00 @ 2026-10-10",
      availableUntilPayday: "1700.00",
      safeToSpendNow: "300.00",
    },
    forecast: {
      hookEvents: ["2026-10-10 -300.00", "2026-10-17 -300.00"],
      otherExpenses: [],
      curve: ({ "2026-10-10": "2200.00", "2026-10-12": "2200.00", "2026-10-16": "4200.00", "2026-10-17": "3900.00" }),
      assumedPaid: [],
    },
    queue: [],
    banking: { rows: [], planned: [], net: "0.00", asPlanned: 0, unexplained: "0.00" },
    // (S5) The card has no Plaid balance and no debt row of its own (the debt is
    // matched by name), so ITS owed is unknown — null, never 0.00 — while the
    // combined anchor ("all") is the debt's 500.00. The hook pays the card.
    amexSummary: {
      week: {
        owed: null,
        purchases: "0.00/0",
        refunds: "0.00/0",
        payments: "0.00/0",
        other: "0.00/0 0.00/0 0.00/0",
        weeklyPlan: "0.00",
        unfiled: "0.00",
        plan: "weekly_hook 300.00 2026-10-10 plan",
        attention: [],
      },
      month: { owed: "500.00", purchases: "0.00/0", refunds: "0.00/0", payments: "0.00/0" },
    },
  },
  S1: {} as Observed,
  S2: {} as Observed,
  S3a: {} as Observed,
  S3b: {} as Observed,
  S4: {} as Observed,
  S5: {} as Observed,
};

const HIST = EXPECTED.S0.rows[0]!;
const AMEX_PENDING = "American Express ••1005 | 2026-10-05 | KROGER #442 | -86.33 | pending | — | unlocked";
const CHASE_KROGER = "Chase ••1234 | 2026-10-05 | KROGER #442 | -42.10 | posted | — | unlocked";

// S1 · Mon 10/5 — the Amex charge arrives pending. It is owed on the card, it is
// household spending this week, and it moves allowance from "left" to
// "charged": the Saturday payoff holds at $300.00 (86.33 + 213.67).
// (WP8, owner's decision 2026-10-10) The Amex page bills what the hook bills —
// every charge on the card, filed or not — so it shows the unfiled $86.33 now
// (it showed $0.00 until a person filed it, at S3a).
EXPECTED.S1 = {
  ...EXPECTED.S0,
  rows: [AMEX_PENDING, HIST],
  chaseEndOfDay: ["2500.00", "2500.00", null, null, null, null, null, null, null],
  amex: { ...EXPECTED.S0.amex, endingBalance: "586.33", weekCharges: "86.33", chargeCount: 1, combinedWeekCharges: "86.33" },
  spentWeek: "86.33",
  spentMonth: "86.33",
  debt: { ...EXPECTED.S0.debt, payoffPct: "41.367" },
  position: { ...EXPECTED.S0.position, remainingWeek: "213.67", needsClassificationWeek: "86.33", safeToSpendNow: "213.67" },
  // (S5) One unfiled purchase: in the card's purchases, in the household week, to resolve.
  amexSummary: {
    week: {
      ...EXPECTED.S0.amexSummary.week,
      purchases: "86.33/1",
      weeklyPlan: "86.33",
      unfiled: "86.33",
      attention: ["unfiled | Kroger #442 | 86.33 | pending | — | unfiled uncategorized"],
    },
    month: { ...EXPECTED.S0.amexSummary.month, owed: "586.33", purchases: "86.33/1" },
  },
};

// S2 · Mon 10/5 — the checking charge posts. It already left the bank, so the
// payoff shrinks by exactly that debit (257.90 = 86.33 + 171.57) and the curve
// on Saturday reads the same 2,200.00.
EXPECTED.S2 = {
  ...EXPECTED.S1,
  rows: [AMEX_PENDING, CHASE_KROGER, HIST],
  chase: { rows: ["2026-10-05 KROGER #442 -42.10 → 2457.90"], moneyIn: "0.00", moneyOut: "42.10", net: "-42.10", balanceToday: "2457.90" },
  chaseEndOfDay: ["2500.00", "2457.90", null, null, null, null, null, null, null],
  spentWeek: "128.43",
  spentMonth: "128.43",
  cash: "2457.90",
  reviewCount: 1,
  position: { ...EXPECTED.S1.position, remainingWeek: "171.57", needsClassificationWeek: "128.43", safeToSpendNow: "171.57" },
  forecast: { ...EXPECTED.S1.forecast, hookEvents: ["2026-10-10 -257.90", "2026-10-17 -300.00"] },
  // (S4) The checking purchase was not in any plan: unmatched spending, never a bill.
  banking: { ...EXPECTED.S1.banking, rows: ["unmatched no_plan spending | KROGER #442 -42.10"], net: "-42.10" },
  // (S5) The Chase purchase is not the card's; only the hook's payoff moves.
  amexSummary: { ...EXPECTED.S1.amexSummary, week: { ...EXPECTED.S1.amexSummary.week, plan: "weekly_hook 257.90 2026-10-10 plan" } },
};

// S3a · Tue 10/6 — a person files the pending Amex charge as Groceries. No figure
// moves. (WP8) The Amex page already counted the charge unfiled ($86.33 since S1);
// before the owner's decision it counted filed charges only and moved here.
const AMEX_PENDING_FILED = "American Express ••1005 | 2026-10-05 | KROGER #442 | -86.33 | pending | Groceries | locked";
EXPECTED.S3a = {
  ...EXPECTED.S2,
  rows: [AMEX_PENDING_FILED, CHASE_KROGER, HIST],
  chaseEndOfDay: ["2500.00", "2457.90", "2457.90", null, null, null, null, null, null],
  amex: { ...EXPECTED.S2.amex, weekCharges: "86.33", chargeCount: 1, combinedWeekCharges: "86.33" },
  // (S5) Categorized, still not filed to an allowance: still to resolve.
  amexSummary: {
    ...EXPECTED.S2.amexSummary,
    week: { ...EXPECTED.S2.amexSummary.week, attention: ["unfiled | Kroger #442 | 86.33 | pending | Groceries | unfiled"] },
  },
};

// S3b · Wed 10/7 — the charge posts under a new id (same amount, dated 10/6). The
// pending row is re-keyed in place: one row, still Groceries, still locked.
const AMEX_POSTED = "American Express ••1005 | 2026-10-06 | KROGER #442 | -86.33 | posted | Groceries | locked";
EXPECTED.S3b = {
  ...EXPECTED.S3a,
  rows: [AMEX_POSTED, CHASE_KROGER, HIST],
  chaseEndOfDay: ["2500.00", "2457.90", "2457.90", "2457.90", null, null, null, null, null],
  // (S5) Posted: the same purchase, once.
  amexSummary: {
    ...EXPECTED.S3a.amexSummary,
    week: { ...EXPECTED.S3a.amexSummary.week, attention: ["unfiled | Kroger #442 | 86.33 | posted | Groceries | unfiled"] },
  },
};

// S4 · Thu 10/8 — a $20.00 refund on the card. The brief: refunds net (spend
// 108.43, remaining 191.57, Amex charges 66.33); the payoff for the open week is
// 257.90 either way (66.33 + 191.57 = 86.33 + 171.57). The refund is queued as a
// refund of the Kroger charge, not filed.
const AMEX_REFUND = "American Express ••1005 | 2026-10-08 | KROGER #442 REFUND | 20.00 | posted | — | unlocked";
EXPECTED.S4 = {
  ...EXPECTED.S3b,
  rows: [AMEX_REFUND, AMEX_POSTED, CHASE_KROGER, HIST],
  chaseEndOfDay: ["2500.00", "2457.90", "2457.90", "2457.90", "2457.90", null, null, null, null],
  amex: { endingBalance: "566.33", source: "debt", weekCharges: "66.33", chargeCount: 1, combinedWeekCharges: "66.33" },
  spentWeek: "108.43",
  spentMonth: "108.43",
  debt: { ...EXPECTED.S3b.debt, payoffPct: "43.367" },
  position: { ...EXPECTED.S3b.position, remainingWeek: "191.57", needsClassificationWeek: "108.43", safeToSpendNow: "191.57" },
  queue: ["KROGER #442 REFUND | refund | queue | Groceries"],
  // (S5) The refund is its own bucket: purchases − refunds = 66.33 = the card's weekCharges.
  // The household week nets it (66.33); the purchase to resolve is still the 86.33 charge.
  amexSummary: {
    week: { ...EXPECTED.S3b.amexSummary.week, refunds: "20.00/1", weeklyPlan: "66.33", unfiled: "66.33" },
    month: { ...EXPECTED.S3b.amexSummary.month, owed: "566.33", refunds: "20.00/1" },
  },
};

// S5 · Mon 10/12 — $100.00 from checking to the card. The closed week owes its
// charges alone and the payment (names Amex, covers it, dated from the
// occurrence) pays it: the payoff leaves the curve, the $100 counts once, in
// cash today. Not spending: this week's spend is 0.00 and the month's is unchanged.
const CHASE_PMT = "Chase ••1234 | 2026-10-12 | AMERICAN EXPRESS ACH PMT M2481 | -100.00 | posted | — | unlocked";
const AMEX_PMT = "American Express ••1005 | 2026-10-12 | ONLINE PAYMENT - THANK YOU | 100.00 | posted | — | unlocked";
EXPECTED.S5 = {
  ...EXPECTED.S4,
  rows: [AMEX_PMT, CHASE_PMT, AMEX_REFUND, AMEX_POSTED, CHASE_KROGER, HIST],
  chase: {
    rows: ["2026-10-05 KROGER #442 -42.10 → 2457.90", "2026-10-12 AMERICAN EXPRESS ACH PMT M2481 -100.00 → 2357.90"],
    moneyIn: "0.00",
    moneyOut: "142.10",
    net: "-142.10",
    balanceToday: "2357.90",
  },
  chaseEndOfDay: ["2500.00", "2457.90", "2457.90", "2457.90", "2457.90", "2457.90", "2457.90", "2457.90", "2357.90"],
  amex: { ...EXPECTED.S4.amex, endingBalance: "466.33" },
  spentWeek: "0.00",
  cash: "2357.90",
  reviewCount: 2,
  debt: { ...EXPECTED.S4.debt, payoffPct: "53.367" },
  position: {
    remainingWeek: "300.00",
    unplannedWeek: "0.00",
    needsClassificationWeek: "0.00",
    lowestUntilPayday: "2357.90 @ 2026-10-12",
    availableUntilPayday: "1857.90",
    safeToSpendNow: "300.00",
  },
  forecast: {
    hookEvents: ["2026-10-17 -300.00"],
    otherExpenses: [],
    curve: { "2026-10-10": null, "2026-10-12": "2357.90", "2026-10-16": "4357.90", "2026-10-17": "4057.90" },
    assumedPaid: ["Weekly Spend 2026-10-10 plan -66.33 ← AMERICAN EXPRESS ACH PMT M2481 -100.00"],
  },
  queue: ["AMERICAN EXPRESS ACH PMT M2481 | heuristic | queue | —", "KROGER #442 REFUND | refund | queue | Groceries"],
  // (S4) The card payment paid the closed week's payoff (the forecast's own
  // evidence): planned, but $33.67 more than the plan, 2 days after it — never
  // discretionary spending.
  banking: {
    rows: [
      "amountDifference amount card_payment | AMERICAN EXPRESS ACH PMT M2481 -100.00 | plan Weekly Spend 2026-10-10 -66.33 diff 33.67 2d",
      "unmatched no_plan spending | KROGER #442 -42.10",
    ],
    planned: ["2026-10-10 Weekly Spend paid_on_evidence -66.33"],
    net: "-142.10",
    asPlanned: 0,
    unexplained: "0.00",
  },
  // (S5) The week closed: its payoff is its charges alone (66.33). The card's
  // payment lands in the month's payments — never a purchase, never a refund.
  amexSummary: {
    week: { ...EXPECTED.S4.amexSummary.week, plan: "weekly_hook 66.33 2026-10-10 plan" },
    month: { ...EXPECTED.S4.amexSummary.month, owed: "466.33", payments: "100.00/1" },
  },
};

/** When each step happens. */
export const WHEN: Record<StepId, Date> = {
  S0: at("2026-10-04T12:00:00"),
  S1: at("2026-10-05T12:00:00"),
  S2: at("2026-10-05T15:00:00"),
  S3a: at("2026-10-06T12:00:00"),
  S3b: at("2026-10-07T12:00:00"),
  S4: at("2026-10-08T12:00:00"),
  S5: at("2026-10-12T12:00:00"),
};

export const EOD_DATES = [
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-10",
  "2026-10-11",
  "2026-10-12",
] as const;

// ── ⚠️ DIFFERENCES — where the app reports something else today ─────────────
//
// Each is documented (expected vs observed, the function) in the review note,
// section "Differences". None is fixed here (MONEY LAW: B4 changes no financial
// logic). The test asserts the app's value at these paths — pinned so the
// package that changes one notices — and lists each as an it.todo carrying the
// contract's value.

// (B5) D3 — the Amex anchor never moved after a Plaid sync — is fixed.
// (B6) D1 — a refund did not net — and D2 — the refund was not queued — are
// fixed (docs/reviews/2026-10-08-b6-refunds.md). No difference remains: every
// figure of every step is asserted at the contract's value.
export type DifferenceId = never;
export const DIFFERENCE_TITLES: Record<DifferenceId, string> = {};
export type Difference = { id: DifferenceId; path: string; today: unknown };

export const DIFFERENCES: Record<StepId, Difference[]> = {
  S0: [],
  S1: [],
  S2: [],
  S3a: [],
  S3b: [],
  S4: [],
  S5: [],
};

const getPath = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], o);

/** The contract's value at a difference's path. */
export const contractValue = (step: StepId, path: string): unknown => getPath(EXPECTED[step], path);

/** EXPECTED with each documented difference set to what the app reports today. */
export function expectedToday(step: StepId): Observed {
  const out = structuredClone(EXPECTED[step]);
  for (const d of DIFFERENCES[step]) {
    const keys = d.path.split(".");
    const last = keys.pop()!;
    const parent = keys.reduce<Record<string, unknown>>((v, k) => v[k] as Record<string, unknown>, out as unknown as Record<string, unknown>);
    if (!(last in parent)) throw new Error(`difference path ${d.path} is not in the table`);
    parent[last] = d.today;
  }
  return out;
}

// ── (S5) THREE AMEX CARDS, ONE OF THEM A DEBT — the Amex summary's household ──
//
// A second household, seeded directly (no Plaid), Thu 2026-10-08 12:00 Central.
// The week is Sun 10/4 – Sat 10/10. Every name, amount and number is made up.
//
//   Chase Total Checking ••4321 — the forecast's account (snapshot $3,000.00).
//   Amex "Platinum Card" ••1001 — weekly, not a debt; Plaid balance $842.10;
//        the household named it "Everyday Plat".
//   Amex "Gold Card"     ••2002 — weekly, TRACKED AS A DEBT ("Amex Gold",
//        24.99%, minimum $35.00, statement $1,100.00); Plaid balance $1,234.56.
//   Amex "Blue Cash Everyday" ••3003 — monthly, not a debt, no balance known.
//   A Car Loan (6%, $5,000.00) so the Gold card has a place in the avalanche order.
//   Plans: weekly $1,000.00 (from 2026-05-01); no monthly plan.
//   Hooks: Weekly Spend $450 (Saturdays from 10/10), Monthly Spend $200 (the 28th).
//
// Week, Platinum (signed as stored: − a charge, + a credit):
//   purchases   WHOLE FOODS 60 (weekly, Groceries) · SHELL 40 (posted; its pending
//               twin replaced, hand-filed Gas, carried over) · BEST BUY 120 (UN) ·
//               TARGET 30 (reimbursable, Home) · AFFIRM 25 (nothing; Plaid
//               says LOAN_PAYMENTS — a pay-later instalment, UNRESOLVED) ·
//               COSTCO 80 (weekly, no category; alias "Costco") · TRADER JOE'S 70 (weekly, split
//               Groceries 50 / Home 20)  = 425.00 / 7, reimbursable 30.00 / 1
//   refunds     WHOLE FOODS +15                                   = 15.00 / 1
//   payments    ONLINE PAYMENT - THANK YOU +200                   = 200.00 / 1
//   other       credit: BALANCE ADJUSTMENT +10 (transfer) · charge: MEMBERSHIP FEE
//               −5 (Ignore) · not mine: AIRLINE TICKET −300
//   weekCharges 425 − 15 = 410.00 (the payoff's own figure)
//   household   weekly 60 + 80 + 70 = 210; unfiled 40 + 25 + 300 − 15 = 350
//               (the position does not read "not mine") → weeklyPlan 560.00,
//               unfiled 350.00; (hh-split) of it AFFIRM 25 is unconfirmed (the
//               F2 evidence rule) → weeklyKnown 535.00, weeklyUnresolved 25.00
//   attention   unplanned BEST BUY 120 · unfiled SHELL 40 (Gas), AFFIRM 25 ·
//               uncategorized COSTCO 80
// Week, Gold: DELTA AIR −250 (Travel, unfiled) · AMEX EPAYMENT +100 (payment).
// Month, Blue: AMAZON −45 (monthly, Home) on 10/2.
// The Saturday payoff (10/10): Platinum's 410.00 + what is left of the $1,000.00
//   week (1000 − 560 − 250 = 190) = 600.00. The Monthly Spend hook has no plan:
//   its stored $200.00.
// Spending facts for the week: Platinum 695 − 15 = 680 (reimbursable out, "not
//   mine" in) + Gold 250 = 930.00.
export const S5_NOW = at("2026-10-08T12:00:00");
export const S5_WEEK = { from: "2026-10-04", to: "2026-10-10" } as const;

export const S5_ACCOUNTS = {
  chase: { accountId: "s5-chase-chk-4321", mask: "4321", name: "Total Checking", institution: "Chase", slug: "chase", type: "depository", subtype: "checking", liability: null },
  plat: { accountId: "s5-amex-plat-1001", mask: "1001", name: "Platinum Card", institution: "American Express", slug: "amex", type: "credit", subtype: "credit card", liability: "842.10" },
  gold: { accountId: "s5-amex-gold-2002", mask: "2002", name: "Gold Card", institution: "American Express", slug: "amex", type: "credit", subtype: "credit card", liability: "1234.56" },
  blue: { accountId: "s5-amex-blue-3003", mask: "3003", name: "Blue Cash Everyday", institution: "American Express", slug: "amex", type: "credit", subtype: "credit card", liability: null },
} as const;
export type S5AccountKey = keyof typeof S5_ACCOUNTS;

export const S5_DEBTS = {
  gold: { name: "Amex Gold", balance: "1234.56", apr: "0.2499", minPayment: "35.00", statement: { date: "2026-09-28", balance: "1100.00" } },
  car: { name: "Car Loan", balance: "5000.00", apr: "0.0600", minPayment: "250.00" },
} as const;

export const S5_CATEGORIES = ["Groceries", "Gas", "Electronics", "Home", "Travel", "Ignore"] as const;

export type S5Row = {
  key: string;
  account: S5AccountKey;
  on: string;
  desc: string;
  amount: string;
  category?: (typeof S5_CATEGORIES)[number];
  weekly?: boolean;
  monthly?: boolean;
  unplanned?: boolean;
  reimbursable?: boolean;
  transfer?: boolean;
  pending?: boolean;
  /** Filed by a person (`isTransferUserOverridden`, `categoryLockedByUser`). */
  byHand?: boolean;
  pfc?: string;
  /** Category parts (`transaction_splits`): [category, amount]. */
  splits?: Array<[(typeof S5_CATEGORIES)[number], string]>;
};

export const S5_ROWS: readonly S5Row[] = [
  { key: "wholeFoods", account: "plat", on: "2026-10-05", desc: "WHOLE FOODS #123", amount: "-60.00", category: "Groceries", weekly: true },
  { key: "shellPending", account: "plat", on: "2026-10-05", desc: "SHELL OIL 123", amount: "-40.00", category: "Gas", pending: true, byHand: true },
  { key: "shellPosted", account: "plat", on: "2026-10-06", desc: "SHELL OIL 123", amount: "-40.00" },
  { key: "bestBuy", account: "plat", on: "2026-10-06", desc: "BEST BUY 88", amount: "-120.00", category: "Electronics", unplanned: true },
  { key: "fee", account: "plat", on: "2026-10-06", desc: "MEMBERSHIP FEE", amount: "-5.00", category: "Ignore" },
  { key: "notMine", account: "plat", on: "2026-10-06", desc: "AIRLINE TICKET", amount: "-300.00" },
  { key: "target", account: "plat", on: "2026-10-07", desc: "TARGET 55", amount: "-30.00", category: "Home", reimbursable: true },
  // (hh-split) Unfiled, and Plaid says a loan payment: the week's one unconfirmed card row.
  { key: "affirm", account: "plat", on: "2026-10-07", desc: "AFFIRM INC", amount: "-25.00", pfc: "LOAN_PAYMENTS_OTHER_PAYMENT" },
  { key: "costco", account: "plat", on: "2026-10-07", desc: "COSTCO WHSE", amount: "-80.00", weekly: true },
  { key: "traderJoes", account: "plat", on: "2026-10-07", desc: "TRADER JOE S #712", amount: "-70.00", category: "Groceries", weekly: true, splits: [["Groceries", "-50.00"], ["Home", "-20.00"]] },
  { key: "wfRefund", account: "plat", on: "2026-10-08", desc: "WHOLE FOODS #123", amount: "15.00" },
  { key: "platPayment", account: "plat", on: "2026-10-08", desc: "ONLINE PAYMENT - THANK YOU", amount: "200.00", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
  { key: "adjustment", account: "plat", on: "2026-10-08", desc: "BALANCE ADJUSTMENT", amount: "10.00", transfer: true },
  { key: "delta", account: "gold", on: "2026-10-05", desc: "DELTA AIR 006", amount: "-250.00", category: "Travel" },
  { key: "goldPayment", account: "gold", on: "2026-10-07", desc: "AMEX EPAYMENT ACH PMT", amount: "100.00" },
  { key: "amazon", account: "blue", on: "2026-10-02", desc: "AMAZON MKTPL", amount: "-45.00", category: "Home", monthly: true },
  { key: "chasePayment", account: "chase", on: "2026-10-08", desc: "AMERICAN EXPRESS ACH PMT", amount: "-200.00", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
];

/** Hand-worked figures (see the block above). "amount/count". */
export const S5_EXPECTED = {
  plat: {
    purchases: "425.00/7",
    reimbursable: "30.00/1",
    refunds: "15.00/1",
    payments: "200.00/1",
    otherCredits: "10.00/1",
    otherCharges: "5.00/1",
    notMine: "300.00/1",
    weekCharges: 410,
    owed: "842.10",
    household: { weeklyPlan: "560.00", weeklyKnown: "535.00", weeklyUnresolved: "25.00", monthlyPlan: "0.00", monthlyKnown: "0.00", monthlyUnresolved: "0.00", unfiled: "350.00" },
    plan: "weekly_hook 600.00 2026-10-10 plan",
    attention: {
      unplanned: ["Best Buy 88 120.00 Electronics unplanned"],
      unfiled: ["Shell Oil 123 40.00 Gas unfiled", "Affirm Inc 25.00 — unfiled uncategorized"],
      uncategorized: ["Costco 80.00 — weekly uncategorized"],
    },
  },
  gold: {
    purchases: "250.00/1",
    payments: "100.00/1",
    owed: "1234.56",
    statement: "1100.00",
    plan: { kind: "debt", name: "Amex Gold", minimum: "35.00", avalancheRank: 1, status: "active" },
  },
  blueMonth: { purchases: "45.00/1", monthlyPlan: "45.00", plan: "monthly_hook 200.00 2026-10-28 stored_amount" },
  all: {
    purchases: "675.00/8",
    refunds: "15.00/1",
    payments: "300.00/2",
    owed: "2076.66",
    household: { weeklyPlan: "810.00", weeklyKnown: "785.00", weeklyUnresolved: "25.00", monthlyPlan: "0.00", monthlyKnown: "0.00", monthlyUnresolved: "0.00", unfiled: "600.00" },
    unfiled: "315.00/3",
  },
  spendingFactsWeek: 930,
  combinedWeekCharges: 410,
} as const;

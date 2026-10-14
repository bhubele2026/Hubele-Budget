// ⭐ (S4) THE BANKING REVIEW SCENARIO — "what wasn't in the plan?", one row per rule.
//
// Synthetic only: every name, amount and account number is made up.
// Today is Wed 2026-10-14 12:00 America/Chicago. The forecast reads Chase
// checking ••4321 (snapshot $3,000.00 at Thu 10/1 08:00); a savings account
// ••8802 has rows the forecast never reads; an Amex card ••1009 is a card (the
// review refuses it). The comparison window: rows from today − 59 = 2026-08-16.
//
// Every row the register counts lands in exactly ONE place (October 1–14):
//
//   rule  row                                   amount     → where (why)
//   1     VERIZON WIRELESS PAYMENT 10/3           −80.00   matched "Verizon Wireless" −80 due 10/3 → asPlanned
//   1     ELECTRIC CO 4471 10/5                  −135.40   matched "Electric Company" −120 due 10/5 → amountDifference (+15.40)
//   1     STATE AUTO INS 10/6                    −150.00   partial "Car Insurance" −200 due 10/6 → amountDifference (partial, −50.00)
//   1     PLANET FITNESS 10/8                     −40.00   matched "Gym Membership" −40 due 10/1 → timingDifference (+7 days)
//   2     CASH APP*FRIEND 10/2                    −60.00   marked not in the plan → confirmedUnplanned
//   2     VENMO PAYMENT 10/5                      −25.00   the older "unplanned" answer → confirmedUnplanned
//   2     SHELL OIL 57444 10/12 (posted)          −47.50   its pending row (−45.00, 10/11, replaced and not
//                                                          counted) was marked not in the plan; the answer
//                                                          carries → confirmedUnplanned
//   3     SPECTRUM INTERNET 10/12                 −70.00   needs_review on "Internet" → uncertain (needs_review)
//   4     CAPITAL ONE MOBILE PYMT 10/4           −300.00   pays the overdue $40 Capital One minimum (a card
//                                                          payment naming the card) → amountDifference (+260.00)
//   4     NETFLIX.COM 10/9 (uncategorized)        −15.49   tier 2 (full name) on "Netflix" −15.49 → asPlanned —
//                                                          an uncategorized row that paid a plan is not unplanned
//   4     ACME CORP PAYROLL 10/9                +2000.00   tier 2 (its category) on "Paycheck" +2000 → asPlanned
//   4     CITY WATER DEPT 10/10 (Utilities)       −58.00   tier 2 (its category) on "Water Utility" −50 → amountDifference (+8.00)
//   5     ZELLE TO JOHN SMITH 10/7                −75.00   a nameless exact pair (tier 3) with "Lawn Service" → uncertain (suggested_match)
//   7     KROGER #442 10/5                        −42.10   "Not this" against the Gym only → unmatched · spending
//   7     TARGET T-2331 10/6 (UN flag)            −64.20   no answer → unmatched · spending, flag shown
//   7     AMERICAN EXPRESS ACH PMT M2481 10/11   −250.00   checking → Amex, no plan → unmatched · card_payment (never spending)
//   7     ONLINE TRANSFER TO SAV ...8802 10/6    −500.00   unmatched · transfer
//   7     TOYOTA FINANCIAL 10/8 (tagged)         −300.00   unmatched · debt_payment
//   7     AMAZON REFUND 10/9                      +25.00   unmatched · refund
//   7     IRS TREAS 310 TAX REF 10/13 (Other income) +300.00 unmatched · income
//   7     MOBILE DEPOSIT 10/13                   +100.00   unmatched · other
//   7     STARBUCKS 1234 10/13 (pending)           −6.50   unmatched · spending, pending
//
//   rule 6 (August range): OLD BOOKSTORE 8/10 −20.00 is before 8/16 → uncertain (not_compared);
//   HARDWARE STORE 8/20 −33.00 is compared → unmatched · spending.
//
// October 1–14 by hand:
//   asPlanned           3 rows   net  +1,904.51  (−80 −15.49 +2000)
//   amountDifference    4 rows   net    −643.40  differenceTotal +233.40 (260 + 15.40 − 50 + 8)
//   timingDifference    1 row    net     −40.00
//   confirmedUnplanned  3 rows   net    −132.50
//   uncertain           2 rows   net    −145.00
//   unmatched           9 rows   net    −737.80  in 425.00 · out 1,162.80 · pending −6.50
//   ─────────────────────────────────────────────
//   22 rows placed, + 1 replaced pending row = 23 rows; net +205.81
//   = the ledger: in 2,425.00 · out 2,219.19 · net 205.81 · pending −6.50

export const TODAY = "2026-10-14";
export const NOW = new Date("2026-10-14T12:00:00-05:00");
export const SNAPSHOT = { balance: "3000.00", at: new Date("2026-10-01T08:00:00-05:00") };

export const ACCOUNTS = {
  chase: { name: "Total Checking", mask: "4321", institution: "Chase", type: "depository", subtype: "checking" },
  savings: { name: "Savings", mask: "8802", institution: "Chase", type: "depository", subtype: "savings" },
  amex: { name: "Blue Card", mask: "1009", institution: "American Express", type: "credit", subtype: "credit card" },
} as const;
export type AccountKey = keyof typeof ACCOUNTS;

export const CATEGORIES = {
  utilities: { name: "Utilities", kind: "expense" },
  groceries: { name: "Groceries", kind: "expense" },
  paycheck: { name: "Paycheck", kind: "income" },
  otherIncome: { name: "Other income", kind: "income" },
} as const;
export type CategoryKey = keyof typeof CATEGORIES;

export type PlanSpec = { name: string; kind: "bill" | "income"; amount: string; day: number; category?: CategoryKey };
export const PLANS = {
  verizon: { name: "Verizon Wireless", kind: "bill", amount: "80", day: 3 },
  electric: { name: "Electric Company", kind: "bill", amount: "120", day: 5 },
  insurance: { name: "Car Insurance", kind: "bill", amount: "200", day: 6 },
  gym: { name: "Gym Membership", kind: "bill", amount: "40", day: 1 },
  netflix: { name: "Netflix", kind: "bill", amount: "15.49", day: 9 },
  water: { name: "Water Utility", kind: "bill", amount: "50", day: 10, category: "utilities" },
  lawn: { name: "Lawn Service", kind: "bill", amount: "75", day: 7 },
  internet: { name: "Internet", kind: "bill", amount: "70", day: 12 },
  paycheck: { name: "Paycheck", kind: "income", amount: "2000", day: 9, category: "paycheck" },
} satisfies Record<string, PlanSpec>;
export type PlanKey = keyof typeof PLANS;

/** A card with a $40 minimum due on the 2nd, and a loan with no minimum (a tagged payment only). */
export const DEBTS = {
  capitalOne: { name: "Capital One Platinum", balance: "1000.00", minPayment: "40", dueDay: 2, type: "credit_card" },
  toyota: { name: "Toyota Loan", balance: "8000.00", minPayment: "0", dueDay: 1, type: "auto_loan" },
} as const;
export type DebtKey = keyof typeof DEBTS;

export type RowSpec = {
  on: string;
  desc: string;
  amount: string;
  account: AccountKey;
  category?: CategoryKey;
  pending?: boolean;
  unplanned?: boolean;
  transfer?: boolean;
  debt?: DebtKey;
  pfc?: string;
};

const CARD_PFC = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

export const ROWS = {
  old: { on: "2026-08-10", desc: "OLD BOOKSTORE", amount: "-20.00", account: "chase" },
  hardware: { on: "2026-08-20", desc: "HARDWARE STORE", amount: "-33.00", account: "chase" },
  cashapp: { on: "2026-10-02", desc: "CASH APP*FRIEND", amount: "-60.00", account: "chase" },
  verizon: { on: "2026-10-03", desc: "VERIZON WIRELESS PAYMENT", amount: "-80.00", account: "chase" },
  capone: { on: "2026-10-04", desc: "CAPITAL ONE MOBILE PYMT", amount: "-300.00", account: "chase", pfc: CARD_PFC },
  electric: { on: "2026-10-05", desc: "ELECTRIC CO 4471", amount: "-135.40", account: "chase" },
  venmo: { on: "2026-10-05", desc: "VENMO PAYMENT", amount: "-25.00", account: "chase" },
  kroger: { on: "2026-10-05", desc: "KROGER #442", amount: "-42.10", account: "chase", category: "groceries" },
  insurance: { on: "2026-10-06", desc: "STATE AUTO INS", amount: "-150.00", account: "chase" },
  target: { on: "2026-10-06", desc: "TARGET T-2331", amount: "-64.20", account: "chase", unplanned: true },
  toSavings: { on: "2026-10-06", desc: "ONLINE TRANSFER TO SAV ...8802", amount: "-500.00", account: "chase", transfer: true },
  zelle: { on: "2026-10-07", desc: "ZELLE TO JOHN SMITH", amount: "-75.00", account: "chase" },
  gym: { on: "2026-10-08", desc: "PLANET FITNESS", amount: "-40.00", account: "chase" },
  toyota: { on: "2026-10-08", desc: "TOYOTA FINANCIAL", amount: "-300.00", account: "chase", debt: "toyota" },
  netflix: { on: "2026-10-09", desc: "NETFLIX.COM", amount: "-15.49", account: "chase" },
  payroll: { on: "2026-10-09", desc: "ACME CORP PAYROLL", amount: "2000.00", account: "chase", category: "paycheck" },
  refund: { on: "2026-10-09", desc: "AMAZON REFUND", amount: "25.00", account: "chase" },
  water: { on: "2026-10-10", desc: "CITY WATER DEPT", amount: "-58.00", account: "chase", category: "utilities" },
  amexPayment: { on: "2026-10-11", desc: "AMERICAN EXPRESS ACH PMT M2481", amount: "-250.00", account: "chase", pfc: CARD_PFC },
  shellPending: { on: "2026-10-11", desc: "SHELL OIL 57444", amount: "-45.00", account: "chase", pending: true },
  shell: { on: "2026-10-12", desc: "SHELL OIL 57444", amount: "-47.50", account: "chase" },
  spectrum: { on: "2026-10-12", desc: "SPECTRUM INTERNET", amount: "-70.00", account: "chase" },
  irs: { on: "2026-10-13", desc: "IRS TREAS 310 TAX REF", amount: "300.00", account: "chase", category: "otherIncome" },
  deposit: { on: "2026-10-13", desc: "MOBILE DEPOSIT", amount: "100.00", account: "chase" },
  starbucks: { on: "2026-10-13", desc: "STARBUCKS 1234", amount: "-6.50", account: "chase", pending: true },
  // The savings account: the forecast never reads it.
  interest: { on: "2026-10-01", desc: "INTEREST PAYMENT", amount: "1.20", account: "savings" },
  fromChecking: { on: "2026-10-06", desc: "ONLINE TRANSFER FROM CHK ...4321", amount: "500.00", account: "savings" },
  // The card (never on a bank review).
  cardCharge: { on: "2026-10-05", desc: "DELTA AIR LINES", amount: "-220.00", account: "amex" },
} satisfies Record<string, RowSpec>;
export type RowKey = keyof typeof ROWS;

/** The household's answers. */
export type AnswerSpec = { row: RowKey; status: string; plan?: PlanKey };
export const ANSWERS: AnswerSpec[] = [
  { row: "verizon", status: "matched", plan: "verizon" },
  { row: "electric", status: "matched", plan: "electric" },
  { row: "insurance", status: "partial", plan: "insurance" },
  { row: "gym", status: "matched", plan: "gym" },
  { row: "cashapp", status: "ignored_unforecasted" },
  { row: "venmo", status: "unplanned" },
  { row: "shellPending", status: "ignored_unforecasted" },
  { row: "spectrum", status: "needs_review", plan: "internet" },
  { row: "kroger", status: "not_match", plan: "gym" },
];

/** The counted October rows that paid their plan cleanly (totals only on the API). */
export const AS_PLANNED_OCTOBER: RowKey[] = ["verizon", "netflix", "payroll"];

/** Where every other counted October row lands: "<bucket> <reason> <kind>". */
export const EXPECTED_OCTOBER: Partial<Record<RowKey, string>> = {
  electric: "amountDifference amount spending",
  insurance: "amountDifference partial spending",
  capone: "amountDifference amount card_payment",
  water: "amountDifference amount spending",
  gym: "timingDifference timing spending",
  cashapp: "confirmedUnplanned ignored_unforecasted spending",
  venmo: "confirmedUnplanned marked_unplanned spending",
  shell: "confirmedUnplanned ignored_unforecasted spending",
  spectrum: "uncertain needs_review spending",
  zelle: "uncertain suggested_match spending",
  kroger: "unmatched no_plan spending",
  target: "unmatched no_plan spending",
  starbucks: "unmatched no_plan spending",
  amexPayment: "unmatched no_plan card_payment",
  toSavings: "unmatched no_plan transfer",
  toyota: "unmatched no_plan debt_payment",
  refund: "unmatched no_plan refund",
  irs: "unmatched no_plan income",
  deposit: "unmatched no_plan other",
};

/** October 1–14 by hand (see the header). */
export const OCTOBER_TOTALS = {
  cashFlow: { moneyIn: "2425.00", moneyOut: "2219.19", net: "205.81", count: 23, pendingNet: "-6.50", supersededExcluded: 1, otherExcluded: 0 },
  asPlanned: { count: 3, net: "1904.51", pendingNet: "0.00", withoutPlanDetail: 0 },
  amountDifference: { count: 4, moneyIn: "0.00", moneyOut: "643.40", net: "-643.40", pendingNet: "0.00", differenceTotal: "233.40" },
  timingDifference: { count: 1, moneyIn: "0.00", moneyOut: "40.00", net: "-40.00", pendingNet: "0.00" },
  confirmedUnplanned: { count: 3, moneyIn: "0.00", moneyOut: "132.50", net: "-132.50", pendingNet: "0.00" },
  uncertain: { count: 2, moneyIn: "0.00", moneyOut: "145.00", net: "-145.00", pendingNet: "0.00" },
  unmatched: { count: 9, moneyIn: "425.00", moneyOut: "1162.80", net: "-737.80", pendingNet: "-6.50" },
} as const;

/** The plan occurrences due October 1–14: "<due> <label> <fate> <planned> ← <row amount on date>". */
export const PLANNED_OCTOBER = [
  "2026-10-01 Gym Membership matched -40.00 ← -40.00 on 2026-10-08 (+7d, diff 0.00)",
  "2026-10-02 Capital One Platinum minimum paid_on_evidence -40.00 ← -300.00 on 2026-10-04 (+2d, diff 260.00)",
  "2026-10-03 Verizon Wireless matched -80.00 ← -80.00 on 2026-10-03 (+0d, diff 0.00)",
  "2026-10-05 Electric Company matched -120.00 ← -135.40 on 2026-10-05 (+0d, diff 15.40)",
  "2026-10-06 Car Insurance partial -200.00 ← -150.00 on 2026-10-06 (+0d, diff -50.00)",
  "2026-10-07 Lawn Service suggested -75.00 ← -75.00 on 2026-10-07 (+0d, diff 0.00)",
  "2026-10-09 Netflix paid_on_evidence -15.49 ← -15.49 on 2026-10-09 (+0d, diff 0.00)",
  "2026-10-09 Paycheck paid_on_evidence 2000.00 ← 2000.00 on 2026-10-09 (+0d, diff 0.00)",
  "2026-10-10 Water Utility paid_on_evidence -50.00 ← -58.00 on 2026-10-10 (+0d, diff 8.00)",
  "2026-10-12 Internet on_curve -70.00",
];

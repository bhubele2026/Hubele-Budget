// (F2) Pure unit tests: the evidence rule (`classifyEvidence`, avalanche-core)
// and the period breakdown's known / unresolved split. No DB. Every name and
// amount is made up.
//
//   1. Each class and edge, worked by hand: a purchase by Plaid's category, by
//      no contrary evidence, by a household flag; an ATM withdrawal and a
//      payment to a person stay purchases; every confirmed payment the spending
//      rule already knows; unresolved by LOAN_PAYMENTS, TRANSFER_OUT /
//      TRANSFER_IN, INCOME, a bill the forecast only suggests, money out filed
//      as income, money in filed as an expense; refunds and real income are
//      outside the rule.
//   2. pending→posted: a posted row with no Plaid category reads its pending
//      row's (`carriedPfcEvidence`); a posted row with its own keeps its own.
//   3. Exactly one class for every outflow (6,000 seeded rows), and the class
//      agrees with the spending rule's own coverage.
//   4. The breakdown: known + unresolved === actual === computePosition's spent,
//      to the cent, on seeded weeks; remaining reads known; refunds net per
//      account (a card's excess refund never lowers checking's known); split
//      parents; provisional at max($25, 5%); the month's known === actual.

import { describe, expect, it } from "vitest";
import {
  allowanceRowOf,
  classifyEvidence,
  classifyMovement,
  computePosition,
  isProvisional,
  namesPersonToPersonRail,
  periodBreakdown,
  pfcOf,
  type BillSuggestionRef,
  type BreakdownRowInput,
  type EvidenceContext,
  type EvidenceRow,
  type MovementContext,
  type PositionInputs,
} from "@workspace/avalanche-core";
import { carriedPfcEvidence } from "./pendingFiling";

const CHECKING = "chase-ext";
const AMEX = "amex-ext";

const CATS = new Map([
  ["cat-food", { name: "Groceries", debtId: null, kind: "expense" }],
  ["cat-dining", { name: "Dining", debtId: null, kind: "expense" }],
  ["cat-subs", { name: "Subscriptions", debtId: null, kind: "expense" }],
  ["cat-health", { name: "Health", debtId: null, kind: "expense" }],
  ["cat-debt", { name: "Card Payoff", debtId: "debt-1", kind: "expense" }],
  ["cat-ignore", { name: "Ignore", debtId: null, kind: "expense" }],
  ["cat-transfer", { name: "Transfer", debtId: null, kind: "expense" }],
  ["cat-pay", { name: "Paycheck", debtId: null, kind: "income" }],
  ["cat-other-income", { name: "Other income", debtId: null, kind: "income" }],
  ["cat-uncat", { name: "Uncategorized", debtId: null, kind: "expense" }],
]);

function mctx(overrides: Partial<MovementContext> = {}): MovementContext {
  return {
    categoriesById: CATS,
    debtCategoryIds: new Set(["cat-debt"]),
    checkingAccountExternalId: CHECKING,
    matchedTxnIds: new Set(),
    cardAccountIds: new Set([AMEX]),
    ...overrides,
  };
}

const SHIELD: BillSuggestionRef = { planKey: "bill-shield|2026-10-20", itemId: "bill-shield", label: "Shieldline Life", occurrenceDate: "2026-10-20" };

function ectx(m: MovementContext, suggestions: ReadonlyMap<string, BillSuggestionRef> = new Map()): EvidenceContext {
  return {
    categoriesById: m.categoriesById,
    debtCategoryIds: m.debtCategoryIds,
    uncategorizedIds: new Set(["cat-uncat"]),
    cardAccountIds: m.cardAccountIds,
    billSuggestions: suggestions,
  };
}

function row(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "t1",
    occurredOn: "2026-10-13",
    amount: "-25.00",
    source: "plaid:chase",
    isTransfer: false,
    categoryId: null,
    description: "BEAN COUNTER COFFEE",
    debtId: null,
    isExternalCardPayment: false,
    reimbursable: false,
    pfcPrimary: null,
    pfcDetailed: null,
    plaidAccountId: CHECKING,
    unplannedAllowance: false,
    monthlyAllowance: false,
    weeklyAllowance: false,
    ...overrides,
  };
}

/** The rule on a row, with the row's own classifyMovement answer. */
function evidenceOf(r: EvidenceRow, m: MovementContext = mctx(), suggestions?: ReadonlyMap<string, BillSuggestionRef>) {
  return classifyEvidence(r, classifyMovement(r, m, { explain: true }), ectx(m, suggestions));
}
const said = (r: EvidenceRow, m?: MovementContext, s?: ReadonlyMap<string, BillSuggestionRef>) => {
  const e = evidenceOf(r, m, s);
  return e ? `${e.class} ${e.reason}` : "none";
};

describe("classifyEvidence — known purchases", () => {
  it("purchase evidence, no contrary evidence, a household flag", () => {
    expect(said(row({ pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_COFFEE" }))).toBe("known_purchase purchase_category");
    expect(said(row({ pfcPrimary: null, pfcDetailed: null, description: "PAYPAL *GADGETS" }))).toBe("known_purchase no_contrary_evidence");
    expect(said(row({ source: "manual", plaidAccountId: null }))).toBe("known_purchase no_contrary_evidence");
    // A flag is the household's own confirmation — even over Plaid's word.
    expect(said(row({ weeklyAllowance: true, pfcPrimary: "LOAN_PAYMENTS" }))).toBe("known_purchase household_flag");
    expect(said(row({ monthlyAllowance: true }))).toBe("known_purchase household_flag");
    expect(said(row({ unplannedAllowance: true }))).toBe("known_purchase household_flag");
    expect(said(row({ reimbursable: true }))).toBe("known_purchase household_flag");
    expect(evidenceOf(row({ pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_COFFEE" }))!.evidence).toEqual([
      { field: "pfc_primary", value: "FOOD_AND_DRINK" },
      { field: "pfc_detailed", value: "FOOD_AND_DRINK_COFFEE" },
    ]);
  });

  it("an ATM withdrawal and a payment to a person over Zelle / Venmo / Cash App stay purchases", () => {
    expect(said(row({ description: "ATM WITHDRAWAL 1234", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_WITHDRAWAL" }))).toBe(
      "known_purchase atm_withdrawal",
    );
    for (const d of ["ZELLE PAYMENT TO JANE ROE", "VENMO *J ROE", "CASH APP*J ROE", "Square Cash J Roe"]) {
      expect(said(row({ description: d, pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" })), d).toBe(
        "known_purchase person_to_person",
      );
    }
    // A rail word inside another word is not a rail; savings is never a person.
    expect(namesPersonToPersonRail("ZELLENBERG HARDWARE")).toBe(false);
    expect(said(row({ description: "ZELLE TO SAVINGS", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_SAVINGS" }))).toBe(
      "unresolved transfer_evidence",
    );
  });
});

describe("classifyEvidence — confirmed payments (the spending rule's own facts)", () => {
  it("transfer, bank noise, debt tag, debt category, card payment, excluded category, confirmed and tier-2 bill matches", () => {
    expect(said(row({ isTransfer: true }))).toBe("confirmed_payment transfer");
    expect(said(row({ description: "ONLINE TRANSFER TO SAV ...8801" }))).toBe("confirmed_payment bank_noise");
    expect(said(row({ debtId: "debt-9" }))).toBe("confirmed_payment debt_payment");
    expect(said(row({ categoryId: "cat-debt" }))).toBe("confirmed_payment debt_payment");
    expect(said(row({ pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", description: "AMEX EPAYMENT" }))).toBe(
      "confirmed_payment card_payment",
    );
    expect(said(row({ isExternalCardPayment: true }))).toBe("confirmed_payment card_payment");
    expect(said(row({ categoryId: "cat-ignore" }))).toBe("confirmed_payment excluded_category");
    expect(said(row({ categoryId: "cat-transfer", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_SAVINGS" }))).toBe(
      "confirmed_payment excluded_category",
    );
    expect(said(row(), mctx({ matchedTxnIds: new Set(["t1"]) }))).toBe("confirmed_payment bill_match");
    expect(said(row(), mctx({ tier2PairedTxnIds: new Set(["t1"]) }))).toBe("confirmed_payment bill_match");
  });
});

describe("classifyEvidence — unresolved: contrary evidence, no household confirmation", () => {
  it("a loan payment (not a card's) — the HELOC-like pending debit", () => {
    const e = evidenceOf(row({ amount: "-1150.40", description: "LRK LOANS", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" }))!;
    expect(e).toEqual({
      class: "unresolved",
      reason: "loan_payment",
      evidence: [
        { field: "pfc_primary", value: "LOAN_PAYMENTS" },
        { field: "pfc_detailed", value: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
      ],
      suggestion: { kind: "loan_payment", detail: null, target: null },
    });
  });

  it("a transfer to savings filed under Subscriptions (a category alone is not confirmation)", () => {
    const e = evidenceOf(row({ amount: "-20.00", description: "PEAR GS SAVINGS", categoryId: "cat-subs", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_SAVINGS" }))!;
    expect(e).toMatchObject({ class: "unresolved", reason: "transfer_evidence", suggestion: { kind: "transfer", detail: "savings", target: null } });
    expect(said(row({ pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS" }))).toBe("unresolved transfer_evidence");
    expect(evidenceOf(row({ pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" }))!.suggestion).toMatchObject({ kind: "transfer", detail: "in" });
    // An account transfer that names no person-to-person rail is a transfer.
    expect(said(row({ description: "XFER TO 4471", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" }))).toBe("unresolved transfer_evidence");
  });

  it("Plaid's primary is read from the detailed category when the primary is missing", () => {
    expect(pfcOf(row({ pfcPrimary: null, pfcDetailed: "TRANSFER_OUT_SAVINGS" }))).toEqual({ primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_SAVINGS" });
    expect(pfcOf(row({ pfcPrimary: null, pfcDetailed: "GENERAL_SERVICES_INSURANCE" }))).toEqual({ primary: "GENERAL_SERVICES", detailed: "GENERAL_SERVICES_INSURANCE" });
    expect(pfcOf(row({ pfcPrimary: "loan_payments", pfcDetailed: null }))).toEqual({ primary: "LOAN_PAYMENTS", detailed: null });
    expect(said(row({ pfcPrimary: null, pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" }))).toBe("unresolved loan_payment");
  });

  it("an outflow Plaid calls income", () => {
    expect(said(row({ pfcPrimary: "INCOME", pfcDetailed: "INCOME_WAGES" }))).toBe("unresolved income_evidence");
  });

  it("a bill the forecast only suggests — over a purchase-type Plaid category (the insurance debit)", () => {
    const r = row({ id: "ins", amount: "-95.00", description: "SHIELDLINE INS", categoryId: "cat-health", pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_INSURANCE" });
    expect(said(r)).toBe("known_purchase purchase_category");
    const e = evidenceOf(r, mctx(), new Map([["ins", SHIELD]]))!;
    expect(e).toEqual({
      class: "unresolved",
      reason: "bill_suggestion",
      evidence: [
        { field: "bill_suggestion", value: "Shieldline Life" },
        { field: "pfc_primary", value: "GENERAL_SERVICES" },
        { field: "pfc_detailed", value: "GENERAL_SERVICES_INSURANCE" },
      ],
      suggestion: { kind: "bill", detail: null, target: { kind: "bill", itemId: "bill-shield", label: "Shieldline Life", planKey: SHIELD.planKey, occurrenceDate: "2026-10-20" } },
    });
    // A suggestion never overrules a household fact: a flagged or matched row is not unresolved.
    expect(said({ ...r, weeklyAllowance: true }, mctx(), new Map([["ins", SHIELD]]))).toBe("known_purchase household_flag");
    expect(said(r, mctx({ matchedTxnIds: new Set(["ins"]) }), new Map([["ins", SHIELD]]))).toBe("confirmed_payment bill_match");
  });

  it("money out filed under an income category (a loan payment filed as Other income)", () => {
    const e = evidenceOf(row({ amount: "-1150.40", description: "LARKSPUR LENDING", categoryId: "cat-other-income", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" }))!;
    expect(e).toMatchObject({
      class: "unresolved",
      reason: "debit_in_income_category",
      evidence: [{ field: "category", value: "Other income" }, { field: "pfc_primary", value: "LOAN_PAYMENTS" }, { field: "pfc_detailed", value: "LOAN_PAYMENTS_OTHER_PAYMENT" }],
      suggestion: { kind: "loan_payment" },
    });
  });

  it("money in filed under an expense category (the payroll credit in Dining) — and never a refund, a card credit or real income", () => {
    const payroll = row({ amount: "2391.40", description: "ORIG CO NAME:MAPLEWORKS INC CO ENTRY DESCR:PAYROLL", categoryId: "cat-dining", pfcPrimary: "INCOME", pfcDetailed: "INCOME_SALARY" });
    expect(evidenceOf(payroll)).toMatchObject({ class: "unresolved", reason: "credit_in_expense_category", suggestion: { kind: "income" } });
    // Filed under the paycheck category it is real income: outside the rule.
    expect(said({ ...payroll, categoryId: "cat-pay" })).toBe("none");
    // A credit on a card is money back on the card (a refund or a payment), never a conflict.
    expect(said(row({ amount: "10.00", source: "plaid:amex", plaidAccountId: AMEX, categoryId: "cat-food", description: "GROCERY MART" }))).toBe("none");
    // A REFUND word on checking is a refund.
    expect(said(row({ amount: "12.00", categoryId: "cat-food", description: "GROCERY MART REFUND" }))).toBe("none");
    // A transfer in, an unfiled deposit, a $0 row.
    expect(said(row({ amount: "500.00", isTransfer: true, categoryId: "cat-dining" }))).toBe("none");
    expect(said(row({ amount: "100.00", description: "MOBILE DEPOSIT" }))).toBe("none");
    expect(said(row({ amount: "0.00" }))).toBe("none");
  });
});

describe("pending→posted: the evidence carries, the filing rules stay as they were", () => {
  it("a posted row with no Plaid category reads the pending row's; one with its own keeps its own", () => {
    const pending = { pfc: { pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" } };
    expect(carriedPfcEvidence({ pfcPrimary: null, pfcDetailed: null }, pending)).toEqual(pending.pfc);
    expect(carriedPfcEvidence({ pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: null }, pending)).toBeNull();
    expect(carriedPfcEvidence({ pfcPrimary: null, pfcDetailed: null }, { pfc: { pfcPrimary: null, pfcDetailed: " " } })).toBeNull();
    expect(carriedPfcEvidence({ pfcPrimary: null, pfcDetailed: null }, null)).toBeNull();
    const posted = row({ description: "VALLEY LOAN SVC", amount: "-50.00", carriedPfc: carriedPfcEvidence({ pfcPrimary: null, pfcDetailed: null }, pending) });
    expect(said(posted)).toBe("unresolved loan_payment");
    // The spending rule never reads the carried category: the row is still unfiled spending to it.
    expect(classifyMovement(posted, mctx(), { explain: true })).toMatchObject({ coverage: "needs_classification", rule: "unfiled" });
    expect(said({ ...posted, pfcPrimary: "FOOD_AND_DRINK" })).toBe("known_purchase purchase_category");
  });
});

describe("exactly one class for every outflow (6,000 seeded rows)", () => {
  it("the class agrees with the spending rule's coverage; a credit is unresolved only against its direction", () => {
    let seed = 20261014;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const PAYMENT = new Set(["transfer", "debt_payment", "card_payment", "excluded", "bill_matched"]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i += 1) {
      const onCard = rnd() < 0.3;
      const out = rnd() < 0.8;
      const mag = Math.round(1 + rnd() * 50000) / 100;
      const r = row({
        id: `r${i}`,
        source: onCard ? "plaid:amex" : "plaid:chase",
        plaidAccountId: onCard ? AMEX : CHECKING,
        amount: out ? -mag : mag,
        categoryId: pick([null, "cat-food", "cat-subs", "cat-debt", "cat-ignore", "cat-pay", "cat-uncat"]),
        description: pick(["STORE", "ZELLE TO J ROE", "ONLINE TRANSFER TO SAV", "STORE REFUND", "AMEX EPAYMENT"]),
        pfcPrimary: pick([null, "FOOD_AND_DRINK", "LOAN_PAYMENTS", "TRANSFER_OUT", "TRANSFER_IN", "INCOME", "GENERAL_SERVICES"]),
        pfcDetailed: pick([null, "TRANSFER_OUT_WITHDRAWAL", "TRANSFER_OUT_SAVINGS", "TRANSFER_OUT_ACCOUNT_TRANSFER", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"]),
        isTransfer: rnd() < 0.05,
        debtId: rnd() < 0.05 ? "debt-9" : null,
        reimbursable: rnd() < 0.05,
        weeklyAllowance: rnd() < 0.3,
        monthlyAllowance: rnd() < 0.1,
        unplannedAllowance: rnd() < 0.05,
      });
      const m = mctx({ matchedTxnIds: rnd() < 0.05 ? new Set([r.id]) : new Set(), tier2PairedTxnIds: rnd() < 0.05 ? new Set([r.id]) : undefined });
      const suggestions = rnd() < 0.1 ? new Map([[r.id, SHIELD]]) : undefined;
      const mv = classifyMovement(r, m, { explain: true });
      const e = classifyEvidence(r, mv, ectx(m, suggestions));
      if (out) {
        expect(e, `row ${i}`).not.toBeNull();
        if (PAYMENT.has(mv.coverage)) expect(e!.class, `row ${i}`).toBe("confirmed_payment");
        else if (mv.coverage === "needs_classification") expect(e!.class, `row ${i}`).not.toBe("confirmed_payment");
        else if (mv.coverage === "income") expect(e!.reason, `row ${i}`).toBe("debit_in_income_category");
        else expect(e!.reason, `row ${i}`).toBe("household_flag");
        if (e!.class === "unresolved") expect(e!.suggestion === null || typeof e!.suggestion.kind === "string").toBe(true);
      } else if (e) {
        expect(e.reason, `row ${i}`).toBe("credit_in_expense_category");
      }
      const k = e ? `${e.class}:${e.reason}` : "none";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // Every reason the seed can reach was reached.
    for (const k of [
      "known_purchase:household_flag",
      "known_purchase:purchase_category",
      "known_purchase:no_contrary_evidence",
      "known_purchase:person_to_person",
      "known_purchase:atm_withdrawal",
      "confirmed_payment:transfer",
      "confirmed_payment:card_payment",
      "confirmed_payment:bill_match",
      "unresolved:loan_payment",
      "unresolved:transfer_evidence",
      "unresolved:income_evidence",
      "unresolved:bill_suggestion",
      "unresolved:debit_in_income_category",
      "unresolved:credit_in_expense_category",
    ]) {
      expect(counts.get(k) ?? 0, k).toBeGreaterThan(0);
    }
  });
});

// ── The breakdown: known vs unresolved ────────────────────────────────────

const NAMES = new Map([...CATS].map(([id, c]) => [id, c.name] as const));
const empty = { starts: [] as string[], rows: [] };

function input(
  r: EvidenceRow,
  m: MovementContext = mctx(),
  opts: { suggestions?: ReadonlyMap<string, BillSuggestionRef>; splitParts?: BreakdownRowInput<string>["splitParts"] } = {},
): BreakdownRowInput<string> {
  const mv = classifyMovement(r, m, { explain: true });
  const e = classifyEvidence(r, mv, ectx(m, opts.suggestions));
  return {
    id: r.id,
    date: r.occurredOn,
    allowance: allowanceRowOf(r, mv),
    categoryId: r.categoryId,
    splitParts: opts.splitParts ?? null,
    evidenceClass: e?.class ?? null,
    item: r.id,
  };
}

/** The money position's inputs for the same rows (only the week's fields matter). */
function positionInputs(rows: readonly BreakdownRowInput<string>[], capCents: number | null): PositionInputs {
  return {
    todayISO: "2026-10-14",
    daily: [],
    events: [],
    incomeItems: [],
    cashBuffer: "0",
    reservesHeld: 0,
    weekCap: capCents == null ? null : capCents / 100,
    weekRows: rows.map((r) => r.allowance),
    freshness: { stale: false, staleReason: null, asOfBank: null },
    status: "no_data",
    weekAdjustmentCents: null,
    weekAdjustmentReason: null,
    nextWeekAdjustmentCents: null,
  };
}

const card = { source: "plaid:amex", plaidAccountId: AMEX } as const;

/** The live week, synthetic: "Not filed yet" holds three non-purchases and two purchases. */
function liveWeek(): BreakdownRowInput<string>[] {
  const suggestions = new Map([["ins", SHIELD]]);
  return [
    input(row({ id: "loan", amount: "-1150.40", description: "LRK LOANS", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" })),
    input(row({ id: "ins", amount: "-95.00", description: "SHIELDLINE INS", categoryId: "cat-health", pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_INSURANCE" }), mctx(), { suggestions }),
    input(row({ id: "coffee", amount: "-25.00", pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_COFFEE" })),
    input(row({ id: "save", amount: "-20.00", description: "PEAR GS SAVINGS", categoryId: "cat-subs", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_SAVINGS" })),
    input(row({ id: "paypal", amount: "-14.76", description: "PAYPAL *GADGETS" })),
    input(row({ id: "groc", amount: "-150.00", categoryId: "cat-food", weeklyAllowance: true, description: "GROCERY MART", ...card })),
    input(row({ id: "ret", amount: "10.00", categoryId: "cat-food", weeklyAllowance: true, description: "GROCERY MART", ...card })),
    input(row({ id: "amexpay", amount: "-250.00", description: "AMEX EPAYMENT", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" })),
    input(row({ id: "xfer", amount: "-100.00", isTransfer: true, description: "XFER TO 8801" })),
    input(row({ id: "payroll", amount: "2391.40", categoryId: "cat-dining", pfcPrimary: "INCOME", pfcDetailed: "INCOME_SALARY", description: "MAPLEWORKS PAYROLL" })),
  ];
}

describe("periodBreakdown — (F2) known vs unresolved", () => {
  it("⭐ the live week by hand: known 179.76 vs the plan; unresolved 1,265.40; payments 350.00 apart", () => {
    const rows = liveWeek();
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    // Checking: loan 1150.40 + ins 95 + save 20 (unresolved) + coffee 25 + paypal 14.76 (known);
    // card: 150 − 10 = 140 (known).
    expect(b.actualCents).toBe(115040 + 9500 + 2000 + 2500 + 1476 + 14000);
    expect(b.knownCents).toBe(2500 + 1476 + 14000);
    expect(b.unresolved).toMatchObject({ cents: 115040 + 9500 + 2000, nettedByRefundsCents: 0, count: 3, truncated: false });
    expect(b.unresolved.rows.map((e) => [e.id, e.cents])).toEqual([["loan", 115040], ["ins", 9500], ["save", 2000]]);
    expect(b.knownCents + b.unresolved.cents).toBe(b.actualCents);
    // The plan comparison reads known: within, $120.24 left (actual alone reads $1,179.95 over).
    expect(b).toMatchObject({ remainingCents: 12024, overCents: 0, withinPlan: true, provisional: true });
    // The money position is unchanged: it still counts the unresolved rows (cautious).
    const pos = computePosition(positionInputs(rows, 30000));
    expect(Math.round(Number(pos.spentWeekDiscretionary) * 100)).toBe(b.actualCents);
    expect(pos.remainingWeek).toBe("-1145.16");
    // Every unfiled row is still in needsClassification; Σ groups + floor = actual as before.
    expect(b.needsClassification.cents).toBe(115040 + 9500 + 2000 + 2500 + 1476);
    expect(b.categories.reduce((a, c) => a + c.cents, 0) + b.needsClassification.cents + b.refundFloorAdjustmentCents).toBe(b.actualCents);
    // Payments and transfers: informational, never in actual or known.
    expect(b.excludedPayments).toMatchObject({ cents: 35000, count: 2, countsAgainstPlan: false });
    expect(b.excludedPayments.rows.map((e) => e.id)).toEqual(["amexpay", "xfer"]);
  });

  it("refunds net per account: a card's excess refund never lowers checking's known (and never makes it negative)", () => {
    const rows = [
      input(row({ id: "buy", amount: "-20.00", categoryId: "cat-food", weeklyAllowance: true, ...card })),
      input(row({ id: "ret", amount: "60.00", categoryId: "cat-food", weeklyAllowance: true, ...card })),
      input(row({ id: "coffee", amount: "-30.00", pfcPrimary: "FOOD_AND_DRINK" })),
      input(row({ id: "loan", amount: "-500.00", pfcPrimary: "LOAN_PAYMENTS" })),
    ];
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    // Card: 20 − 60 → 0. Checking: known 30, unresolved 500.
    expect([b.actualCents, b.knownCents, b.unresolved.cents, b.unresolved.nettedByRefundsCents]).toEqual([53000, 3000, 50000, 0]);
    expect(b.refundFloorAdjustmentCents).toBe(4000);
    expect(b.remainingCents).toBe(27000);
  });

  it("a refund on the SAME account as an unresolved row: nettedByRefunds says how much it absorbed", () => {
    const rows = [
      input(row({ id: "ret", amount: "40.00", categoryId: "cat-food", description: "GROCERY MART REFUND" })), // a refund word on checking, unfiled
      input(row({ id: "coffee", amount: "-10.00", pfcPrimary: "FOOD_AND_DRINK" })),
      input(row({ id: "loan", amount: "-100.00", pfcPrimary: "LOAN_PAYMENTS" })),
    ];
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    // Checking: −40 + 10 + 100 = 70. Known alone: −40 + 10 → 0. Unresolved adds 70 of its 100.
    expect([b.actualCents, b.knownCents, b.unresolved.cents, b.unresolved.nettedByRefundsCents]).toEqual([7000, 0, 7000, 3000]);
    expect(b.unresolved.rows.reduce((a, e) => a + e.cents, 0)).toBe(b.unresolved.cents + b.unresolved.nettedByRefundsCents);
  });

  it("a split unfiled row with contrary evidence counts in unresolved by its parts", () => {
    const rows = [
      input(row({ id: "split", amount: "-100.00", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_SAVINGS" }), mctx(), {
        splitParts: [
          { categoryId: "cat-subs", amount: "-60.00" },
          { categoryId: "cat-food", amount: "-40.00" },
        ],
      }),
      input(row({ id: "coffee", amount: "-5.00" })),
    ];
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect(b.unresolved).toMatchObject({ cents: 10000, count: 2 });
    expect(b.unresolved.rows.map((e) => [e.id, e.cents, e.splitPart?.index])).toEqual([["split", 6000, 0], ["split", 4000, 1]]);
    expect(b.knownCents).toBe(500);
  });

  it("provisional above max($25, 5% of the plan) — $25 exactly is not; no plan reads $25", () => {
    expect(isProvisional(2500, 30000)).toBe(false);
    expect(isProvisional(2501, 30000)).toBe(true);
    expect(isProvisional(5000, 100000)).toBe(false); // 5% of $1,000 = $50
    expect(isProvisional(5001, 100000)).toBe(true);
    expect(isProvisional(2501, null)).toBe(true);
    expect(isProvisional(0, null)).toBe(false);
  });

  it("not set is never $0: with no plan, remaining / over / within stay null while known and unresolved are said", () => {
    const b = periodBreakdown({ period: "week", rows: liveWeek(), planCents: null, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect([b.remainingCents, b.overCents, b.withinPlan]).toEqual([null, null, null]);
    expect(b.knownCents).toBe(17976);
    expect(b.provisional).toBe(true);
  });

  it("the month: monthly-flagged rows are the household's confirmation, so known === actual", () => {
    const rows = [
      input(row({ id: "m1", amount: "-300.00", categoryId: "cat-food", monthlyAllowance: true, pfcPrimary: "LOAN_PAYMENTS" })),
      input(row({ id: "u", amount: "-1150.40", pfcPrimary: "LOAN_PAYMENTS" })),
    ];
    const b = periodBreakdown({ period: "month", rows, planCents: 40000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect([b.actualCents, b.knownCents, b.unresolved.cents, b.provisional]).toEqual([30000, 30000, 0, false]);
    expect(b.remainingCents).toBe(10000);
  });

  it("⭐ on 400 seeded weeks: known + unresolved === actual === the position's spent; known ≤ actual; rows = amount + netted", () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let w = 0; w < 400; w += 1) {
      const rows: BreakdownRowInput<string>[] = [];
      const n = Math.floor(rnd() * 16);
      for (let i = 0; i < n; i += 1) {
        const onCard = rnd() < 0.4;
        const refund = rnd() < 0.2;
        const mag = Math.round(1 + rnd() * 20000) / 100;
        const r = row({
          id: `w${w}r${i}`,
          source: onCard ? "plaid:amex" : "plaid:chase",
          plaidAccountId: onCard ? AMEX : CHECKING,
          amount: refund ? mag : -mag,
          description: refund ? "STORE REFUND" : "STORE",
          categoryId: [null, "cat-food", "cat-subs"][Math.floor(rnd() * 3)]!,
          pfcPrimary: refund ? null : [null, "FOOD_AND_DRINK", "LOAN_PAYMENTS", "TRANSFER_OUT"][Math.floor(rnd() * 4)]!,
          weeklyAllowance: rnd() < 0.4,
          unplannedAllowance: rnd() < 0.05,
        });
        rows.push(input(r, mctx(), { suggestions: rnd() < 0.1 ? new Map([[r.id, SHIELD]]) : undefined }));
      }
      const cap = rnd() < 0.2 ? null : Math.round(rnd() * 60000);
      const b = periodBreakdown({ period: "week", rows, planCents: cap, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 50 });
      const pos = computePosition(positionInputs(rows, cap));
      expect(b.actualCents, `week ${w}`).toBe(Math.round(Number(pos.spentWeekDiscretionary) * 100));
      expect(b.knownCents + b.unresolved.cents, `week ${w}`).toBe(b.actualCents);
      expect(b.knownCents, `week ${w}`).toBeGreaterThanOrEqual(0);
      expect(b.knownCents, `week ${w}`).toBeLessThanOrEqual(b.actualCents);
      expect(b.unresolved.nettedByRefundsCents, `week ${w}`).toBeGreaterThanOrEqual(0);
      expect(b.unresolved.rows.reduce((a, e) => a + e.cents, 0), `week ${w}`).toBe(b.unresolved.cents + b.unresolved.nettedByRefundsCents);
      expect(b.categories.reduce((a, c) => a + c.cents, 0) + b.needsClassification.cents + b.refundFloorAdjustmentCents, `week ${w}`).toBe(b.actualCents);
      if (cap != null) expect(b.remainingCents, `week ${w}`).toBe(cap - b.knownCents);
      expect(b.provisional, `week ${w}`).toBe(isProvisional(b.unresolved.cents, cap));
    }
  });
});

// (PR-H) Pure unit tests for `classifyMovement`/`everydayPlan`
// (`@workspace/avalanche-core`), colocated here the same way `cashRows.test.ts`
// exercises `classifyCashRows` — no DB, but run inside the api-server suite so
// they gate every push alongside the rest of the household-money foundation.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyMovement,
  classifyOutflow,
  everydayPlan,
  isBankRow,
  isHouseholdWeekStart,
  isRealIncome,
  MOVEMENT_COVERAGES,
  PFC_CARD_PAYMENT,
  type MovementClassification,
  type MovementContext,
  type MovementCoverage,
  type MovementRow,
  type MovementTiming,
  type OutflowKind,
} from "@workspace/avalanche-core";

const CHECKING = "chase-ext";

function ctx(overrides: Partial<MovementContext> = {}): MovementContext {
  return {
    categoriesById: new Map(),
    debtCategoryIds: new Set(),
    checkingAccountExternalId: CHECKING,
    matchedTxnIds: new Set(),
    ...overrides,
  };
}

function row(overrides: Partial<MovementRow> = {}): MovementRow {
  return {
    id: "t1",
    occurredOn: "2026-09-01",
    amount: "-42.00",
    source: "plaid:chase",
    isTransfer: false,
    categoryId: null,
    description: "CORNER BISTRO",
    debtId: null,
    isExternalCardPayment: false,
    reimbursable: false,
    pfcDetailed: null,
    plaidAccountId: CHECKING,
    unplannedAllowance: false,
    monthlyAllowance: false,
    weeklyAllowance: false,
    ...overrides,
  };
}

describe("classifyMovement — precedence", () => {
  it("core rule: isTransfer wins over everything, including a confirmed match", () => {
    const r = row({ isTransfer: true, unplannedAllowance: true });
    const c = classifyMovement(r, ctx({ matchedTxnIds: new Set(["t1"]) }));
    expect(c.coverage).toBe("transfer");
    expect(c.conflict).toBeUndefined();
  });

  it("core rule: a tagged debt payment wins over allowance flags", () => {
    const r = row({ debtId: "debt-1", weeklyAllowance: true });
    expect(classifyMovement(r, ctx()).coverage).toBe("debt_payment");
  });

  it("core rule: isExternalCardPayment wins over a confirmed match", () => {
    const r = row({ isExternalCardPayment: true });
    const c = classifyMovement(r, ctx({ matchedTxnIds: new Set(["t1"]) }));
    expect(c.coverage).toBe("card_payment");
  });

  it("core rule: bank-noise pattern folds into transfer, exactly as the Spending report buckets it", () => {
    const r = row({ description: "ONLINE TRANSFER TO CHK 1234" });
    expect(classifyMovement(r, ctx()).coverage).toBe("transfer");
  });

  it("core rule: an excluded category wins over allowance flags", () => {
    const catCtx = ctx({
      categoriesById: new Map([["c1", { name: "Ignore", debtId: null, kind: "expense" }]]),
    });
    const r = row({ categoryId: "c1", monthlyAllowance: true });
    expect(classifyMovement(r, catCtx).coverage).toBe("excluded");
  });

  it("core rule: an outflow filed to an income category is 'income', not spend", () => {
    const catCtx = ctx({
      categoriesById: new Map([["c1", { name: "Paycheck", debtId: null, kind: "income" }]]),
    });
    const r = row({ categoryId: "c1", unplannedAllowance: true });
    expect(classifyMovement(r, catCtx).coverage).toBe("income");
  });

  it("a confirmed bill match wins over every allowance flag", () => {
    const r = row({ weeklyAllowance: true });
    const c = classifyMovement(r, ctx({ matchedTxnIds: new Set(["t1"]) }));
    expect(c.coverage).toBe("bill_matched");
  });

  it("conflict: a weekly flag on a confirmed match is reported, not silently dropped", () => {
    const r = row({ weeklyAllowance: true });
    const c = classifyMovement(r, ctx({ matchedTxnIds: new Set(["t1"]) }));
    expect(c.coverage).toBe("bill_matched");
    expect(c.conflict).toBe("flag_ignored_matched");
  });

  it("conflict: a monthly flag on a confirmed match is reported the same way", () => {
    const r = row({ monthlyAllowance: true });
    const c = classifyMovement(r, ctx({ matchedTxnIds: new Set(["t1"]) }));
    expect(c.coverage).toBe("bill_matched");
    expect(c.conflict).toBe("flag_ignored_matched");
  });

  it("conflict: an unplanned flag on a confirmed match gets its own conflict name", () => {
    const r = row({ unplannedAllowance: true });
    const c = classifyMovement(r, ctx({ matchedTxnIds: new Set(["t1"]) }));
    expect(c.coverage).toBe("bill_matched");
    expect(c.conflict).toBe("unplanned_on_matched");
  });

  it("unplanned beats monthly and weekly when there is no confirmed match", () => {
    const r = row({ unplannedAllowance: true, monthlyAllowance: true, weeklyAllowance: true });
    expect(classifyMovement(r, ctx()).coverage).toBe("unplanned");
  });

  it("monthly beats weekly", () => {
    const r = row({ monthlyAllowance: true, weeklyAllowance: true });
    expect(classifyMovement(r, ctx()).coverage).toBe("allowance_monthly");
  });

  it("weekly, alone, is allowance_weekly", () => {
    expect(classifyMovement(row({ weeklyAllowance: true }), ctx()).coverage).toBe(
      "allowance_weekly",
    );
  });

  it("reimbursable, with no match and no flags, is its own coverage", () => {
    expect(classifyMovement(row({ reimbursable: true }), ctx()).coverage).toBe("reimbursable");
  });

  it("nothing matched, no flags: needs_classification", () => {
    expect(classifyMovement(row(), ctx()).coverage).toBe("needs_classification");
  });

  it("a real deposit in an income category is income", () => {
    const catCtx = ctx({
      categoriesById: new Map([["c1", { name: "Paycheck", debtId: null, kind: "income" }]]),
    });
    const r = row({ amount: "2000.00", categoryId: "c1" });
    expect(classifyMovement(r, catCtx).coverage).toBe("income");
  });

  it("a transfer-in deposit is excluded, not income", () => {
    const r = row({ amount: "500.00", isTransfer: true });
    expect(classifyMovement(r, ctx()).coverage).toBe("excluded");
  });

  it("an uncategorized deposit is excluded, not income (isRealIncome requires a category)", () => {
    const r = row({ amount: "500.00" });
    expect(classifyMovement(r, ctx()).coverage).toBe("excluded");
  });
});

describe("classifyMovement — targeted pins (review round 1, L4)", () => {
  // Mutation M4: dropping `reimbursableIsSpend` lets `classifyOutflow`'s rule 7
  // answer "reimbursable" BEFORE its card-payment rules, so a reimbursable card
  // payment would fall through to steps 2-7 instead of stopping at step 1.
  it("a reimbursable row that is a card payment is still a card payment (rules 8 and 9 run)", () => {
    const byPattern = row({ reimbursable: true, description: "CRCARDPMT REF 42", weeklyAllowance: true });
    expect(classifyMovement(byPattern, ctx()).coverage).toBe("card_payment");
    const byPfc = row({ reimbursable: true, pfcDetailed: PFC_CARD_PAYMENT });
    expect(classifyMovement(byPfc, ctx({ matchedTxnIds: new Set(["t1"]) })).coverage).toBe(
      "card_payment",
    );
  });

  it("a reimbursable bank-noise row is still folded into transfer", () => {
    const r = row({ reimbursable: true, description: "PLANET FITNESS AUTOPAY" });
    expect(classifyMovement(r, ctx()).coverage).toBe("transfer");
  });

  // Mutation M8: the unplanned conflict is checked first, so a matched row
  // flagged BOTH unplanned and weekly/monthly reports the unplanned conflict.
  it("a confirmed match on a row flagged unplanned AND weekly/monthly reports unplanned_on_matched", () => {
    const matched = ctx({ matchedTxnIds: new Set(["t1"]) });
    for (const extra of [{ weeklyAllowance: true }, { monthlyAllowance: true }]) {
      const c = classifyMovement(row({ unplannedAllowance: true, ...extra }), matched);
      expect(c).toMatchObject({ coverage: "bill_matched", conflict: "unplanned_on_matched" });
    }
  });
});

describe("classifyMovement — tier-2 pairs (injected; honoured only on a row with no flag)", () => {
  const tier2 = (ids: string[]) => ctx({ tier2PairedTxnIds: new Set(ids) });

  it("a tier-2 pair on an unflagged row reads bill_matched, with no conflict", () => {
    const c = classifyMovement(row(), tier2(["t1"]));
    expect(c.coverage).toBe("bill_matched");
    expect(c.conflict).toBeUndefined();
  });

  it("a tier-2 pair never overrides an allowance flag: the row keeps its flag", () => {
    expect(classifyMovement(row({ unplannedAllowance: true }), tier2(["t1"])).coverage).toBe("unplanned");
    expect(classifyMovement(row({ monthlyAllowance: true }), tier2(["t1"])).coverage).toBe("allowance_monthly");
    const weekly = classifyMovement(row({ weeklyAllowance: true }), tier2(["t1"]));
    expect(weekly.coverage).toBe("allowance_weekly");
    expect(weekly.conflict).toBeUndefined();
  });

  it("a tier-2 pair cannot pre-empt the core rule", () => {
    expect(classifyMovement(row({ isTransfer: true }), tier2(["t1"])).coverage).toBe("transfer");
    expect(classifyMovement(row({ debtId: "debt-1" }), tier2(["t1"])).coverage).toBe("debt_payment");
  });

  it("an unflagged reimbursable row on a tier-2 pair reads bill_matched (reimbursable is not an allowance flag)", () => {
    expect(classifyMovement(row({ reimbursable: true }), tier2(["t1"])).coverage).toBe("bill_matched");
  });

  it("omitted, empty, or naming another row: no effect", () => {
    expect(classifyMovement(row(), ctx()).coverage).toBe("needs_classification");
    expect(classifyMovement(row(), tier2([])).coverage).toBe("needs_classification");
    expect(classifyMovement(row(), tier2(["t2"])).coverage).toBe("needs_classification");
  });

  it("a confirmed match still wins on a flagged row, and still reports the flag it beat", () => {
    const both = ctx({ matchedTxnIds: new Set(["t1"]), tier2PairedTxnIds: new Set(["t1"]) });
    expect(classifyMovement(row({ weeklyAllowance: true }), both)).toMatchObject({
      coverage: "bill_matched",
      conflict: "flag_ignored_matched",
    });
  });
});

describe("classifyMovement — timing", () => {
  it("a row on the tracked checking account is 'checking'", () => {
    const c = classifyMovement(row(), ctx());
    expect(c.timing).toEqual({ kind: "checking", date: "2026-09-01" });
  });

  it("an Amex ledger row is 'card', keyed by its account id", () => {
    const r = row({ source: "plaid:amex", plaidAccountId: "amex-acct", amount: "42.00" });
    const c = classifyMovement(r, ctx());
    expect(c.timing).toEqual({ kind: "card", accountId: "amex-acct", date: "2026-09-01" });
  });

  it("a manual (workbook) Amex row with no linked account falls back to its source as the key", () => {
    const r = row({ source: "amex", plaidAccountId: null, amount: "42.00" });
    const c = classifyMovement(r, ctx());
    expect(c.timing).toEqual({ kind: "card", accountId: "amex", date: "2026-09-01" });
  });

  it("a row on neither the tracked account nor a card ledger is 'none'", () => {
    const r = row({ source: "plaid:othercard", plaidAccountId: "other-ext" });
    const c = classifyMovement(r, ctx());
    expect(c.timing).toEqual({ kind: "none" });
  });

  it("timing tracks isBankRow exactly: same inputs, same verdict", () => {
    const r = row({ source: "plaid:chase", plaidAccountId: "some-other-acct" });
    const c = classifyMovement(r, ctx());
    expect(isBankRow(r.source, r.plaidAccountId, CHECKING)).toBe(false);
    expect(c.timing.kind).not.toBe("checking");
  });

  // (review N2) With no resolved checking account the cash rule still counts a
  // manual row as the account's own, so the money model must too.
  it("no resolved checking account: a manual row is still 'checking', a Plaid row never is", () => {
    const noAccount = ctx({ checkingAccountExternalId: null });
    const manual = row({ source: "manual", plaidAccountId: null });
    expect(classifyMovement(manual, noAccount).timing).toEqual({ kind: "checking", date: "2026-09-01" });
    expect(isBankRow("manual", null, null)).toBe(true);
    const plaid = row({ source: "plaid:chase", plaidAccountId: CHECKING });
    expect(classifyMovement(plaid, noAccount).timing).toEqual({ kind: "none" });
  });
});

// ── Property test (review N3): every row gets exactly one coverage and one
// timing, and the answer is the one plan section A specifies — checked against
// an independent model of the spec over seeded rows built so that EVERY
// precedence path, conflict and tier-2 branch is actually reached. The hit
// counts are asserted, so a generator that stops reaching a path fails.
// Deterministic (seeded mulberry32), no external dependency.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plan section A, written out as its own model — not a copy of the implementation's control flow. */
function specClassification(r: MovementRow, c: MovementContext): MovementClassification {
  const onCardLedger = ["amex", "plaid:amex"].includes(r.source.toLowerCase());
  const timing: MovementTiming = isBankRow(r.source, r.plaidAccountId, c.checkingAccountExternalId)
    ? { kind: "checking", date: r.occurredOn }
    : onCardLedger
      ? { kind: "card", accountId: r.plaidAccountId ?? r.source, date: r.occurredOn }
      : { kind: "none" };

  // 1. The core rule decides transfer / debt / card payment / income / excluded.
  const core = classifyOutflow(r, c, { reimbursableIsSpend: true });
  if (core.kind === "not_outflow") {
    return { coverage: isRealIncome(r, c) ? "income" : "excluded", timing };
  }
  const step1: Partial<Record<OutflowKind, MovementCoverage>> = {
    transfer: "transfer",
    bank_noise: "transfer",
    debt_payment: "debt_payment",
    card_payment: "card_payment",
    excluded_category: "excluded",
    income: "income",
  };
  const decided = step1[core.kind];
  if (decided) return { coverage: decided, timing };

  const flags = { unplanned: r.unplannedAllowance, monthly: r.monthlyAllowance, weekly: r.weeklyAllowance };
  const anyFlag = flags.unplanned || flags.monthly || flags.weekly;
  // 2. A confirmed match (conflicts reported), or a tier-2 pair with no flag.
  if (c.matchedTxnIds.has(r.id)) {
    const conflict = flags.unplanned
      ? "unplanned_on_matched"
      : anyFlag
        ? "flag_ignored_matched"
        : undefined;
    return conflict ? { coverage: "bill_matched", timing, conflict } : { coverage: "bill_matched", timing };
  }
  if (!anyFlag && (c.tier2PairedTxnIds ?? new Set()).has(r.id)) return { coverage: "bill_matched", timing };
  // 3-7.
  const ladder: [boolean, MovementCoverage][] = [
    [flags.unplanned, "unplanned"],
    [flags.monthly, "allowance_monthly"],
    [flags.weekly, "allowance_weekly"],
    [r.reimbursable, "reimbursable"],
  ];
  for (const [on, coverage] of ladder) if (on) return { coverage, timing };
  return { coverage: "needs_classification", timing };
}

describe("classifyMovement — property: exactly one coverage, the spec's precedence, every path hit", () => {
  const N = 6000;
  const MIN_HITS = 25;
  const categoriesById = new Map<string, { name: string; debtId: string | null; kind: string }>([
    ["cat-plain", { name: "Groceries", debtId: null, kind: "expense" }],
    ["cat-uncat", { name: "Uncategorized", debtId: null, kind: "expense" }],
    ["cat-debt", { name: "Card Payoff", debtId: "debt-1", kind: "expense" }],
    ["cat-ignore", { name: "Ignore", debtId: null, kind: "expense" }],
    ["cat-transfer", { name: "Transfer", debtId: null, kind: "expense" }],
    ["cat-income", { name: "Paycheck", debtId: null, kind: "income" }],
  ]);
  const debtCategoryIds = new Set(["cat-debt"]);
  const MERCHANTS = ["CORNER BISTRO", "GREEN GROCER", "HARDWARE DEPOT", "CITY PHARMACY"];
  const ACCOUNTS: { source: string; plaidAccountId: string | null }[] = [
    { source: "plaid:chase", plaidAccountId: CHECKING },
    { source: "plaid:chase", plaidAccountId: "savings-ext" },
    { source: "plaid:amex", plaidAccountId: "amex-ext" },
    { source: "amex", plaidAccountId: null },
    { source: "manual", plaidAccountId: null },
  ];
  // One trigger for the core rule (step 1) on 40% of rows; the rest reach step 2.
  type Trigger = (r: MovementRow) => void;
  const TRIGGERS: Trigger[] = [
    (r) => (r.isTransfer = true),
    (r) => (r.debtId = "debt-2"),
    (r) => (r.isExternalCardPayment = true),
    (r) => (r.categoryId = "cat-debt"),
    (r) => (r.categoryId = "cat-ignore"),
    (r) => (r.categoryId = "cat-transfer"),
    (r) => (r.categoryId = "cat-income"),
    (r) => (r.pfcDetailed = PFC_CARD_PAYMENT),
    (r) => (r.description = "CRCARDPMT REF 991"),
    (r) => (r.description = "ONLINE TRANSFER TO CHK"),
    (r) => (r.amount = -Number(r.amount)), // an inflow
    (r) => {
      r.amount = -Number(r.amount); // an inflow in an income category: real income
      r.categoryId = "cat-income";
    },
    (r) => (r.amount = 0),
  ];

  it(`${N} seeded rows: each equals the spec model, and every precedence path is reached at least ${MIN_HITS} times`, () => {
    const rnd = mulberry32(20260915);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
    const bool = (p: number) => rnd() < p;
    const hits = new Map<string, number>();
    const hit = (k: string) => hits.set(k, (hits.get(k) ?? 0) + 1);

    for (let i = 0; i < N; i += 1) {
      const account = pick(ACCOUNTS);
      const magnitude = Math.round(1 + rnd() * 29999) / 100;
      const r: MovementRow = {
        id: `row-${i}`,
        occurredOn: "2026-09-01",
        amount: account.source === "amex" ? magnitude : -magnitude,
        source: account.source,
        isTransfer: false,
        categoryId: pick([null, "cat-plain", "cat-uncat", "cat-deleted"]),
        description: pick(MERCHANTS),
        debtId: null,
        isExternalCardPayment: false,
        reimbursable: bool(0.3),
        pfcDetailed: null,
        plaidAccountId: account.plaidAccountId,
        unplannedAllowance: bool(0.35),
        monthlyAllowance: bool(0.35),
        weeklyAllowance: bool(0.35),
      };
      if (bool(0.4)) pick(TRIGGERS)(r);
      const matched = bool(0.25);
      const tier2 = bool(0.3);
      const c = ctx({
        categoriesById,
        debtCategoryIds,
        checkingAccountExternalId: bool(0.8) ? CHECKING : null,
        matchedTxnIds: matched ? new Set([r.id]) : new Set(),
        tier2PairedTxnIds: tier2 ? new Set([r.id]) : bool(0.5) ? new Set(["someone-else"]) : undefined,
      });

      const got = classifyMovement(r, c);
      expect(MOVEMENT_COVERAGES).toContain(got.coverage);
      expect(got, `row ${i}`).toEqual(specClassification(r, c));

      // Tally which branch of the spec this row took.
      const core = classifyOutflow(r, c, { reimbursableIsSpend: true });
      const anyFlag = r.unplannedAllowance || r.monthlyAllowance || r.weeklyAllowance;
      hit(`timing:${got.timing.kind}`);
      if (got.timing.kind === "checking" && c.checkingAccountExternalId === null) hit("timing:checking-with-no-account");
      if (core.kind === "not_outflow") hit(`step1:inflow->${got.coverage}`);
      else if (core.kind !== "spend") {
        hit(`step1:${core.kind}`);
        if (r.reimbursable && core.kind === "card_payment") hit("step1:card_payment-over-reimbursable");
      } else if (matched) {
        hit(got.conflict ? `step2:confirmed+${got.conflict}` : "step2:confirmed");
        if (r.unplannedAllowance && (r.weeklyAllowance || r.monthlyAllowance)) hit("step2:confirmed+unplanned+other-flag");
        if (tier2) hit("step2:confirmed-and-tier2");
      } else if (tier2 && !anyFlag) {
        hit("step2:tier2");
      } else {
        if (tier2) hit("tier2-ignored:flagged");
        hit(`step3-7:${got.coverage}`);
        if (r.reimbursable && anyFlag) hit("step3-5:flag-over-reimbursable");
        if (r.unplannedAllowance && (r.monthlyAllowance || r.weeklyAllowance)) hit("step3:unplanned-over-other-flag");
        if (!r.unplannedAllowance && r.monthlyAllowance && r.weeklyAllowance) hit("step4:monthly-over-weekly");
      }
    }

    const required = [
      "timing:checking",
      "timing:card",
      "timing:none",
      "timing:checking-with-no-account",
      "step1:transfer",
      "step1:bank_noise",
      "step1:debt_payment",
      "step1:card_payment",
      "step1:card_payment-over-reimbursable",
      "step1:excluded_category",
      "step1:income",
      "step1:inflow->income",
      "step1:inflow->excluded",
      "step2:confirmed",
      "step2:confirmed+flag_ignored_matched",
      "step2:confirmed+unplanned_on_matched",
      "step2:confirmed+unplanned+other-flag",
      "step2:confirmed-and-tier2",
      "step2:tier2",
      "tier2-ignored:flagged",
      "step3-7:unplanned",
      "step3:unplanned-over-other-flag",
      "step3-7:allowance_monthly",
      "step4:monthly-over-weekly",
      "step3-7:allowance_weekly",
      "step3-5:flag-over-reimbursable",
      "step3-7:reimbursable",
      "step3-7:needs_classification",
    ];
    // For the review note: PRH_PRINT_HITS=<file> writes the tally there.
    if (process.env.PRH_PRINT_HITS) {
      writeFileSync(process.env.PRH_PRINT_HITS, JSON.stringify(Object.fromEntries([...hits].sort()), null, 2));
    }
    for (const key of required) {
      expect(hits.get(key) ?? 0, key).toBeGreaterThanOrEqual(MIN_HITS);
    }
  });
});

describe("everydayPlan", () => {
  const settings = { weeklyAllowanceAmount: "150.00", monthlyAllowanceAmount: "400.00" };

  it("uses the standing weekly amount when no override exists for the week", () => {
    expect(everydayPlan("2026-09-06", settings, {})).toEqual({
      weeklyCents: 15000,
      monthlyCents: 40000,
    });
  });

  it("uses that week's override when one is set", () => {
    const overrides = { "2026-09-06": "200.00" };
    expect(everydayPlan("2026-09-06", settings, overrides).weeklyCents).toBe(20000);
  });

  it("a different week's override does not leak into this week", () => {
    const overrides = { "2026-09-13": "999.00" };
    expect(everydayPlan("2026-09-06", settings, overrides).weeklyCents).toBe(15000);
  });

  it("monthly has no per-period override: always the standing amount", () => {
    const overrides = { "2026-09-06": "999.00" };
    expect(everydayPlan("2026-09-06", settings, overrides).monthlyCents).toBe(40000);
  });

  it("treats a missing/undefined overrides map as no override", () => {
    expect(everydayPlan("2026-09-06", settings).weeklyCents).toBe(15000);
    expect(everydayPlan("2026-09-06", settings, null).weeklyCents).toBe(15000);
  });

  it("a numeric override works the same as a string one", () => {
    expect(everydayPlan("2026-09-06", settings, { "2026-09-06": 175 }).weeklyCents).toBe(17500);
  });

  it("an unparsable standing amount is treated as zero, never NaN", () => {
    const bad = { weeklyAllowanceAmount: "not-a-number", monthlyAllowanceAmount: null };
    expect(everydayPlan("2026-09-06", bad)).toEqual({ weeklyCents: 0, monthlyCents: 0 });
  });

  // (review L3) The PUT schema accepts any string. `parseFloat("12abc")` is 12;
  // the Allowances page reads `Number("12abc")` (NaN) as no override.
  it("an override that is not a finite number falls back to the standing amount", () => {
    for (const bad of ["12abc", "abc", "Infinity", "NaN", "1,200"]) {
      expect(everydayPlan("2026-09-06", settings, { "2026-09-06": bad }).weeklyCents, bad).toBe(15000);
    }
  });

  it("an override parses like Number(): padding and exponent forms read as the web reads them", () => {
    expect(everydayPlan("2026-09-06", settings, { "2026-09-06": " 175.50 " }).weeklyCents).toBe(17550);
    expect(everydayPlan("2026-09-06", settings, { "2026-09-06": "1e2" }).weeklyCents).toBe(10000);
    expect(everydayPlan("2026-09-06", settings, { "2026-09-06": "0" }).weeklyCents).toBe(0);
  });

  it("a key that is not a week start on the household clock is ignored", () => {
    // Monday 2026-09-07; an impossible date; a non-ISO spelling.
    expect(everydayPlan("2026-09-07", settings, { "2026-09-07": "999.00" }).weeklyCents).toBe(15000);
    expect(everydayPlan("2026-02-29", settings, { "2026-02-29": "999.00" }).weeklyCents).toBe(15000);
    expect(everydayPlan("2026-9-6", settings, { "2026-9-6": "999.00" }).weeklyCents).toBe(15000);
  });

  it("isHouseholdWeekStart: a real Sunday only", () => {
    expect(isHouseholdWeekStart("2026-09-06")).toBe(true);
    expect(isHouseholdWeekStart("2026-01-04")).toBe(true);
    expect(isHouseholdWeekStart("2026-11-01")).toBe(true); // the DST-change Sunday
    expect(isHouseholdWeekStart("2026-09-07")).toBe(false);
    expect(isHouseholdWeekStart("2026-09-12")).toBe(false);
    expect(isHouseholdWeekStart("2026-02-30")).toBe(false);
    expect(isHouseholdWeekStart("2026-9-6")).toBe(false);
    expect(isHouseholdWeekStart("")).toBe(false);
  });

  it("agrees with the Allowances page's own formula, value by value", () => {
    // allowances.tsx: the `weeklyOverrides` memo keeps an entry only when
    // Number(v) is finite; the `planned` memo uses it, else
    // Number(settings.weeklyAllowanceAmount) || 0.
    const webWeeklyDollars = (raw: string | number, standing: string) => {
      const n = Number(raw);
      const override = Number.isFinite(n) ? n : undefined;
      return override != null ? override : Number(standing) || 0;
    };
    for (const raw of ["200.00", "12abc", "", " 99.5", "1e3", "-5", "0", 175, "NaN", "Infinity", "7.005"]) {
      const server = everydayPlan("2026-09-06", settings, { "2026-09-06": raw }).weeklyCents;
      expect(server, String(raw)).toBe(Math.round(webWeeklyDollars(raw, settings.weeklyAllowanceAmount) * 100));
    }
  });
});

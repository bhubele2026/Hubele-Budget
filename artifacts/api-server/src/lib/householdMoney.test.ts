// (PR-H) Pure unit tests for `classifyMovement`/`everydayPlan`
// (`@workspace/avalanche-core`), colocated here the same way `cashRows.test.ts`
// exercises `classifyCashRows` — no DB, but run inside the api-server suite so
// they gate every push alongside the rest of the household-money foundation.

import { describe, expect, it } from "vitest";
import {
  classifyMovement,
  everydayPlan,
  isBankRow,
  MOVEMENT_COVERAGES,
  spendAmount,
  type MovementContext,
  type MovementCoverage,
  type MovementRow,
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
});

// ── Property test: every row gets exactly one coverage, precedence holds,
// conflicts are reported — over a large randomized space. Deterministic
// (seeded), no external dependency: this repo does not carry a property-test
// library, so a small mulberry32 PRNG stands in for one.
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

const SOURCES = ["plaid:chase", "amex", "plaid:amex", "manual", "plaid:othercard"];
const DESCRIPTIONS = ["CORNER BISTRO", "ONLINE TRANSFER TO CHK", "CRCARDPMT REF 991", "PAYCHECK DEPOSIT"];

describe("classifyMovement — property: exactly one coverage, precedence holds", () => {
  const rnd = mulberry32(20260914);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const bool = (p = 0.5) => rnd() < p;

  const categoriesById = new Map<string, { name: string; debtId: string | null; kind: string }>([
    ["cat-plain", { name: "Groceries", debtId: null, kind: "expense" }],
    ["cat-debt", { name: "Card Payoff", debtId: "debt-1", kind: "expense" }],
    ["cat-excluded", { name: "Transfer", debtId: null, kind: "expense" }],
    ["cat-income", { name: "Paycheck", debtId: null, kind: "income" }],
  ]);
  const debtCategoryIds = new Set(["cat-debt"]);
  const categoryIds = [null, "cat-plain", "cat-debt", "cat-excluded", "cat-income"];

  for (let i = 0; i < 500; i += 1) {
    it(`random row #${i}`, () => {
      const amountSign = bool() ? -1 : 1;
      const source = pick(SOURCES);
      const amount = (amountSign * Math.round(rnd() * 30000)) / 100;
      const r: MovementRow = {
        id: `row-${i}`,
        occurredOn: "2026-09-01",
        amount,
        source,
        isTransfer: bool(0.1),
        categoryId: pick(categoryIds),
        description: pick(DESCRIPTIONS),
        debtId: bool(0.1) ? "debt-2" : null,
        isExternalCardPayment: bool(0.05),
        reimbursable: bool(0.15),
        pfcDetailed: bool(0.05) ? "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" : null,
        plaidAccountId: bool(0.7) ? CHECKING : "some-other-acct",
        unplannedAllowance: bool(0.15),
        monthlyAllowance: bool(0.15),
        weeklyAllowance: bool(0.15),
      };
      const matched = bool(0.2);
      const c = classifyMovement(
        r,
        ctx({
          categoriesById,
          debtCategoryIds,
          matchedTxnIds: matched ? new Set([r.id]) : new Set(),
        }),
      );

      // Exactly one coverage, and it is a real one.
      expect(MOVEMENT_COVERAGES).toContain(c.coverage);

      // Exactly one timing, and it agrees with isBankRow's own verdict.
      const isChecking = isBankRow(r.source, r.plaidAccountId, CHECKING);
      expect(c.timing.kind === "checking").toBe(isChecking);

      // Precedence: isTransfer/debtId only decide an actual OUTFLOW — like
      // `classifyOutflow`, an inflow (or a zero amount) is "not_outflow"
      // regardless of either flag, so these two only apply when the row is
      // one (`spendAmount(r) > 0`).
      const isOutflow = spendAmount(r) > 0;
      if (isOutflow && r.isTransfer) expect(c.coverage).toBe("transfer");
      if (isOutflow && !r.isTransfer && r.debtId) expect(c.coverage).toBe("debt_payment");

      // A confirmed match, once it reaches step 2 (nothing in the core rule
      // fired first), always reads as bill_matched — never left at a flag or
      // reimbursable or needs_classification coverage instead.
      const coreDecided: MovementCoverage[] = [
        "transfer",
        "debt_payment",
        "card_payment",
        "income",
        "excluded",
      ];
      if (matched && !coreDecided.includes(c.coverage)) {
        expect(c.coverage).toBe("bill_matched");
      }

      // Conflicts are reported ONLY alongside bill_matched, and only for the
      // flag combination that produces them.
      if (c.conflict) {
        expect(c.coverage).toBe("bill_matched");
        if (c.conflict === "unplanned_on_matched") expect(r.unplannedAllowance).toBe(true);
        if (c.conflict === "flag_ignored_matched") {
          expect(r.unplannedAllowance).toBe(false);
          expect(r.monthlyAllowance || r.weeklyAllowance).toBe(true);
        }
      } else if (c.coverage === "bill_matched") {
        // No flag at all: a clean match, no conflict to report.
        expect(r.unplannedAllowance || r.monthlyAllowance || r.weeklyAllowance).toBe(false);
      }
    });
  }
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

  it("an unparsable amount is treated as zero, never NaN", () => {
    const bad = { weeklyAllowanceAmount: "not-a-number", monthlyAllowanceAmount: null };
    expect(everydayPlan("2026-09-06", bad)).toEqual({ weeklyCents: 0, monthlyCents: 0 });
  });
});

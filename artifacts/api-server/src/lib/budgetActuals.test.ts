// (PR-H) Parity between today's allowance-bucket rule (`aggregateBudgetMonth`)
// and the classifier's view of the same rows (`classifierAllowanceRows`,
// `classifyMovement`) — and the one documented place they will diverge once
// decision 12 lands (a confirmed bill match, PR8r/PR10): see
// docs/reviews/2026-09-14-household-money-core.md.

import { describe, expect, it } from "vitest";
import type { MovementContext } from "./spendingFilter";
import {
  aggregateBudgetMonth,
  classifierAllowanceRows,
  type ClassifierBudgetMonthRow,
} from "./budgetActuals";
import { uncategorizedCategoryIds, type FilingContext } from "./pendingFiling";

const filingCtx: FilingContext = { uncategorizedIds: uncategorizedCategoryIds([]) };
const noSupersede = { replacedIds: new Set<string>(), replacedBy: new Map() };

function movementCtx(matchedTxnIds: ReadonlySet<string> = new Set()): MovementContext {
  return {
    categoriesById: new Map(),
    debtCategoryIds: new Set(),
    checkingAccountExternalId: "chase-ext",
    matchedTxnIds,
  };
}

function row(overrides: Partial<ClassifierBudgetMonthRow> = {}): ClassifierBudgetMonthRow {
  return {
    id: "t1",
    description: "CORNER BISTRO",
    source: "plaid:chase",
    amount: "-42.00",
    pending: false,
    isExternalCardPayment: false,
    categoryId: "cat-1",
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    weeklyBucket: null,
    reimbursable: false,
    debtId: null,
    isTransfer: false,
    isTransferUserOverridden: false,
    occurredOn: "2026-09-01",
    plaidAccountId: "chase-ext",
    pfcDetailed: null,
    ...overrides,
  };
}

describe("classifierAllowanceRows — parity with aggregateBudgetMonth, no bill match", () => {
  it("with no confirmed match, the classifier's bucket rows are IDENTICAL to today's", () => {
    // ⚠️ No row here is BOTH reimbursable AND flagged — that combination is
    // its own documented difference below, not part of this invariant.
    const rows: ClassifierBudgetMonthRow[] = [
      row({ id: "t1", weeklyAllowance: true, weeklyBucket: "groceries", amount: "-60.00" }),
      row({ id: "t2", monthlyAllowance: true, amount: "-120.00" }),
      row({ id: "t3", unplannedAllowance: true, amount: "-15.00" }),
      row({ id: "t4", amount: "-30.00" }), // no flag: buckets nowhere, either way
      row({ id: "t5", isTransfer: true, amount: "-500.00" }), // excluded either way
      row({ id: "t6", debtId: "debt-1", amount: "-200.00" }), // excluded either way
      row({ id: "t7", reimbursable: true, amount: "-25.00" }), // no flag: excluded either way
    ];

    const today = aggregateBudgetMonth(rows, noSupersede, filingCtx).allowanceRows;
    const classifier = classifierAllowanceRows(
      rows,
      noSupersede,
      filingCtx,
      movementCtx(),
      { billMatchedCounts: true },
    );
    expect(classifier).toEqual(today);
    // Sanity: the invariant is non-trivial (some rows really did bucket).
    expect(today.length).toBe(3);
  });
});

describe("classifierAllowanceRows — a SECOND documented difference: reimbursable + a flag", () => {
  // Today's rule (`aggregateBudgetMonth`) gates on `!t.reimbursable` BEFORE
  // ever looking at a flag: a reimbursable row buckets nowhere, no matter what
  // flag it also carries. `classifyMovement`'s precedence (steps 3-5, the
  // allowance flags) is specified to outrank step 6 (reimbursable) — so a row
  // that is BOTH reimbursable AND flagged reads as its flag's bucket under the
  // classifier. Independent of bill-matching; still moves in PR8r/PR10.
  it("today excludes it entirely; the classifier's flag precedence counts it", () => {
    const rows: ClassifierBudgetMonthRow[] = [
      row({ id: "reimb-flag-1", weeklyAllowance: true, reimbursable: true, amount: "-25.00" }),
    ];

    const today = aggregateBudgetMonth(rows, noSupersede, filingCtx).allowanceRows;
    expect(today).toEqual([]);

    const classifier = classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx());
    expect(classifier).toEqual([
      { bucket: "weekly", subBucket: null, pending: false, spend: "25.00", cnt: "1" },
    ]);
  });
});

describe("classifierAllowanceRows — the documented PR8r/PR10 difference: a matched, flagged row", () => {
  it("today counts a matched weekly-flagged row in the weekly bucket; the forward rule excludes it", () => {
    const matched = row({
      id: "matched-1",
      weeklyAllowance: true,
      weeklyBucket: "dining",
      amount: "-88.40",
    });
    const rows = [matched];
    const matchedTxnIds = new Set(["matched-1"]);

    // TODAY: the real production function, unaware of bill matching at all.
    const today = aggregateBudgetMonth(rows, noSupersede, filingCtx).allowanceRows;
    expect(today).toEqual([
      { bucket: "weekly", subBucket: "dining", pending: false, spend: "88.40", cnt: "1" },
    ]);

    // PARITY: the classifier, told to keep counting a match (billMatchedCounts:
    // true, the default), reproduces today's figure exactly.
    const classifierToday = classifierAllowanceRows(
      rows,
      noSupersede,
      filingCtx,
      movementCtx(matchedTxnIds),
    );
    expect(classifierToday).toEqual(today);

    // FORWARD (PR8r/PR10, decision 12): a confirmed match wins over the flag,
    // so the row buckets nowhere — it is already counted in the bills plan.
    const classifierForward = classifierAllowanceRows(
      rows,
      noSupersede,
      filingCtx,
      movementCtx(matchedTxnIds),
      { billMatchedCounts: false },
    );
    expect(classifierForward).toEqual([]);

    // The delta this change will introduce, pinned to the cent.
    const todayWeeklyCents = today.reduce((s, r) => s + Math.round(parseFloat(r.spend) * 100), 0);
    const forwardWeeklyCents = classifierForward.reduce(
      (s, r) => s + Math.round(parseFloat(r.spend) * 100),
      0,
    );
    expect(todayWeeklyCents - forwardWeeklyCents).toBe(8840);
  });

  it("an unmatched row with the same flag is unaffected by billMatchedCounts", () => {
    const rows: ClassifierBudgetMonthRow[] = [row({ id: "plain-1", weeklyAllowance: true, amount: "-50.00" })];
    const withMatchOff = classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(), {
      billMatchedCounts: false,
    });
    const withMatchOn = classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(), {
      billMatchedCounts: true,
    });
    expect(withMatchOff).toEqual(withMatchOn);
    expect(withMatchOff).toEqual([
      { bucket: "weekly", subBucket: null, pending: false, spend: "50.00", cnt: "1" },
    ]);
  });
});

describe("classifierAllowanceRows — replaced-pending rows are skipped, same as today", () => {
  it("a pending row a posted row replaced is counted nowhere", () => {
    const rows: ClassifierBudgetMonthRow[] = [
      row({ id: "pending-1", pending: true, weeklyAllowance: true, amount: "-40.00" }),
    ];
    const supersede = {
      replacedIds: new Set(["pending-1"]),
      replacedBy: new Map(),
    };
    expect(aggregateBudgetMonth(rows, supersede, filingCtx).allowanceRows).toEqual([]);
    expect(classifierAllowanceRows(rows, supersede, filingCtx, movementCtx())).toEqual([]);
  });
});

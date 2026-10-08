// (PR-B1) `computePosition` — the money position's rules, one test per rule.
// Pure: synthetic curves and weeks, no database. Today is Wed 2026-10-07 unless
// a test says otherwise.

import { describe, it, expect } from "vitest";
import {
  classifyMovement,
  computePosition,
  selectPayday,
  spendAmount,
  addDaysISO,
  POSITION_ASSUMPTIONS,
  PAYDAY_MAX_DAYS,
  type MovementContext,
  type MovementRow,
  type PositionEvent,
  type PositionInputs,
  type PositionWeekRow,
  type MovementCoverage,
} from "@workspace/avalanche-core";

const TODAY = "2026-10-07"; // Wednesday

/** A curve of `days` end-of-day balances from `from`, each given in dollars. */
function curve(from: string, balances: number[]): PositionInputs["daily"] {
  return balances.map((b, i) => ({ date: addDaysISO(from, i), balance: b.toFixed(2) }));
}

const paycheck = (date: string, amount = 2000, over: Partial<PositionEvent> = {}): PositionEvent => ({
  date,
  amount,
  kind: "income",
  itemId: "pay",
  label: "Paycheck",
  ...over,
});
const bill = (date: string, amount: number, over: Partial<PositionEvent> = {}): PositionEvent => ({
  date,
  amount: -Math.abs(amount),
  kind: "expense",
  itemId: `bill-${date}-${amount}`,
  label: "Bill",
  ...over,
});

function inputs(over: Partial<PositionInputs> = {}): PositionInputs {
  return {
    todayISO: TODAY,
    daily: curve(TODAY, [2000, 1900, 3900, 3800, 3700, 3600, 3500, 3400, 3300, 3200]),
    events: [bill("2026-10-08", 100), paycheck("2026-10-09")],
    incomeItems: [{ id: "pay", amount: "2000", frequency: "biweekly", active: true }],
    cashBuffer: "500",
    reservesHeld: 0,
    weekCap: "700",
    weekRows: [],
    freshness: { stale: false, staleReason: null, asOfBank: "2026-10-07T13:00:00.000Z" },
    status: "ready",
    ...over,
  };
}

const rows = (...r: Array<[MovementCoverage, number]>): PositionWeekRow[] =>
  r.map(([coverage, spend]) => ({ coverage, spend }));

describe("payday — the window's end", () => {
  it("is the earliest paycheck on the curve after today", () => {
    const p = computePosition(inputs({ events: [paycheck("2026-10-16"), paycheck("2026-10-09")] }));
    expect(p.paydayDate).toBe("2026-10-09");
    // Today THROUGH payday (Round 2): payday's own day is counted, before its paycheck.
    expect(p.horizon).toEqual({ kind: "payday", endDate: "2026-10-09", lastDay: "2026-10-09" });
    expect(p.payday).toEqual({ itemId: "pay", label: "Paycheck", amount: "2000.00" });
  });

  it("a paycheck dated today is not payday (it is already in the bank or not coming today)", () => {
    const p = computePosition(inputs({ events: [paycheck(TODAY), paycheck("2026-10-21")] }));
    expect(p.paydayDate).toBe("2026-10-21");
  });

  it("the 25% rule: a small deposit plan never ends the window early", () => {
    const events = [
      paycheck("2026-10-08", 499.99, { itemId: "refund", label: "Reimbursement" }),
      paycheck("2026-10-12", 2000),
    ];
    expect(computePosition(inputs({ events })).paydayDate).toBe("2026-10-12");
    // Exactly 25% of the largest active income plan counts.
    events[0] = paycheck("2026-10-08", 500, { itemId: "refund", label: "Reimbursement" });
    expect(computePosition(inputs({ events })).paydayDate).toBe("2026-10-08");
  });

  it("the 25% rule reads the largest ACTIVE income plan only", () => {
    const events = [paycheck("2026-10-08", 600, { itemId: "side" }), paycheck("2026-10-12", 2000)];
    const incomeItems = [
      { id: "pay", amount: "2000", frequency: "biweekly", active: true },
      { id: "old", amount: "7000", frequency: "monthly", active: false },
    ];
    // Inactive $7,000: the threshold is 25% of $2,000 = $500, so the $600 deposit is payday.
    expect(computePosition(inputs({ events, incomeItems })).paydayDate).toBe("2026-10-08");
    // Active $7,000: the threshold is $1,750; $600 is not payday, $2,000 is.
    incomeItems[1]!.active = true;
    expect(computePosition(inputs({ events, incomeItems })).paydayDate).toBe("2026-10-12");
  });

  it("outflows and real deposits are never payday", () => {
    const events: PositionEvent[] = [
      bill("2026-10-08", 50),
      { date: "2026-10-09", amount: 3000, kind: "actual", itemId: "txn-1", label: "DEPOSIT" },
      paycheck("2026-10-14"),
    ];
    expect(computePosition(inputs({ events })).paydayDate).toBe("2026-10-14");
  });

  it(`no paycheck within ${PAYDAY_MAX_DAYS} days: the window runs through this week's Saturday`, () => {
    const at45 = addDaysISO(TODAY, PAYDAY_MAX_DAYS);
    const at46 = addDaysISO(TODAY, PAYDAY_MAX_DAYS + 1);
    expect(computePosition(inputs({ events: [paycheck(at45)] })).paydayDate).toBe(at45);
    const p = computePosition(inputs({ events: [paycheck(at46)] }));
    expect(p.paydayDate).toBeNull();
    expect(p.payday).toBeNull();
    expect(p.horizon).toEqual({ kind: "week_end", endDate: "2026-10-10", lastDay: "2026-10-10" });
    expect(p.assumptions).toContain(POSITION_ASSUMPTIONS.noPayday);
    // Through Saturday inclusive: 10/7 2000 · 10/8 1900 · 10/9 3900 · 10/10 3800.
    expect(p.lowestUntilPayday).toBe("1900.00");
  });

  it("selectPayday ignores a non-positive income event", () => {
    expect(selectPayday(TODAY, [paycheck("2026-10-08", 0)], [{ id: "pay", amount: 2000, frequency: "monthly", active: true }])).toBeNull();
  });
});

describe("lowest before payday and what is available", () => {
  it("is the lowest end-of-day balance from today through payday; days after payday are outside it", () => {
    // payday 10/12 (+2,000 that day, so 10/12 reads 3,210 − 2,000 = 1,210); the 10/13 dip is after it.
    const daily = curve(TODAY, [1500, 1200, 1300, 1250, 1210, 3210, 900]);
    const p = computePosition(inputs({ daily, events: [paycheck("2026-10-12")] }));
    expect(p.lowestUntilPayday).toBe("1200.00");
    expect(p.lowestUntilPaydayDate).toBe("2026-10-08");
    expect(p.availableUntilPayday).toBe("700.00"); // 1200 − 500 buffer
  });

  describe("⭐ (Round 2) on payday the bills count before the paycheck", () => {
    // Payday Fri 10/9, +2,000. Wed 10/7 1,000.
    it("a bill that lands ON payday counts: payday reads its balance less the paycheck", () => {
      // 10/8 1,000 · 10/9 1,000 + 2,000 − 300 = 2,700 → before the paycheck 700.
      const daily = curve(TODAY, [1000, 1000, 2700, 2700]);
      const p = computePosition(inputs({ daily, events: [paycheck("2026-10-09"), bill("2026-10-09", 300)] }));
      expect(p.lowestUntilPayday).toBe("700.00");
      expect(p.lowestUntilPaydayDate).toBe("2026-10-09");
      expect(p.availableUntilPayday).toBe("200.00");
      expect(p.committedUntilPayday).toBe("300.00");
      expect(p.assumptions).toContain(POSITION_ASSUMPTIONS.paydayBillsFirst);
    });

    it("a bill the day before payday: that day is the low, and payday (bills, no paycheck) ties it", () => {
      // 10/8 1,000 − 300 = 700 · 10/9 700 + 2,000 = 2,700 → before the paycheck 700 (a tie: the first day stands).
      const daily = curve(TODAY, [1000, 700, 2700, 2700]);
      const p = computePosition(inputs({ daily, events: [bill("2026-10-08", 300), paycheck("2026-10-09")] }));
      expect(p.lowestUntilPayday).toBe("700.00");
      expect(p.lowestUntilPaydayDate).toBe("2026-10-08");
      expect(p.committedUntilPayday).toBe("300.00");
    });

    it("nothing else on payday: payday reads the day before's balance, and nothing moves", () => {
      const daily = curve(TODAY, [1000, 950, 2950, 2950]);
      const p = computePosition(inputs({ daily, events: [bill("2026-10-08", 50), paycheck("2026-10-09")] }));
      expect(p.lowestUntilPayday).toBe("950.00");
      expect(p.lowestUntilPaydayDate).toBe("2026-10-08");
      expect(p.availableUntilPayday).toBe("450.00");
      expect(p.committedUntilPayday).toBe("50.00");
    });

    it("every deposit plan dated payday is held back, not only the paycheck", () => {
      // 10/9: +2,000 paycheck, +150 reimbursement, −300 bill → 1,000 + 1,850 = 2,850; before both deposits 700.
      const daily = curve(TODAY, [1000, 1000, 2850]);
      const events = [paycheck("2026-10-09"), paycheck("2026-10-09", 150, { itemId: "refund" }), bill("2026-10-09", 300)];
      expect(computePosition(inputs({ daily, events })).lowestUntilPayday).toBe("700.00");
    });
  });

  it("today counts: a curve already at its lowest today reads today", () => {
    const daily = curve(TODAY, [800, 900, 2900]);
    const p = computePosition(inputs({ daily, events: [paycheck("2026-10-09")] }));
    expect(p.lowestUntilPaydayDate).toBe(TODAY);
    expect(p.availableUntilPayday).toBe("300.00");
  });

  it("a tie reads the first day the low is reached", () => {
    const daily = curve(TODAY, [1000, 700, 900, 700, 5000]);
    const p = computePosition(inputs({ daily, events: [paycheck("2026-10-11")] }));
    expect(p.lowestUntilPaydayDate).toBe("2026-10-08");
  });

  it("subtracts the buffer AND the reserves, and never goes below zero", () => {
    const daily = curve(TODAY, [1000, 1000, 5000]);
    const events = [paycheck("2026-10-09")];
    expect(computePosition(inputs({ daily, events, reservesHeld: "125.50" })).availableUntilPayday).toBe("374.50");
    expect(computePosition(inputs({ daily, events, cashBuffer: 1200 })).availableUntilPayday).toBe("0.00");
  });

  it("is null — never a false zero — with no bank data or no curve", () => {
    expect(computePosition(inputs({ status: "no_data" })).availableUntilPayday).toBeNull();
    expect(computePosition(inputs({ status: "no_data" })).safeToSpendNow).toBeNull();
    const empty = computePosition(inputs({ daily: [] }));
    expect(empty.availableUntilPayday).toBeNull();
    expect(empty.lowestUntilPayday).toBeNull();
    expect(empty.safeToSpendNow).toBeNull();
    // A curve that does not reach today (a stale window) has nothing to say either.
    expect(computePosition(inputs({ daily: curve("2026-09-01", [9000]) })).availableUntilPayday).toBeNull();
  });

  it("committedUntilPayday sums the planned outflows in the window only", () => {
    const events = [
      bill(TODAY, 40), // dated today by the ledger (no snapshot): still owed
      bill("2026-10-08", 100.1),
      { date: "2026-10-08", amount: -77, kind: "actual" as const, itemId: "t", label: "row" },
      paycheck("2026-10-09"),
      bill("2026-10-09", 999), // payday's own day: inside (Round 2)
      bill("2026-10-10", 5), // after payday: outside
    ];
    expect(computePosition(inputs({ events })).committedUntilPayday).toBe("1139.10");
  });
});

describe("the week — what counts against the cap", () => {
  it("weekly-allowance spend and UNFILED spend count; unplanned and monthly sit beside it", () => {
    const p = computePosition(
      inputs({
        weekRows: rows(
          ["allowance_weekly", 96.6],
          ["needs_classification", 45],
          ["unplanned", 85],
          ["allowance_monthly", 30],
          ["bill_matched", 140],
          ["card_payment", 150],
          ["transfer", 200],
          ["debt_payment", 60],
          ["reimbursable", 25],
          ["income", 0],
          ["excluded", 12],
        ),
      }),
    );
    expect(p.spentWeekDiscretionary).toBe("141.60");
    expect(p.needsClassificationWeek).toBe("45.00");
    expect(p.unplannedWeek).toBe("85.00");
    expect(p.monthlyWeek).toBe("30.00");
    expect(p.remainingWeek).toBe("558.40");
    expect(p.assumptions).toContain(POSITION_ASSUMPTIONS.unfiledCounts);
  });

  it("no cap: no remaining, no pace, no verdict — and the cash figure alone is safe to spend", () => {
    const p = computePosition(inputs({ weekCap: null, weekRows: rows(["needs_classification", 10]) }));
    expect(p.weekCap).toBeNull();
    expect(p.remainingWeek).toBeNull();
    expect(p.paceAllowedToday).toBeNull();
    expect(p.withinPlan).toBeNull();
    expect(p.safeToSpendNow).toBe(p.availableUntilPayday);
    expect(p.assumptions).not.toContain(POSITION_ASSUMPTIONS.unfiledCounts);
  });

  it("pace: an even share of the cap through the end of today", () => {
    expect(computePosition(inputs({ todayISO: "2026-10-04", daily: curve("2026-10-04", [2000]) })).paceAllowedToday).toBe("100.00");
    expect(computePosition(inputs()).paceAllowedToday).toBe("400.00"); // Wed: 4 of 7 days
    expect(computePosition(inputs({ todayISO: "2026-10-10", daily: curve("2026-10-10", [2000]) })).paceAllowedToday).toBe("700.00");
    expect(computePosition(inputs({ weekCap: 100 })).paceAllowedToday).toBe("57.14"); // 400/7
  });

  it("tight and over — the boundaries, to the cent (Wednesday, cap $700 = $100 a day, 4 days left)", () => {
    const at = (spent: number) => computePosition(inputs({ weekRows: rows(["allowance_weekly", spent]) })).withinPlan;
    expect(at(300)).toBe("yes"); // $400 left = exactly $100 × 4 days
    expect(at(300.01)).toBe("tight");
    expect(at(700)).toBe("tight"); // nothing left is not over
    expect(at(700.01)).toBe("over");
  });

  it("Saturday: one day left — tight only under a seventh of the cap", () => {
    const sat = (spent: number) =>
      computePosition(
        inputs({ todayISO: "2026-10-10", daily: curve("2026-10-10", [2000]), weekRows: rows(["allowance_weekly", spent]) }),
      ).withinPlan;
    expect(sat(600)).toBe("yes");
    expect(sat(600.01)).toBe("tight");
  });

  it("the week runs Sunday to Saturday on the household calendar", () => {
    const p = computePosition(inputs());
    expect([p.weekStart, p.weekEnd]).toEqual(["2026-10-04", "2026-10-10"]);
  });
});

describe("safe to spend now = the smaller ceiling", () => {
  it("the week's remaining when it is smaller", () => {
    const p = computePosition(inputs({ weekRows: rows(["allowance_weekly", 650]) }));
    expect(p.availableUntilPayday).toBe("1400.00"); // 1900 − 500
    expect(p.remainingWeek).toBe("50.00");
    expect(p.safeToSpendNow).toBe("50.00");
  });

  it("the cash until payday when it is smaller", () => {
    const daily = curve(TODAY, [700, 650, 3000]);
    const p = computePosition(inputs({ daily }));
    expect(p.availableUntilPayday).toBe("150.00");
    expect(p.safeToSpendNow).toBe("150.00");
  });

  it("zero, not negative, when the week is over", () => {
    const p = computePosition(inputs({ weekRows: rows(["allowance_weekly", 750]) }));
    expect(p.remainingWeek).toBe("-50.00");
    expect(p.withinPlan).toBe("over");
    expect(p.safeToSpendNow).toBe("0.00");
  });
});

describe("confidence, assumptions, freshness", () => {
  it("an estimated plan inside the window makes the answer estimated and names it", () => {
    const events = [
      bill("2026-10-08", 140, { itemId: "electric", label: "Electric", amountKind: "estimate" }),
      paycheck("2026-10-09"),
      bill("2026-10-20", 60, { itemId: "water", label: "Water", amountKind: "estimate" }), // after payday
    ];
    const p = computePosition(inputs({ events }));
    expect(p.confidence).toBe("estimated");
    expect(p.estimates).toEqual([{ itemId: "electric", label: "Electric", amount: "-140.00", date: "2026-10-08" }]);
  });

  it("fixed plans, and estimates outside the window, leave it firm", () => {
    const events = [bill("2026-10-08", 140), paycheck("2026-10-09"), bill("2026-10-20", 60, { amountKind: "estimate" })];
    const p = computePosition(inputs({ events }));
    expect(p.confidence).toBe("firm");
    expect(p.estimates).toEqual([]);
  });

  it("an estimated paycheck that ends the window is not inside it", () => {
    const p = computePosition(inputs({ events: [paycheck("2026-10-09", 2000, { amountKind: "estimate" })] }));
    expect(p.confidence).toBe("firm");
  });

  it("assumptions: the ledger's own tags once each, then the fixed wording", () => {
    const events = [
      bill("2026-10-08", 10, { assumption: "overdue_assumed_unpaid" }),
      bill("2026-10-08", 20, { assumption: "overdue_assumed_unpaid" }),
      bill("2026-10-08", 30, { assumption: "due_today_not_posted" }),
      paycheck("2026-10-09"),
      bill("2026-10-12", 40, { assumption: "remainder_assumed_unpaid" }), // outside the window
    ];
    const p = computePosition(inputs({ events }));
    expect(p.assumptions).toEqual([
      "overdue_assumed_unpaid",
      "due_today_not_posted",
      POSITION_ASSUMPTIONS.noCredit,
      POSITION_ASSUMPTIONS.bankFrom("2026-10-07"),
      POSITION_ASSUMPTIONS.paydayBillsFirst,
    ]);
    expect(computePosition(inputs({ freshness: { stale: false, staleReason: null, asOfBank: null } })).assumptions).toContain(
      POSITION_ASSUMPTIONS.noBank,
    );
  });

  it("stale bank data: degraded, with the reason — and every figure still computed", () => {
    const fresh = computePosition(inputs());
    const stale = computePosition(inputs({ freshness: { stale: true, staleReason: "refresh_failed", asOfBank: "2026-10-07T13:00:00.000Z" } }));
    expect(stale.degraded).toBe(true);
    expect(stale.degradedReason).toBe("refresh_failed");
    expect(fresh.degraded).toBe(false);
    expect(fresh.degradedReason).toBeNull();
    const { degraded: _a, degradedReason: _b, ...freshFigures } = fresh;
    const { degraded: _c, degradedReason: _d, ...staleFigures } = stale;
    expect(staleFigures).toEqual(freshFigures);
  });
});

describe("(Round 2, Q6 → PR-B2) a reimbursable charge flagged weekly — the owner's rule", () => {
  // The owner's 2026-09-15 rule: a reimbursable charge is excluded regardless of
  // flags. PR-H's step order let the weekly flag outrank `reimbursable`, so this
  // row read `allowance_weekly` and counted $35.00 against the cap (remaining
  // 665.00). ⭐ PR-B2 moved `reimbursable` ahead of the flags inside
  // `classifyMovement`: the row leaves the sum (remaining 700.00) — the flip this
  // pin was written to force.
  it("(PR-B2) no longer counts against the weekly cap", () => {
    const row: MovementRow = {
      id: "r1",
      occurredOn: "2026-10-06",
      description: "OFFICE DEPOT",
      amount: "-35.00",
      categoryId: null,
      isTransfer: false,
      source: "plaid:amex",
      reimbursable: true,
      debtId: null,
      isExternalCardPayment: false,
      pfcDetailed: null,
      plaidAccountId: "acct-amex",
      unplannedAllowance: false,
      monthlyAllowance: false,
      weeklyAllowance: true,
    };
    const ctx: MovementContext = {
      categoriesById: new Map(),
      debtCategoryIds: new Set(),
      checkingAccountExternalId: "acct-chase",
      matchedTxnIds: new Set(),
    };
    const coverage = classifyMovement(row, ctx).coverage;
    expect(coverage).toBe("reimbursable");
    const p = computePosition(inputs({ weekRows: [{ coverage, spend: spendAmount(row) }] }));
    expect(p.spentWeekDiscretionary).toBe("0.00");
    expect(p.remainingWeek).toBe("700.00");
  });
});

describe("⚠️ the credit / debt law", () => {
  /** Every key anywhere in the object. */
  function keysOf(v: unknown, out: string[] = []): string[] {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        keysOf(x, out);
      }
    }
    return out;
  }

  it("never names credit or a limit, and never carries a debt balance or an amount owed", () => {
    const shapes = [
      computePosition(inputs()),
      computePosition(inputs({ weekCap: null, status: "no_data", daily: [] })),
      computePosition(
        inputs({
          events: [bill("2026-10-08", 140, { amountKind: "estimate", assumption: "overdue_assumed_unpaid" })],
          freshness: { stale: true, staleReason: "old", asOfBank: null },
          weekRows: rows(["needs_classification", 900]),
        }),
      ),
    ];
    for (const p of shapes) {
      const keys = keysOf(p);
      expect(keys.length).toBeGreaterThan(25);
      for (const k of keys) {
        expect(k, k).not.toMatch(/credit|limit(?!s)/i);
        // "owed" anywhere but inside "allowed" (paceAllowedToday is the cap's pace, not a debt).
        expect(k, k).not.toMatch(/debt|(?<!all)owed|balance/i);
      }
    }
  });
});

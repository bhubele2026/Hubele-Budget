// (S3) Pure unit tests: `classifyMovement`'s `rule` (with `explain`) and the
// period breakdown's grouping (`periodBreakdown`, avalanche-core). No DB.
//
//   1. `rule` says which step placed each row, and asking for it changes no
//      other field (6,000 seeded rows, the same shapes the precedence property
//      test uses).
//   2. The breakdown: Σ groups + refund floor = actual, to the cent, on seeded
//      windows; the figure is `computePosition`'s `spentWeekDiscretionary` and
//      its `remainingWeek` on the same rows; split parts sum to the parent and
//      the parent is never counted again; a refund nets its category; not set
//      is never $0; the usual week is the ways-back median.

import { describe, expect, it } from "vitest";
import {
  BREAKDOWN_ROWS_MAX,
  MOVEMENT_RULES,
  PFC_CARD_PAYMENT,
  allowanceRowOf,
  classifyMovement,
  computePosition,
  isPeriodStart,
  periodBreakdown,
  priorPeriodStarts,
  type BreakdownRowInput,
  type MovementContext,
  type MovementRow,
  type PositionInputs,
} from "@workspace/avalanche-core";

const CHECKING = "chase-ext";
const AMEX = "amex-ext";

function ctx(overrides: Partial<MovementContext> = {}): MovementContext {
  return {
    categoriesById: new Map([
      ["cat-food", { name: "Groceries", debtId: null, kind: "expense" }],
      ["cat-gas", { name: "Gas", debtId: null, kind: "expense" }],
      ["cat-home", { name: "Home", debtId: null, kind: "expense" }],
      ["cat-debt", { name: "Card Payoff", debtId: "debt-1", kind: "expense" }],
      ["cat-ignore", { name: "Ignore", debtId: null, kind: "expense" }],
      ["cat-income", { name: "Paycheck", debtId: null, kind: "income" }],
    ]),
    debtCategoryIds: new Set(["cat-debt"]),
    checkingAccountExternalId: CHECKING,
    matchedTxnIds: new Set(),
    cardAccountIds: new Set(),
    ...overrides,
  };
}

function row(overrides: Partial<MovementRow> = {}): MovementRow {
  return {
    id: "t1",
    occurredOn: "2026-10-06",
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

describe("classifyMovement — (S3) the rule that placed each row", () => {
  const cases: Array<[string, MovementRow, Partial<MovementContext>, string, string]> = [
    ["a transfer", row({ isTransfer: true }), {}, "transfer", "transfer"],
    ["bank noise", row({ description: "ONLINE TRANSFER TO CHK 1234" }), {}, "transfer", "bank_noise"],
    ["a tagged debt payment", row({ debtId: "debt-9", weeklyAllowance: true }), {}, "debt_payment", "debt_payment"],
    [
      "the checking-side Amex payment",
      row({ description: "AMERICAN EXPRESS ACH PMT", pfcDetailed: PFC_CARD_PAYMENT }),
      {},
      "card_payment",
      "card_payment",
    ],
    ["an excluded category", row({ categoryId: "cat-ignore" }), {}, "excluded", "excluded_category"],
    ["an outflow filed to an income category", row({ categoryId: "cat-income" }), {}, "income", "income_category"],
    ["real income", row({ amount: "2000.00", categoryId: "cat-income" }), {}, "income", "income"],
    ["a deposit that is neither", row({ amount: "50.00", description: "DEPOSIT" }), {}, "excluded", "inflow_other"],
    ["a confirmed bill match", row({ weeklyAllowance: true }), { matchedTxnIds: new Set(["t1"]) }, "bill_matched", "bill_match_confirmed"],
    ["a tier-2 pair (no flag)", row(), { tier2PairedTxnIds: new Set(["t1"]) }, "bill_matched", "bill_match_tier2"],
    ["reimbursable (ahead of a flag)", row({ reimbursable: true, weeklyAllowance: true }), {}, "reimbursable", "reimbursable"],
    ["unplanned", row({ unplannedAllowance: true, weeklyAllowance: true }), {}, "unplanned", "unplanned_flag"],
    ["monthly", row({ monthlyAllowance: true }), {}, "allowance_monthly", "monthly_flag"],
    ["weekly", row({ weeklyAllowance: true }), {}, "allowance_weekly", "weekly_flag"],
    ["an Amex purchase, unfiled", row({ source: "plaid:amex", plaidAccountId: AMEX }), {}, "needs_classification", "unfiled"],
    [
      "an Amex refund on a weekly row (nets the week)",
      row({ source: "plaid:amex", plaidAccountId: AMEX, amount: "12.00", description: "HEB REFUND", weeklyAllowance: true }),
      {},
      "refund",
      "weekly_flag",
    ],
  ];

  for (const [name, r, c, coverage, rule] of cases) {
    it(`${name}: ${coverage} by ${rule}`, () => {
      const m = classifyMovement(r, ctx(c), { explain: true });
      expect(m.coverage).toBe(coverage);
      expect(m.rule).toBe(rule);
      expect(MOVEMENT_RULES).toContain(m.rule);
      expect(m.outflowRule).toEqual(expect.any(String));
    });
  }

  it("without `explain` the answer carries no rule — byte-for-byte what it always was", () => {
    const m = classifyMovement(row({ weeklyAllowance: true }), ctx());
    expect(m).toEqual({ coverage: "allowance_weekly", timing: { kind: "checking", date: "2026-10-06" } });
    expect("rule" in m).toBe(false);
  });

  it("asking for the rule changes no other field (6,000 seeded rows)", () => {
    let seed = 20261014;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const accounts = [
      { source: "plaid:chase", plaidAccountId: CHECKING },
      { source: "plaid:amex", plaidAccountId: AMEX },
      { source: "amex", plaidAccountId: null },
      { source: "manual", plaidAccountId: null },
    ];
    const rules = new Set<string>();
    for (let i = 0; i < 6000; i += 1) {
      const a = pick(accounts);
      const mag = Math.round(1 + rnd() * 9999) / 100;
      const sign = rnd() < 0.2 ? 1 : -1;
      const r = row({
        id: `r${i}`,
        source: a.source,
        plaidAccountId: a.plaidAccountId,
        amount: a.source === "amex" ? -sign * mag : sign * mag,
        categoryId: pick([null, "cat-food", "cat-debt", "cat-ignore", "cat-income"]),
        description: pick(["HEB", "ONLINE TRANSFER TO CHK", "AMEX EPAYMENT", "SHELL", "REFUND HEB"]),
        isTransfer: rnd() < 0.05,
        reimbursable: rnd() < 0.2,
        unplannedAllowance: rnd() < 0.25,
        monthlyAllowance: rnd() < 0.25,
        weeklyAllowance: rnd() < 0.35,
      });
      const c = ctx({
        matchedTxnIds: rnd() < 0.15 ? new Set([r.id]) : new Set(),
        tier2PairedTxnIds: rnd() < 0.2 ? new Set([r.id]) : undefined,
      });
      const plain = classifyMovement(r, c);
      const said = classifyMovement(r, c, { explain: true });
      const { rule, outflowRule, ...rest } = said;
      expect(rest, `row ${i}`).toEqual(plain);
      expect(MOVEMENT_RULES).toContain(rule);
      expect(outflowRule).toEqual(expect.any(String));
      rules.add(rule!);
      // The allowance row is the same either way.
      expect(allowanceRowOf(r, said)).toEqual(allowanceRowOf(r, plain));
    }
    expect(rules.size).toBeGreaterThanOrEqual(12);
  });
});

// ── The breakdown ───────────────────────────────────────────────────────────

const NAMES = new Map([
  ["cat-food", "Groceries"],
  ["cat-gas", "Gas"],
  ["cat-home", "Home"],
]);

function input(
  r: MovementRow,
  c: MovementContext = ctx(),
  splitParts: BreakdownRowInput<null>["splitParts"] = null,
): BreakdownRowInput<string> {
  const m = classifyMovement(r, c, { explain: true });
  return { id: r.id, date: r.occurredOn, allowance: allowanceRowOf(r, m), categoryId: r.categoryId, splitParts, item: r.id };
}

const empty = { starts: [] as string[], rows: [] };

/** Σ categories + needsClassification + floor, in cents. */
const groupsPlusFloor = (b: ReturnType<typeof periodBreakdown>): number =>
  b.categories.reduce((a, c) => a + c.cents, 0) + b.needsClassification.cents + b.refundFloorAdjustmentCents;

describe("periodBreakdown — the week", () => {
  it("groups the cap's pool by category, unfiled apart, largest first; plan, remaining, over", () => {
    const rows = [
      input(row({ id: "a", amount: "-96.60", categoryId: "cat-food", weeklyAllowance: true, source: "plaid:amex", plaidAccountId: AMEX })),
      input(row({ id: "b", amount: "-45.00", categoryId: "cat-gas", weeklyAllowance: true })),
      input(row({ id: "c", amount: "-120.00", categoryId: "cat-food", weeklyAllowance: true, occurredOn: "2026-10-05" })),
      input(row({ id: "d", amount: "-25.50", categoryId: "cat-home" })), // unfiled: counts
      input(row({ id: "e", amount: "-85.00", unplannedAllowance: true })), // beside
      input(row({ id: "f", amount: "-30.00", monthlyAllowance: true })), // beside
      input(row({ id: "g", amount: "-200.00", isTransfer: true })), // never
    ];
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect(b.basis).toBe("weekly_allowance");
    expect(b.actualCents).toBe(9660 + 4500 + 12000 + 2550);
    expect(b.categories.map((c) => [c.name, c.cents, c.count])).toEqual([
      ["Groceries", 21660, 2],
      ["Gas", 4500, 1],
    ]);
    expect(b.categories[0]!.rows.map((e) => e.id)).toEqual(["c", "a"]); // by amount, never "the last purchase"
    expect(b.needsClassification).toMatchObject({ cents: 2550, count: 1, countsAgainstPlan: true });
    expect(b.needsClassification.rows[0]!.categoryId).toBe("cat-home"); // its category, as an attribute
    expect(b.refundFloorAdjustmentCents).toBe(0);
    expect(groupsPlusFloor(b)).toBe(b.actualCents);
    expect(b.remainingCents).toBe(30000 - 28710);
    expect(b.overCents).toBe(0);
    expect(b.withinPlan).toBe(true);
    expect(b.beside).toEqual({ unplannedCents: 8500, weeklyCents: null, monthlyCents: 3000, billMatchedCents: 0, reimbursableCents: 0 });
    expect(b.categories[0]!.shareBp).toBe(Math.round((21660 * 10000) / 28710));
  });

  it("a carry-over lowers what is left; over is how far past it", () => {
    const rows = [input(row({ id: "a", amount: "-280.00", categoryId: "cat-food", weeklyAllowance: true }))];
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: -4000, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect(b.remainingCents).toBe(-2000);
    expect(b.overCents).toBe(2000);
    expect(b.withinPlan).toBe(false);
    expect(b.carryOverCents).toBe(-4000);
  });

  it("not set is never $0: no plan → remaining, over and within are null; an empty week with a plan reads 0", () => {
    const none = periodBreakdown({ period: "week", rows: [input(row({ weeklyAllowance: true }))], planCents: null, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect([none.planCents, none.remainingCents, none.overCents, none.withinPlan]).toEqual([null, null, null, null]);
    expect(none.actualCents).toBe(4200);
    const quiet = periodBreakdown({ period: "week", rows: [], planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect(quiet).toMatchObject({ actualCents: 0, remainingCents: 30000, overCents: 0, withinPlan: true, categories: [], refundFloorAdjustmentCents: 0 });
    expect(quiet.needsClassification).toMatchObject({ cents: 0, count: 0, rows: [] });
  });

  it("a refund nets its own category (signed), and a pool that refunds below zero floors — the floor is said", () => {
    const amex = { source: "plaid:amex", plaidAccountId: AMEX };
    const rows = [
      input(row({ id: "buy", amount: "-50.00", categoryId: "cat-food", weeklyAllowance: true, ...amex })),
      input(row({ id: "ret", amount: "80.00", categoryId: "cat-food", weeklyAllowance: true, description: "HEB REFUND", ...amex })),
      input(row({ id: "gas", amount: "-30.00", categoryId: "cat-gas", weeklyAllowance: true })), // checking: its own account
    ];
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    // Amex pool: 50 − 80 = −30 → floors at 0; checking: 30. actual = 30.
    expect(b.actualCents).toBe(3000);
    const food = b.categories.find((c) => c.categoryId === "cat-food")!;
    expect(food.cents).toBe(-3000);
    expect(food.rows.map((e) => [e.id, e.cents])).toEqual([["buy", 5000], ["ret", -8000]]);
    expect(b.refundFloorAdjustmentCents).toBe(3000);
    expect(groupsPlusFloor(b)).toBe(b.actualCents);
  });

  it("a split row counts by its parts: they keep the parent's account and coverage and sum to it; the parent never counts again", () => {
    const parent = row({ id: "split", amount: "-100.00", categoryId: "cat-food", weeklyAllowance: true, source: "plaid:amex", plaidAccountId: AMEX });
    const rows = [
      input(parent, ctx(), [
        { categoryId: "cat-food", amount: "-70.00" },
        { categoryId: "cat-home", amount: "-30.00" },
      ]),
    ];
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect(b.actualCents).toBe(10000);
    expect(b.categories.map((c) => [c.categoryId, c.cents, c.count])).toEqual([
      ["cat-food", 7000, 1],
      ["cat-home", 3000, 1],
    ]);
    const parts = b.categories.flatMap((c) => c.rows);
    expect(parts.every((e) => e.id === "split" && e.account === AMEX)).toBe(true);
    expect(parts.map((e) => e.splitPart)).toEqual([
      { index: 0, count: 2, parentCents: 10000 },
      { index: 1, count: 2, parentCents: 10000 },
    ]);
    expect(groupsPlusFloor(b)).toBe(b.actualCents);
    // Parts that do not add up: the row counts whole, under its own category.
    const off = periodBreakdown({
      period: "week",
      rows: [input(parent, ctx(), [{ categoryId: "cat-home", amount: "-10.00" }])],
      planCents: 30000,
      carryOverCents: null,
      history: empty,
      categoryNames: NAMES,
      rowsPerGroup: 10,
    });
    expect(off.categories.map((c) => [c.categoryId, c.cents])).toEqual([["cat-food", 10000]]);
  });

  it("rows per group are capped and say so; the group total still counts every row", () => {
    const rows = Array.from({ length: 13 }, (_, i) =>
      input(row({ id: `r${String(i).padStart(2, "0")}`, amount: `-${i + 1}.00`, categoryId: "cat-food", weeklyAllowance: true })),
    );
    const b = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 5 });
    expect(b.categories[0]).toMatchObject({ cents: 9100, count: 13, truncated: true });
    expect(b.categories[0]!.rows.map((e) => e.cents)).toEqual([1300, 1200, 1100, 1000, 900]);
    const all = periodBreakdown({ period: "week", rows, planCents: 30000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 999 });
    expect(all.categories[0]!.rows.length).toBe(13);
    expect(BREAKDOWN_ROWS_MAX).toBe(50);
  });

  it("usual = the ways-back median of the prior weeks (a week with none is 0); above usual = max(0, amount − usual)", () => {
    const starts = priorPeriodStarts("week", "2026-10-04", "2026-05-01");
    expect(starts).toEqual(["2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27"]);
    const hist = [
      ["2026-09-27", "-40.00"],
      ["2026-09-20", "-60.00"],
      ["2026-09-13", "-50.00"],
      ["2026-09-07", "-10.00"],
      ["2026-09-08", "-20.00"], // same week as 9/7: 30 that week
    ].map(([d, a], i) => ({
      ...input(row({ id: `h${i}`, occurredOn: d!, amount: a!, categoryId: "cat-food", weeklyAllowance: true })),
      periodStart: priorWeekOf(d!),
    }));
    const b = periodBreakdown({
      period: "week",
      rows: [input(row({ id: "now", amount: "-90.00", categoryId: "cat-food", weeklyAllowance: true }))],
      planCents: 30000,
      carryOverCents: null,
      history: { starts, rows: hist },
      categoryNames: NAMES,
      rowsPerGroup: 10,
    });
    // Weeks: 0,0,0,0,30,50,60,40 → sorted 0,0,0,0,30,40,50,60 → median floor((0+30)/2) = 15.
    expect(b.categories[0]!.usualCents).toBe(1500);
    expect(b.categories[0]!.aboveUsualCents).toBe(7500);
    // No prior week tracked: null, never 0.
    const fresh = periodBreakdown({
      period: "week",
      rows: [input(row({ id: "now", amount: "-90.00", categoryId: "cat-food", weeklyAllowance: true }))],
      planCents: 30000,
      carryOverCents: null,
      history: { starts: priorPeriodStarts("week", "2026-05-03", "2026-05-01"), rows: [] },
      categoryNames: NAMES,
      rowsPerGroup: 10,
    });
    expect(fresh.categories[0]).toMatchObject({ usualCents: null, aboveUsualCents: null });
  });

  it("⭐ on seeded weeks the figure IS computePosition's: spent, remaining and over, to the cent; Σ groups + floor = actual", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let w = 0; w < 300; w += 1) {
      const rows: BreakdownRowInput<string>[] = [];
      const n = Math.floor(rnd() * 14);
      for (let i = 0; i < n; i += 1) {
        const onAmex = rnd() < 0.5;
        const refund = rnd() < 0.25;
        const mag = Math.round(1 + rnd() * 15000) / 100;
        const r = row({
          id: `w${w}r${i}`,
          occurredOn: `2026-10-0${4 + Math.floor(rnd() * 6)}`,
          source: onAmex ? "plaid:amex" : "plaid:chase",
          plaidAccountId: onAmex ? AMEX : CHECKING,
          amount: refund ? mag : -mag,
          description: refund ? "STORE REFUND" : "STORE",
          categoryId: [null, "cat-food", "cat-gas", "cat-home"][Math.floor(rnd() * 4)]!,
          weeklyAllowance: rnd() < 0.5,
          monthlyAllowance: rnd() < 0.15,
          unplannedAllowance: rnd() < 0.1,
        });
        const parts =
          !refund && rnd() < 0.2
            ? [
                { categoryId: "cat-food", amount: (-Math.floor(mag * 50) / 100).toFixed(2) },
                { categoryId: "cat-home", amount: (-(mag - Math.floor(mag * 50) / 100)).toFixed(2) },
              ]
            : null;
        rows.push(input(r, ctx(), parts));
      }
      const cap = rnd() < 0.2 ? null : Math.round(rnd() * 50000);
      const adj = rnd() < 0.3 ? -Math.round(rnd() * 5000) : null;
      const b = periodBreakdown({ period: "week", rows, planCents: cap, carryOverCents: adj, history: empty, categoryNames: NAMES, rowsPerGroup: 50 });
      const pos = computePosition(positionInputs(rows, cap, adj));
      expect(b.actualCents, `week ${w}`).toBe(Math.round(Number(pos.spentWeekDiscretionary) * 100));
      expect(b.remainingCents == null ? null : (b.remainingCents / 100).toFixed(2), `week ${w}`).toBe(pos.remainingWeek);
      expect(b.withinPlan === false, `week ${w}`).toBe(pos.withinPlan === "over");
      expect(groupsPlusFloor(b), `week ${w}`).toBe(b.actualCents);
      expect(b.refundFloorAdjustmentCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("periodBreakdown — the month", () => {
  it("counts monthly-flagged rows only; unfiled rows do not count against the monthly plan", () => {
    const rows = [
      input(row({ id: "m1", amount: "-30.00", categoryId: "cat-home", monthlyAllowance: true })),
      input(row({ id: "m2", amount: "-120.00", categoryId: "cat-home", monthlyAllowance: true, occurredOn: "2026-10-20" })),
      input(row({ id: "w", amount: "-40.00", categoryId: "cat-food", weeklyAllowance: true })),
      input(row({ id: "u", amount: "-25.00" })),
    ];
    const b = periodBreakdown({ period: "month", rows, planCents: 10000, carryOverCents: null, history: empty, categoryNames: NAMES, rowsPerGroup: 10 });
    expect(b.basis).toBe("monthly_allowance");
    expect(b.actualCents).toBe(15000);
    expect(b.categories.map((c) => [c.name, c.cents])).toEqual([["Home", 15000]]);
    expect(b.needsClassification).toMatchObject({ cents: 0, count: 0, countsAgainstPlan: false });
    expect(b).toMatchObject({ remainingCents: -5000, overCents: 5000, withinPlan: false });
    expect(b.beside).toMatchObject({ weeklyCents: 6500, monthlyCents: null });
    expect(groupsPlusFloor(b)).toBe(b.actualCents);
  });

  it("prior months: the three before, none before tracking began; period starts are the 1st and Sundays only", () => {
    expect(priorPeriodStarts("month", "2026-10-01", "2026-05-01")).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(priorPeriodStarts("month", "2026-06-01", "2026-05-01")).toEqual(["2026-05-01"]);
    expect(priorPeriodStarts("month", "2027-01-01", "2026-05-01")).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
    expect(isPeriodStart("month", "2026-11-01")).toBe(true);
    expect(isPeriodStart("month", "2026-11-02")).toBe(false);
    expect(isPeriodStart("week", "2026-10-04")).toBe(true);
    expect(isPeriodStart("week", "2026-10-05")).toBe(false);
    expect(isPeriodStart("week", "2026-02-30")).toBe(false);
  });
});

function priorWeekOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/** The position's inputs for the same rows (only the week fields matter here). */
function positionInputs(rows: readonly BreakdownRowInput<string>[], capCents: number | null, adj: number | null): PositionInputs {
  return {
    todayISO: "2026-10-07",
    daily: [],
    events: [],
    incomeItems: [],
    cashBuffer: "0",
    reservesHeld: 0,
    weekCap: capCents == null ? null : capCents / 100,
    weekRows: rows.map((r) => r.allowance),
    freshness: { stale: false, staleReason: null, asOfBank: null },
    status: "no_data",
    weekAdjustmentCents: adj,
    weekAdjustmentReason: null,
    nextWeekAdjustmentCents: null,
  };
}

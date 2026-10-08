// ⭐ (PR-F1) "Can we afford this?" — the pure evaluator, worked by hand, plus
// its laws on random households. All figures are synthetic.
//
// THE HOUSEHOLD (Wed 2026-10-07; the curve runs 90 days, to Tue 2027-01-05)
//   Start of today 2,814.50 · cash buffer 500 · weekly cap 250 · this week
//   (Sun 10/4 – Sat 10/10): 80.00 weekly + 25.50 not yet filed → 144.50 left.
//   Curve: 10/8 +150 reimbursement, −340 electric (estimate) → 2,624.50
//          10/9 +2,000 paycheck → 4,624.50 · 10/12 −1,200 rent → 3,424.50
//          then paychecks every two weeks and the same bills monthly: the
//          balance only climbs, so the curve's lowest is 2,624.50 on 10/8.
//   Payday 10/9 (the $150 is under 25% of the $2,000 paycheck): lowest
//   through payday 2,624.50 (10/8; 10/9 read before its paycheck ties) →
//   available until payday 2,624.50 − 500 = 2,124.50; safe now min(144.50,
//   2,124.50) = 144.50.

import { describe, it, expect } from "vitest";
import {
  AFFORD_ASSUMPTIONS,
  AffordInputError,
  addDaysISO,
  composeCutRun,
  computePosition,
  debtFreeRange,
  debtFreeRangeWithCut,
  evaluateAfford,
  monthKeyOf,
  round2,
  simulate,
  walkLedger,
  type AffordBaseline,
  type AffordResult,
  type PlanDebt,
  type PositionEvent,
  type PositionInputs,
  type SimDebt,
  type Strategy,
} from "@workspace/avalanche-core";

const TODAY = "2026-10-07";
const TO = addDaysISO(TODAY, 90);

type Ev = { date: string; amount: number; kind: "income" | "expense"; id: string; estimate?: boolean };
const PAY = (date: string): Ev => ({ date, amount: 2000, kind: "income", id: "pay" });
const MONTHLY = (m: string): Ev[] => [
  { date: `${m}-08`, amount: 150, kind: "income", id: "reimb" },
  { date: `${m}-08`, amount: -340, kind: "expense", id: "electric", estimate: true },
  { date: `${m}-12`, amount: -1200, kind: "expense", id: "rent" },
];
const EVENTS: Ev[] = [
  ...MONTHLY("2026-10"),
  PAY("2026-10-09"),
  PAY("2026-10-23"),
  PAY("2026-11-06"),
  ...MONTHLY("2026-11"),
  PAY("2026-11-20"),
  PAY("2026-12-04"),
  ...MONTHLY("2026-12"),
  PAY("2026-12-18"),
  PAY("2027-01-01"),
].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

interface Over {
  start?: number;
  events?: Ev[];
  cashBuffer?: number;
  weekCap?: number | null;
  weekRows?: PositionInputs["weekRows"];
  status?: PositionInputs["status"];
  debts?: PlanDebt[];
  extra?: number;
  charges?: number;
  strategy?: Strategy;
  categoryPlans?: AffordBaseline["categoryPlans"];
  today?: string;
}

/** A baseline exactly as the server builds one: the position's `daily` IS the walk of the same items. */
function household(o: Over = {}): AffordBaseline {
  const today = o.today ?? TODAY;
  const to = addDaysISO(today, 90);
  const evs = o.events ?? EVENTS;
  const start = o.start ?? 2814.5;
  const items = evs.map((e) => ({ date: e.date, amount: e.amount }));
  const walk = walkLedger(items, start, today, to);
  const events: PositionEvent[] = evs.map((e) => ({
    date: e.date,
    amount: e.amount,
    kind: e.kind,
    itemId: e.id,
    label: e.id,
    assumption: null,
    amountKind: e.estimate ? "estimate" : "fixed",
  }));
  const positionInputs: PositionInputs = {
    todayISO: today,
    daily: walk.daily,
    events,
    incomeItems: [
      { id: "pay", amount: 2000, frequency: "biweekly", active: true },
      { id: "reimb", amount: 150, frequency: "monthly", active: true },
    ],
    cashBuffer: o.cashBuffer ?? 500,
    reservesHeld: 0,
    weekCap: o.weekCap === undefined ? 250 : o.weekCap,
    weekRows: o.weekRows ?? [
      { coverage: "allowance_weekly", spend: 80 },
      { coverage: "needs_classification", spend: 25.5 },
    ],
    freshness: { stale: false, staleReason: null, asOfBank: "2026-10-04T13:00:00.000Z" },
    status: o.status ?? "ready",
  };
  return {
    positionInputs,
    events: items,
    startingBalance: start,
    fromISO: today,
    toISO: to,
    categoryPlans: o.categoryPlans ?? [{ categoryId: "dining", planned: 300, spentMtd: 120.25 }],
    debts: o.debts ?? [],
    avalanche: { strategy: o.strategy ?? "avalanche", extraMonthly: o.extra ?? 0, newChargesPerMonth: o.charges ?? 0 },
  };
}

const NO_CAP: Over = { weekCap: null, weekRows: [] };
const VISA: PlanDebt = { id: "visa", name: "Visa", apr: 0.12, balance: 1000, minPayment: 100 };

describe("the baseline is the money position", () => {
  it("reads the household's own figures, worked by hand", () => {
    const b = household();
    const r = evaluateAfford(b, { amount: 0 });
    const pos = computePosition(b.positionInputs);
    expect(r.baseline).toEqual({
      safeToSpendNow: "144.50",
      remainingWeek: "144.50",
      availableUntilPayday: "2124.50",
      lowest: "2624.50",
      lowestDate: "2026-10-08",
      debtFreeEarliest: null,
      debtFreeLatest: null,
      totalInterestLow: "0.00",
    });
    expect(r.baseline.safeToSpendNow).toBe(pos.safeToSpendNow);
    expect(r.baseline.availableUntilPayday).toBe(pos.availableUntilPayday);
    expect(r.baseline.remainingWeek).toBe(pos.remainingWeek);
  });

  it("never changes the baseline it is handed", () => {
    const b = household({ debts: [VISA], extra: 200 });
    const before = JSON.stringify(b);
    evaluateAfford(b, { amount: 1924.51, dateISO: "2026-10-08", categoryId: "dining" });
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe("one purchase, worked by hand", () => {
  it("$100 on Thursday 10/8: every cash figure down $100, fits", () => {
    const r = evaluateAfford(household(), { amount: 100, dateISO: "2026-10-08" });
    expect(r.amount).toBe("100.00");
    expect(r.dateISO).toBe("2026-10-08");
    expect(r.proposed).toEqual({
      safeToSpendNow: "44.50",
      remainingWeek: "44.50",
      availableUntilPayday: "2024.50",
      lowest: "2524.50",
      lowestDate: "2026-10-08",
      debtFreeEarliest: null,
      debtFreeLatest: null,
      totalInterestLow: "0.00",
    });
    expect(r.delta).toEqual({
      safeToSpendNow: "-100.00",
      remainingWeek: "-100.00",
      availableUntilPayday: "-100.00",
      lowest: "-100.00",
      lowestDate: null,
      debtFreeEarliest: null,
      debtFreeLatest: null,
      totalInterestLow: "0.00",
    });
    expect(r.verdict).toBe("fits");
    expect(r.assumptions).toContain(AFFORD_ASSUMPTIONS.countedOn("2026-10-08"));
    expect(r.assumptions).toContain(AFFORD_ASSUMPTIONS.countsThisWeek);
    // The position's own wording comes first, unchanged.
    expect(r.assumptions.slice(0, 2)).toEqual(["available credit is not counted", "bank data from 2026-10-04"]);
  });

  it("$300 on Saturday 10/10: after payday, so until-payday holds; the week goes over its cap → tight", () => {
    const r = evaluateAfford(household(), { amount: 300, dateISO: "2026-10-10" });
    expect(r.proposed.remainingWeek).toBe("-155.50");
    expect(r.proposed.safeToSpendNow).toBe("0.00");
    expect(r.proposed.availableUntilPayday).toBe("2124.50");
    // 10/10: 4,624.50 − 300 = 4,324.50; 10/12: 3,124.50 — still above 10/8's 2,624.50.
    expect(r.proposed.lowest).toBe("2624.50");
    expect(r.delta.lowest).toBe("0.00");
    expect(r.delta.safeToSpendNow).toBe("-144.50");
    expect(r.verdict).toBe("tight");
  });

  it("$300 on Monday 10/12: next week's money — this week's cap is unchanged", () => {
    const r = evaluateAfford(household(), { amount: 300, dateISO: "2026-10-12" });
    expect(r.proposed.remainingWeek).toBe("144.50");
    expect(r.proposed.safeToSpendNow).toBe("144.50");
    expect(r.proposed.lowest).toBe("2624.50");
    expect(r.verdict).toBe("fits");
    expect(r.assumptions).toContain(AFFORD_ASSUMPTIONS.afterThisWeek);
    expect(r.assumptions).not.toContain(AFFORD_ASSUMPTIONS.countsThisWeek);
  });
});

describe("the date", () => {
  it("omitted is today; a past date is today, and says so", () => {
    const today = evaluateAfford(household(), { amount: 100 });
    const past = evaluateAfford(household(), { amount: 100, dateISO: "2026-10-01" });
    expect(today.dateISO).toBe(TODAY);
    expect(past.dateISO).toBe(TODAY);
    // Today: 2,714.50 at the end of 10/7, then 2,524.50 on 10/8.
    expect(past.proposed).toEqual(today.proposed);
    expect(past.proposed.lowest).toBe("2524.50");
    expect(past.proposed.safeToSpendNow).toBe("44.50");
    expect(past.assumptions).toContain(AFFORD_ASSUMPTIONS.pastDateToday);
    expect(past.assumptions.filter((a) => a !== AFFORD_ASSUMPTIONS.pastDateToday)).toEqual(today.assumptions);
    expect(today.assumptions).not.toContain(AFFORD_ASSUMPTIONS.pastDateToday);
  });

  it("the curve's last day is the last date it can read; one day past it, or not a date, is refused", () => {
    expect(evaluateAfford(household(), { amount: 10, dateISO: TO }).dateISO).toBe("2027-01-05");
    const code = (fn: () => unknown) => {
      try {
        fn();
        return "no error";
      } catch (e) {
        return e instanceof AffordInputError ? e.code : String(e);
      }
    };
    expect(code(() => evaluateAfford(household(), { amount: 10, dateISO: addDaysISO(TO, 1) }))).toBe("date_past_window");
    expect(code(() => evaluateAfford(household(), { amount: 10, dateISO: "2026-02-30" }))).toBe("bad_date");
    expect(code(() => evaluateAfford(household(), { amount: 10, dateISO: "10/08/2026" }))).toBe("bad_date");
    expect(code(() => evaluateAfford(household(), { amount: -1 }))).toBe("bad_amount");
    expect(code(() => evaluateAfford(household(), { amount: Number.NaN }))).toBe("bad_amount");
  });
});

describe("the verdict, at every boundary (cents)", () => {
  const v = (amount: number, dateISO: string, o: Over = NO_CAP) => evaluateAfford(household(o), { amount, dateISO }).verdict;

  it("breaks_zero below $0, breaks_buffer at $0.00 and below the buffer", () => {
    expect(v(2624.51, "2026-10-08")).toBe("breaks_zero"); // −0.01
    expect(v(2624.5, "2026-10-08")).toBe("breaks_buffer"); // 0.00
    expect(v(2124.51, "2026-10-08")).toBe("breaks_buffer"); // 499.99
  });

  it("at the buffer exactly the cash holds; with nothing left until payday it is tight", () => {
    expect(v(2124.5, "2026-10-08")).toBe("tight"); // 500.00, available 0.00
  });

  it("tight when less than 15% of what was left until payday remains", () => {
    // 15% of 2,124.50 = 318.675: 318.67 left is tight, 318.68 left fits.
    expect(v(1805.83, "2026-10-08")).toBe("tight");
    expect(v(1805.82, "2026-10-08")).toBe("fits");
  });

  it("tight when less than 15% of what was left this week remains, or the week goes over", () => {
    // 15% of 144.50 = 21.675: 21.67 left is tight, 21.68 fits. Saturday, so until-payday is untouched.
    expect(v(122.83, "2026-10-10", {})).toBe("tight");
    expect(v(122.82, "2026-10-10", {})).toBe("fits");
    expect(v(144.5, "2026-10-10", {})).toBe("tight");
    expect(v(144.51, "2026-10-10", {})).toBe("tight"); // −0.01: over the cap
  });

  it("a purchase after payday that takes a later day under the buffer breaks it", () => {
    // Sat 10/10, then rent on 10/12: 3,424.50 − 2,924.51 = 499.99.
    const r = evaluateAfford(household(NO_CAP), { amount: 2924.51, dateISO: "2026-10-10" });
    expect(r.proposed.availableUntilPayday).toBe("2124.50");
    expect(r.proposed.lowest).toBe("499.99");
    expect(r.proposed.lowestDate).toBe("2026-10-12");
    expect(r.delta.lowestDate).toBe("2026-10-12");
    expect(r.verdict).toBe("breaks_buffer");
    expect(v(2924.5, "2026-10-10")).toBe("fits"); // 500.00
  });

  it("a curve already under the buffer says so, whatever the purchase", () => {
    const r = evaluateAfford(household({ ...NO_CAP, cashBuffer: 2700 }), { amount: 0 });
    expect(r.verdict).toBe("breaks_buffer");
    expect(r.assumptions).toContain(AFFORD_ASSUMPTIONS.alreadyShort);
    expect(evaluateAfford(household(NO_CAP), { amount: 0 }).assumptions).not.toContain(AFFORD_ASSUMPTIONS.alreadyShort);
  });
});

describe("the category", () => {
  it("planned − spent this month − the purchase", () => {
    const r = evaluateAfford(household(), { amount: 100, categoryId: "dining" });
    expect(r.category).toEqual({ categoryId: "dining", remainingBefore: "179.75", remainingAfter: "79.75" });
    expect(evaluateAfford(household(), { amount: 100 }).category).toBeNull();
  });

  it("a category with no plan is named, never guessed", () => {
    const r = evaluateAfford(household(), { amount: 100, categoryId: "travel" });
    expect(r.category).toEqual({ categoryId: "travel", remainingBefore: null, remainingAfter: null });
    expect(r.assumptions).toContain(AFFORD_ASSUMPTIONS.categoryNoPlan);
  });

  it("a later month's purchase is measured against this month's plan, and says so", () => {
    const r = evaluateAfford(household(), { amount: 100, dateISO: "2026-11-10", categoryId: "dining" });
    expect(r.category!.remainingAfter).toBe("79.75");
    expect(r.assumptions).toContain(AFFORD_ASSUMPTIONS.categoryThisMonth);
  });

  it("a member is noted; the shared cap is used", () => {
    expect(evaluateAfford(household(), { amount: 10, member: "m1" }).assumptions).toContain(AFFORD_ASSUMPTIONS.sharedCap);
  });
});

describe("the debt rule", () => {
  // Visa $1,000 at 12% (1% a month), minimum $100, planned extra $200, from October 2026.
  //   Plan as set:  Oct 1,000 + 10.00 − 300 = 710 · Nov 717.10 − 300 = 417.10 ·
  //                 Dec 421.27 − 300 = 121.27 · Jan 122.48 − 122.48 = 0
  //                 → 2027-01, interest 10 + 7.10 + 4.17 + 1.21 = 22.48
  //   Half extra:   810 · 618.10 · 424.28 · 228.52 · 30.81 · Mar 31.12 → 0
  //                 → 2027-03, interest 31.12
  const debt: Over = { ...NO_CAP, debts: [VISA], extra: 200 };

  it("the baseline range is debtFreeRange's own", () => {
    const r = evaluateAfford(household(debt), { amount: 0 });
    const range = debtFreeRange([VISA], 200, 0, { strategy: "avalanche", startISO: "2026-10" });
    expect(range.runs.map((x) => [x.key, x.debtFreeMonth, x.totalInterest])).toEqual([
      ["base", "2027-01", 22.48],
      ["half_extra", "2027-03", 31.12],
      ["new_charges", "2027-01", 22.48],
    ]);
    expect([r.baseline.debtFreeEarliest, r.baseline.debtFreeLatest, r.baseline.totalInterestLow]).toEqual(["2027-01", "2027-03", "22.48"]);
  });

  it("untouched while what is left until payday covers the extra — $200.00 left is enough", () => {
    for (const amount of [100, 1924.5]) {
      const r = evaluateAfford(household(debt), { amount, dateISO: "2026-10-08" });
      expect(r.debt).toEqual({ affected: false, cut: "0.00", cutMonth: null, debtFreeMonthShift: 0, interestDelta: "0.00" });
      expect([r.proposed.debtFreeEarliest, r.proposed.debtFreeLatest, r.proposed.totalInterestLow]).toEqual(["2027-01", "2027-03", "22.48"]);
    }
  });

  it("$199.99 left: October's extra is cut by min(amount, extra) = $200 → one month later, $6.35 more interest", () => {
    // Oct 1,010 − 100 = 910 · Nov 919.10 − 300 = 619.10 · Dec 625.29 − 300 = 325.29 ·
    // Jan 328.54 − 300 = 28.54 · Feb 28.83 → 0: 2027-02, interest 10 + 9.10 + 6.19 + 3.25 + 0.29 = 28.83.
    const r = evaluateAfford(household(debt), { amount: 1924.51, dateISO: "2026-10-08" });
    expect(r.proposed.availableUntilPayday).toBe("199.99");
    expect(r.debt).toEqual({ affected: true, cut: "200.00", cutMonth: "2026-10", debtFreeMonthShift: 1, interestDelta: "6.35" });
    // Half extra with October's $100 cut: 910 · 719.10 · 526.29 · 331.55 · 134.87 · Mar 0 → 2027-03 (36.22).
    expect([r.proposed.debtFreeEarliest, r.proposed.debtFreeLatest, r.proposed.totalInterestLow]).toEqual(["2027-02", "2027-03", "28.83"]);
    expect(r.delta.debtFreeEarliest).toBe(1);
    expect(r.delta.debtFreeLatest).toBe(0);
    expect(r.delta.totalInterestLow).toBe("6.35");
    expect(r.assumptions).toContain(AFFORD_ASSUMPTIONS.extraCut("2026-10", "200.00"));
  });

  it("a later month's purchase cuts THAT month: $50 in November", () => {
    // Buffer 2,500 leaves 124.50 until payday — under the $200 extra.
    // Oct 710 · Nov 717.10 − 100 − 150 = 467.10 · Dec 471.77 − 300 = 171.77 · Jan 173.49 → 0
    // → 2027-01 still, interest 10 + 7.10 + 4.67 + 1.72 = 23.49 (+1.01).
    const r = evaluateAfford(household({ ...debt, cashBuffer: 2500 }), { amount: 50, dateISO: "2026-11-10" });
    expect(r.debt).toEqual({ affected: true, cut: "50.00", cutMonth: "2026-11", debtFreeMonthShift: 0, interestDelta: "1.01" });
    expect(r.verdict).toBe("fits");
  });

  it("no bank data: the extra is assumed to pay for it", () => {
    const r = evaluateAfford(household({ ...debt, status: "no_data" }), { amount: 50, dateISO: "2026-10-08" });
    expect(r.proposed.availableUntilPayday).toBeNull();
    expect(r.debt.affected).toBe(true);
    expect(r.debt.cut).toBe("50.00");
  });

  it("no planned extra, or a $0 purchase: nothing to cut", () => {
    expect(evaluateAfford(household({ ...debt, extra: 0, cashBuffer: 2600 }), { amount: 50 }).debt.affected).toBe(false);
    expect(evaluateAfford(household({ ...debt, cashBuffer: 2600 }), { amount: 0 }).debt.affected).toBe(false);
  });
});

// ── The laws ──────────────────────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cents = (r: () => number, max: number) => Math.round(r() * max * 100) / 100;

function randomDebts(r: () => number): SimDebt[] {
  const n = Math.floor(r() * 4);
  const out: SimDebt[] = [];
  for (let i = 0; i < n; i++) {
    const balance = r() < 0.1 ? 0 : cents(r, 15000);
    out.push({
      id: `d${i}`,
      name: `Debt ${i}`,
      apr: Math.round(r() * 30) / 100,
      balance,
      minPayment: r() < 0.15 ? cents(r, 20) : cents(r, 400),
      status: r() < 0.1 ? "paid_off" : "active",
    });
  }
  return out;
}

describe("the engine split: composeCutRun with nothing cut IS simulate (2,000 random debt sets)", () => {
  it("same debt-free month and the same interest, to the cent, whatever month the split falls in", () => {
    const r = rng(20261008);
    for (let i = 0; i < 2000; i++) {
      const debts = randomDebts(r);
      const extra = r() < 0.2 ? 0 : cents(r, 900);
      const charges = r() < 0.5 ? 0 : cents(r, 300);
      const strategy: Strategy = r() < 0.5 ? "avalanche" : "snowball";
      const startDate = new Date(2026, 9, 1);
      const k = 1 + Math.floor(r() * 5);
      const sim = simulate({ debts, extraPerMonth: extra, strategy, startDate, newChargesPerMonth: charges });
      const want = {
        debtFreeMonth: !sim.ranOutOfTime && sim.debtFreeDate ? monthKeyOf(sim.debtFreeDate) : null,
        totalInterest: !sim.ranOutOfTime ? round2(sim.totalInterestPaid) : null,
      };
      const got = composeCutRun({ debts, extraPerMonth: extra, strategy, startDate, newChargesPerMonth: charges, cutMonthIndex: k, cut: 0 });
      expect(got, `case ${i}`).toEqual(want);
    }
  });

  it("debtFreeRangeWithCut with nothing cut IS debtFreeRange", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const debts = randomDebts(r);
      const extra = cents(r, 900);
      const charges = cents(r, 200);
      const strategy: Strategy = r() < 0.5 ? "avalanche" : "snowball";
      const want = debtFreeRange(debts, extra, charges, { strategy, startISO: "2026-10" });
      const got = debtFreeRangeWithCut(debts, extra, charges, { strategy, startISO: "2026-10", cutMonthIndex: 1 + Math.floor(r() * 4), cut: 0 });
      expect(got, `case ${i}`).toEqual({ earliestMonth: want.earliestMonth, latestMonth: want.latestMonth, interestLow: want.interestLow, runs: want.runs });
    }
  });
});

function randomHousehold(r: () => number): AffordBaseline {
  const evs: Ev[] = [];
  const n = 3 + Math.floor(r() * 25);
  for (let i = 0; i < n; i++) {
    const date = addDaysISO(TODAY, Math.floor(r() * 95) - 3);
    const income = r() < 0.3;
    evs.push({ date, amount: income ? cents(r, 3000) : -cents(r, 1500), kind: income ? "income" : "expense", id: `e${i}`, estimate: r() < 0.2 });
  }
  evs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const capped = r() < 0.7;
  return household({
    start: cents(r, 6000) - (r() < 0.1 ? 1000 : 0),
    events: evs,
    cashBuffer: cents(r, 800),
    weekCap: capped ? cents(r, 400) : null,
    weekRows: capped ? [{ coverage: "allowance_weekly", spend: cents(r, 300) }] : [],
    status: r() < 0.1 ? "no_data" : "ready",
    debts: randomDebts(r),
    extra: r() < 0.3 ? 0 : cents(r, 600),
    charges: r() < 0.5 ? 0 : cents(r, 200),
    strategy: r() < 0.5 ? "avalanche" : "snowball",
  });
}

const MONEY_KEYS = ["safeToSpendNow", "remainingWeek", "availableUntilPayday", "lowest", "totalInterestLow"] as const;
const c = (s: string | null) => (s === null ? null : Math.round(Number(s) * 100));

describe("THE LAWS (random households)", () => {
  it("a $0 purchase reproduces the baseline to the cent", () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const b = randomHousehold(r);
      const res: AffordResult = evaluateAfford(b, { amount: 0, dateISO: addDaysISO(TODAY, Math.floor(r() * 90)) });
      expect(res.proposed, `case ${i}`).toEqual(res.baseline);
      expect(res.debt).toEqual({ affected: false, cut: "0.00", cutMonth: null, debtFreeMonthShift: 0, interestDelta: "0.00" });
      for (const k of ["safeToSpendNow", "remainingWeek", "availableUntilPayday", "totalInterestLow"] as const) {
        expect(res.delta[k]).toBe(res.baseline[k] === null ? null : "0.00");
      }
      expect(res.delta.lowest).toBe("0.00");
      expect(res.delta.lowestDate).toBeNull();
      // …and the baseline is the position the household sees.
      const pos = computePosition(b.positionInputs);
      expect([res.baseline.safeToSpendNow, res.baseline.remainingWeek, res.baseline.availableUntilPayday]).toEqual([
        pos.safeToSpendNow,
        pos.remainingWeek,
        pos.availableUntilPayday,
      ]);
    }
  });

  it("a purchase never shows a higher cash figure, an earlier debt-free month or less interest", () => {
    const r = rng(1009);
    let affected = 0;
    for (let i = 0; i < 400; i++) {
      const b = randomHousehold(r);
      const amount = cents(r, r() < 0.5 ? 300 : 5000) + 0.01;
      const res = evaluateAfford(b, { amount, dateISO: addDaysISO(TODAY, Math.floor(r() * 90)) });
      for (const k of MONEY_KEYS) {
        const base = c(res.baseline[k]);
        const prop = c(res.proposed[k]);
        if (k === "totalInterestLow") {
          if (base === null) expect(prop, `case ${i} ${k}`).toBeNull();
        } else expect(prop === null, `case ${i} ${k} null-ness`).toBe(base === null);
        if (base !== null && prop !== null) {
          if (k === "totalInterestLow") expect(prop, `case ${i} ${k}`).toBeGreaterThanOrEqual(base);
          else expect(prop, `case ${i} ${k}`).toBeLessThanOrEqual(base);
        }
      }
      for (const k of ["debtFreeEarliest", "debtFreeLatest"] as const) {
        const base = res.baseline[k];
        const prop = res.proposed[k];
        if (base === null) expect(prop, `case ${i} ${k}`).toBeNull();
        else if (prop !== null) expect(prop >= base, `case ${i} ${k}`).toBe(true);
      }
      if (res.debt.affected) {
        affected++;
        if (res.debt.debtFreeMonthShift !== null) expect(res.debt.debtFreeMonthShift).toBeGreaterThanOrEqual(0);
        if (res.debt.interestDelta !== null) expect(Number(res.debt.interestDelta)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(affected).toBeGreaterThan(20); // the debt rule is exercised, not vacuous
  });
});

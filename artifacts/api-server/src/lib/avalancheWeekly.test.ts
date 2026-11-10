import { describe, it, expect } from "vitest";
import { isDueDay, planWeeklyAvalanche, weeklyShare, type WeeklyPlan, type WeeklyPlanDebt } from "./avalancheWeekly";

// ⭐ (AVAL-W) The acceptance fixture — invented figures: four cards tied on the
// top APR (smallest balance first), one card with no minimum, one due on the
// 31st (the month's last day), a small store loan and a large low-APR loan
// last; $2,600 a month as the target, Fridays, a $500 buffer.
const DEBTS: WeeklyPlanDebt[] = [
  { id: "a", name: "Card A", balance: 2000, apr: 0.25, minPayment: 100, dueDay: 10, minimumOnCurve: true },
  { id: "b", name: "Card B", balance: 3000, apr: 0.25, minPayment: 200, dueDay: 5, minimumOnCurve: true },
  { id: "c", name: "Card C", balance: 4000, apr: 0.25, minPayment: 150, dueDay: 12, minimumOnCurve: true },
  { id: "d", name: "Card D", balance: 6000, apr: 0.25, minPayment: 300, dueDay: 31, minimumOnCurve: true },
  { id: "e", name: "Card E", balance: 2500, apr: 0.2, minPayment: 0, dueDay: 20, minimumOnCurve: true },
  { id: "store", name: "Store loan", balance: 2400, apr: 0.15, minPayment: 120, dueDay: 8, minimumOnCurve: true },
  { id: "personal", name: "Personal loan", balance: 20000, apr: 0.1, minPayment: 800, dueDay: 3, minimumOnCurve: true },
];
const TARGET = 2600;
const TODAY = "2026-11-10"; // a Tuesday

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}
function curveOf(days: number, balanceOn: (iso: string, i: number) => number) {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(TODAY, i);
    return { date, balance: balanceOn(date, i) };
  });
}
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The curve as the forecast draws it once the plan is on it, recomputed here on
 * its own: the curve, less every payment made on or before the day, plus every
 * minimum the forecast no longer takes (a paid-off debt's due days after its
 * payoff day).
 */
function curveWithPlan(curve: Array<{ date: string; balance: number }>, plan: WeeklyPlan, debts: WeeklyPlanDebt[]) {
  const payoff = new Map(plan.payoffs.map((p) => [p.debtId, p.date] as const));
  let paid = 0;
  let freed = 0;
  // Only the weeks priced from the curve go onto the forecast.
  const priced = plan.weeks.filter((w) => w.basis === "curve");
  return curve.map((p) => {
    for (const w of priced) if (w.date === p.date) paid += w.paid;
    for (const d of debts) {
      const off = payoff.get(d.id);
      if (d.minimumOnCurve && off && p.date > off && isDueDay(d.dueDay, p.date)) freed += d.minPayment;
    }
    return { date: p.date, balance: Math.round((p.balance - paid + freed) * 100) / 100 };
  });
}

describe("weeklyShare", () => {
  it("is the monthly figure × 12 ÷ 52, to the cent", () => {
    expect(weeklyShare(TARGET)).toBe(600);
    expect([100, 200, 150, 300, 0, 120, 800].map(weeklyShare)).toEqual([23.08, 46.15, 34.62, 69.23, 0, 27.69, 184.62]);
  });
});

describe("planWeeklyAvalanche — acceptance fixture, target pace, room never binds", () => {
  // A curve so high the room never binds: every week pays the target pace.
  const curve = curveOf(470, () => 10_000_000);
  const plan = planWeeklyAvalanche({
    debts: DEBTS,
    monthlyTarget: TARGET,
    weekday: 5,
    cashBuffer: 500,
    todayISO: TODAY,
    curve,
    capAtTarget: true,
  });

  it("starts this Friday at $600 and rises by each freed minimum's weekly share", () => {
    expect(plan.weeks[0]!.date).toBe("2026-11-13");
    expect(plan.weeks[0]!.paid).toBe(600);
    const paces: number[] = [];
    for (const w of plan.weeks) if (paces[paces.length - 1] !== w.planned) paces.push(w.planned);
    // Card E carries no minimum, so its payoff raises the pace by $0.
    expect(paces).toEqual([600, 623.08, 669.23, 703.85, 773.08, 800.77]);
    const rises = plan.payoffs.slice(0, 6).map((p) => p.freedWeekly);
    expect(rises).toEqual([23.08, 46.15, 34.62, 69.23, 0, 27.69]);
    // Every week but the last pays the full pace (the room never binds).
    for (const w of plan.weeks.slice(0, -1)) expect(w.paid).toBe(w.planned);
    expect(plan.weeks.every((w) => w.basis === "curve")).toBe(true);
  });

  it("pays the debts off in avalanche order: the tied cards smallest first, then by APR", () => {
    expect(plan.payoffs.map((p) => p.debtId)).toEqual(["a", "b", "c", "d", "e", "store", "personal"]);
    // Interest on each due day, minimums on due days, the leftover rolled to
    // the next debt the same Friday.
    expect(plan.payoffs.map((p) => p.date)).toEqual([
      "2026-12-04",
      "2027-01-01",
      "2027-02-12",
      "2027-04-02",
      "2027-04-23",
      "2027-05-14",
      "2027-09-03",
    ]);
    expect(plan.debtFreeDate).toBe("2027-09-03");
    expect(plan.ranOutOfTime).toBe(false);
    // The last Friday pays only what is left.
    const last = plan.weeks[plan.weeks.length - 1]!;
    expect(last).toMatchObject({ date: "2027-09-03", planned: 800.77, paid: 617.06 });
  });

  it("rolls the leftover to the next debt the same Friday, and marks the payoff on that week", () => {
    const dec4 = plan.weeks.find((w) => w.date === "2026-12-04")!;
    expect(dec4.targets.map((t) => [t.debtId, t.amount, t.paidOff])).toEqual([
      ["a", 141.67, true],
      ["b", 458.33, false],
    ]);
    expect(dec4.paidOff.map((p) => p.debtId)).toEqual(["a"]);
    expect(plan.weeks.find((w) => w.date === "2026-12-11")!.planned).toBe(623.08);
  });

  it("the first twelve payments", () => {
    expect(
      plan.weeks.slice(0, 12).map((w) => [w.date, w.paid, w.targets.map((t) => t.debtId).join("+"), w.paidOff.map((p) => p.debtId).join("+")]),
    ).toEqual([
      ["2026-11-13", 600, "a", ""],
      ["2026-11-20", 600, "a", ""],
      ["2026-11-27", 600, "a", ""],
      ["2026-12-04", 600, "a+b", "a"],
      ["2026-12-11", 623.08, "b", ""],
      ["2026-12-18", 623.08, "b", ""],
      ["2026-12-25", 623.08, "b", ""],
      ["2027-01-01", 623.08, "b+c", "b"],
      ["2027-01-08", 669.23, "c", ""],
      ["2027-01-15", 669.23, "c", ""],
      ["2027-01-22", 669.23, "c", ""],
      ["2027-01-29", 669.23, "c", ""],
    ]);
  });

  it("past the curve, weeks pay the target pace and are marked so", () => {
    const short = planWeeklyAvalanche({
      debts: DEBTS,
      monthlyTarget: TARGET,
      weekday: 5,
      cashBuffer: 500,
      todayISO: TODAY,
      curve: curveOf(60, () => 10_000_000),
      capAtTarget: true,
    });
    const late = short.weeks.filter((w) => w.basis === "target");
    expect(late.length).toBeGreaterThan(0);
    for (const w of late) {
      expect(w.room).toBeNull();
      if (w !== short.weeks[short.weeks.length - 1]) expect(w.paid).toBe(w.planned);
    }
    // Priced only while 28 days of curve remain after the week.
    expect(short.curveThrough! <= addDays(TODAY, 59 - 28)).toBe(true);
  });
});

describe("planWeeklyAvalanche — the room binds", () => {
  // Flat at $5,000, except a low point the day right after the first Friday.
  const curve = curveOf(400, (iso) => (iso === "2026-11-14" ? 900 : 5000));

  it("capped at the target pace: the first Friday is cut to what keeps the low at the buffer", () => {
    const plan = planWeeklyAvalanche({ debts: DEBTS, monthlyTarget: TARGET, weekday: 5, cashBuffer: 500, todayISO: TODAY, curve, capAtTarget: true });
    expect(plan.weeks[0]).toMatchObject({ date: "2026-11-13", planned: 600, room: 400, paid: 400 });
    expect(plan.weeks[1]).toMatchObject({ date: "2026-11-20", room: 4100, paid: 600 });
    const drawn = curveWithPlan(curve, plan, DEBTS).filter((p) => p.date >= "2026-11-13");
    expect(Math.min(...drawn.map((p) => p.balance))).toBeGreaterThanOrEqual(500);
    expect(drawn.find((p) => p.date === "2026-11-14")!.balance).toBe(500);
  });

  it("the most that is safe: the thin week pays $400, the next week everything above the buffer", () => {
    const plan = planWeeklyAvalanche({ debts: DEBTS, monthlyTarget: TARGET, weekday: 5, cashBuffer: 500, todayISO: TODAY, curve });
    expect(plan.weeks[0]).toMatchObject({ date: "2026-11-13", room: 400, paid: 400 });
    // $5,000 − the $400 already paid − the $500 buffer.
    expect(plan.weeks[1]).toMatchObject({ date: "2026-11-20", room: 4100, paid: 4100 });
    const drawn = curveWithPlan(curve, plan, DEBTS).filter((p) => p.date >= "2026-11-13");
    expect(Math.min(...drawn.map((p) => p.balance))).toBeGreaterThanOrEqual(500);
  });
});

describe("planWeeklyAvalanche — the most that is safe on an uneven month", () => {
  // Two biweekly paychecks a month on Fridays, bills on the 1st and 15th, the
  // minimums on their due days: most months leave a little, the month with a
  // third paycheck leaves a lot.
  const PAY = 4000;
  const firstPay = "2026-11-13";
  const curve = (() => {
    let bal = 2500;
    return curveOf(400, (iso) => {
      const n = daysBetween(firstPay, iso);
      if (n >= 0 && n % 14 === 0) bal += PAY;
      const day = Number(iso.slice(8, 10));
      if (day === 1) bal -= 2600; // rent and the rest
      if (day === 15) bal -= 1450;
      for (const d of DEBTS) if (isDueDay(d.dueDay, iso)) bal -= d.minPayment;
      return Math.round(bal * 100) / 100;
    });
  })();
  const plan = planWeeklyAvalanche({ debts: DEBTS, monthlyTarget: TARGET, weekday: 5, cashBuffer: 500, todayISO: TODAY, curve });

  it("never takes the curve below the buffer", () => {
    const drawn = curveWithPlan(curve, plan, DEBTS).filter((p) => p.date >= plan.weeks[0]!.date);
    expect(Math.min(...drawn.map((p) => p.balance))).toBeGreaterThanOrEqual(500);
  });

  it("pays a large amount in a third-paycheck week and less in a thin one", () => {
    const priced = plan.weeks.filter((w) => w.basis === "curve");
    const amounts = priced.map((w) => w.paid);
    expect(Math.max(...amounts)).toBeGreaterThan(2000);
    expect(Math.min(...amounts)).toBeLessThan(weeklyShare(TARGET));
    // Every priced week pays exactly its room (nothing is held back, no cap).
    for (const w of priced) expect(w.paid).toBe(Math.min(w.room!, w.paid));
  });
});

describe("planWeeklyAvalanche — answers and minimums", () => {
  const curve = curveOf(400, () => 3000);

  it("an answered week pays nothing more, and its cash rolls into the next week", () => {
    const plan = planWeeklyAvalanche({
      debts: DEBTS,
      monthlyTarget: TARGET,
      weekday: 5,
      cashBuffer: 500,
      todayISO: TODAY,
      curve,
      answeredDates: new Set(["2026-11-13"]),
    });
    expect(plan.weeks[0]).toMatchObject({ date: "2026-11-13", answered: true, due: 2500, paid: 0, targets: [] });
    expect(plan.weeks[0]!.nextTarget).toEqual({ debtId: "a", name: "Card A" });
    expect(plan.weeks[1]).toMatchObject({ date: "2026-11-20", paid: 2500 });
  });

  it("a debt its own minimum finishes is paid off on its due day, and that minimum comes back to the curve", () => {
    const small: WeeklyPlanDebt[] = [
      { id: "tiny", name: "Store card", balance: 40, apr: 0, minPayment: 50, dueDay: 12, minimumOnCurve: true },
      { id: "big", name: "Loan", balance: 90_000, apr: 0.1, minPayment: 600, dueDay: 20, minimumOnCurve: true },
    ];
    const plan = planWeeklyAvalanche({ debts: small, monthlyTarget: 0, weekday: 5, cashBuffer: 500, todayISO: TODAY, curve });
    expect(plan.payoffs[0]).toMatchObject({ debtId: "tiny", date: "2026-11-12" });
    expect(plan.weeks[0]!.paidOff.map((p) => p.debtId)).toEqual(["tiny"]);
    // From 2026-12-12 on, the curve no longer pays the $50: the room grows by it.
    const before = plan.weeks.find((w) => w.date === "2026-12-11")!;
    const after = plan.weeks.find((w) => w.date === "2026-12-18")!;
    expect(before.paid).toBe(0);
    expect(after.paid).toBe(50);
  });

  it("no debts: no weeks, no debt-free day", () => {
    const plan = planWeeklyAvalanche({ debts: [], monthlyTarget: TARGET, weekday: 5, cashBuffer: 500, todayISO: TODAY, curve });
    expect(plan).toMatchObject({ weeks: [], payoffs: [], debtFreeDate: null, ranOutOfTime: false });
  });
});

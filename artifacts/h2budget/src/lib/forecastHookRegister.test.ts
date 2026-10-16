import { describe, it, expect } from "vitest";
import { buildLineRegister, canRecordPartial, type PlanLine, type Resolution } from "./forecastMatch";
import { hookCurveOf, hookLineOf, hookPayoffsOf, hookPayoffWords } from "./forecastHooks";
import { daySummary, kindEvents } from "./forecastEventKinds";
import type { CashEvent } from "./forecast";

/**
 * ⭐ (Task 4, D) A WEEKLY / MONTHLY SPEND ROW IS WHAT THE CURVE TAKES FOR IT.
 *
 * The register lists the bundle's events (each occurrence at the item's STORED
 * amount); the curve takes the cash signal's figure for the same occurrence
 * (card purchases + carried + left to spend). Before Task 4 the row headlined
 * the stored amount and its words said "(item amount $X not used)". Pinned:
 *   - every hook row's amount = the curve's figure for its own occurrence key
 *     (moved and two-on-a-day included); off the curve → 0, `onCurve` false;
 *   - the running balance walks that figure;
 *   - for each day: Σ register rows = the day panel's outflows = the curve's step;
 *   - a legacy `partial` answer on a hook decides nothing (the ledger's rule);
 *   - the register can never offer Partial on a hook (no server pair names one);
 *   - without the curve figures every line reads as before.
 * Synthetic: Monthly Spend stored $400 on the 1st (plan $620), Weekly Spend stored
 * $300 on Saturdays, a $1,650 mortgage, an opening of $2,400.00.
 */

const MS = "ms";
const WS = "ws";
const ev = (itemId: string, date: string, amount: number, label: string): CashEvent => ({ itemId, date, amount, label, kind: amount > 0 ? "income" : "expense" });

// The bundle's events: stored amounts at each occurrence's own date.
const bundleEvents: CashEvent[] = [
  ev(MS, "2026-10-01", -400, "Monthly Spend"),
  ev(MS, "2026-11-01", -400, "Monthly Spend"),
  ev(WS, "2026-10-17", -300, "Weekly Spend"),
  ev(WS, "2026-10-24", -300, "Weekly Spend"),
  ev(WS, "2026-10-31", -300, "Weekly Spend"),
  ev("mort", "2026-10-24", -1650, "Mortgage"),
];
// October's Monthly Spend moved by the household to Nov 1; a legacy partial on November's.
const resolutions: Resolution[] = [
  { id: "r-move", recurringItemId: MS, occurrenceDate: "2026-10-01", status: "rescheduled", matchedTxnId: null, rescheduledTo: "2026-11-01" },
  { id: "r-part", recurringItemId: MS, occurrenceDate: "2026-11-01", status: "partial", matchedTxnId: "tx-pay", txnAmount: "-85.00" },
];

// The cash signal for the same household: the curve's figure per occurrence key.
const signal = {
  fromDate: "2026-10-14",
  toDate: "2026-11-12",
  startingBalance: "2400.00",
  hookAmountIgnored: [{ itemId: MS, cadence: "monthly" as const, storedAmount: "400.00" }],
  hookReserves: [
    { hook: "monthly", recurringItemId: MS, planKey: `${MS}|2026-10-01`, occurrenceDate: "2026-10-01", label: "Monthly Spend", basis: "plan", storedAmount: "400.00", amount: "574.50", incurred: "75.00", paid: "0.00", carried: "0.00", allowanceLeft: "499.50", carriedTo: null },
    { hook: "monthly", recurringItemId: MS, planKey: `${MS}|2026-11-01`, occurrenceDate: "2026-11-01", label: "Monthly Spend", basis: "plan", storedAmount: "400.00", amount: "620.00", incurred: "0.00", paid: "0.00", carried: "0.00", allowanceLeft: "620.00", carriedTo: null },
    { hook: "weekly", recurringItemId: WS, planKey: `${WS}|2026-10-17`, occurrenceDate: "2026-10-17", label: "Weekly Spend", basis: "stored_amount", storedAmount: "300.00", amount: "300.00", incurred: "50.00", paid: "40.00", carried: "0.00", allowanceLeft: "210.00", carriedTo: null },
    // Its unpaid purchases were carried into Oct 31: off the curve here.
    { hook: "weekly", recurringItemId: WS, planKey: `${WS}|2026-10-24`, occurrenceDate: "2026-10-24", label: "Weekly Spend", basis: "stored_amount", storedAmount: "300.00", amount: "0.00", incurred: "15.00", paid: "0.00", carried: "0.00", allowanceLeft: "0.00", carriedTo: "2026-10-31" },
    { hook: "weekly", recurringItemId: WS, planKey: `${WS}|2026-10-31`, occurrenceDate: "2026-10-31", label: "Weekly Spend", basis: "stored_amount", storedAmount: "300.00", amount: "315.00", incurred: "0.00", paid: "0.00", carried: "15.00", allowanceLeft: "300.00", carriedTo: null },
  ],
  events: [
    { date: "2026-10-17", label: "Weekly Spend", amount: "-260.00", itemId: WS, occurrenceKey: `${WS}|2026-10-17`, occurrenceDate: "2026-10-17" },
    { date: "2026-10-24", label: "Mortgage", amount: "-1650.00", itemId: "mort", occurrenceKey: "mort|2026-10-24", occurrenceDate: "2026-10-24" },
    { date: "2026-10-31", label: "Weekly Spend", amount: "-315.00", itemId: WS, occurrenceKey: `${WS}|2026-10-31`, occurrenceDate: "2026-10-31" },
    { date: "2026-11-01", label: "Monthly Spend", amount: "-574.50", itemId: MS, originalDate: "2026-11-01", occurrenceKey: `${MS}|2026-10-01`, occurrenceDate: "2026-10-01" },
    // ⭐ November's whole reserve: the ledger reads the legacy partial as not given.
    { date: "2026-11-01", label: "Monthly Spend", amount: "-620.00", itemId: MS, originalDate: "2026-11-01", occurrenceKey: `${MS}|2026-11-01`, occurrenceDate: "2026-11-01" },
  ],
  overdueAssumedPaid: [],
  matches: [],
};
// The curve's daily closes, walked from the opening over exactly those events.
const daily = (() => {
  const out: Array<{ rawDate: string; balance: number }> = [];
  let bal = 2400;
  for (let d = new Date(2026, 9, 14); d <= new Date(2026, 10, 12); d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    for (const e of signal.events) if (e.date === iso) bal = Math.round((bal + Number(e.amount)) * 100) / 100;
    out.push({ rawDate: iso, balance: bal });
  }
  return out;
})();

const build = (withCurve = true) =>
  buildLineRegister({
    events: bundleEvents,
    txns: [],
    resolutions,
    closedMonths: new Set(),
    startBalance: 2400,
    fromISO: "2026-09-01",
    toISO: "2026-11-12",
    today: new Date(2026, 9, 14),
    snapshotISO: "2026-10-14",
    visibleFromISO: "2026-10-14",
    matches: signal.matches,
    hookCurve: withCurve ? hookCurveOf(signal as never) : null,
  });
const planRows = (r: ReturnType<typeof build>) => r.rows.filter((x): x is PlanLine & { runningBalance?: number } => x.kind === "plan");
const keyOf = (p: PlanLine) => `${p.itemId}|${p.originalDate ?? p.date}`;

describe("(Task 4) register hook rows headline the curve's figure", () => {
  it("⭐ every hook row's amount = the curve's figure for its OWN occurrence (moved, two on one day); the mortgage keeps its own", () => {
    const rows = planRows(build());
    const byKey = Object.fromEntries(rows.map((p) => [keyOf(p), p.amount]));
    expect(byKey).toEqual({
      [`${WS}|2026-10-17`]: -260,
      [`${WS}|2026-10-24`]: 0,
      "mort|2026-10-24": -1650,
      [`${WS}|2026-10-31`]: -315,
      [`${MS}|2026-10-01`]: -574.5,
      [`${MS}|2026-11-01`]: -620,
    });
    // The curve's own figure for each hook row, by its key: the same number, to the cent.
    const curve = hookCurveOf(signal as never)!;
    for (const p of rows.filter((x) => x.hookCurve)) {
      expect(Math.round(p.amount * 100), keyOf(p)).toBe(Math.round((curve.amountByKey.get(keyOf(p)) ?? 0) * 100));
    }
    // The item's stored amount rides beside it, unchanged (a template); off the curve says so.
    expect(rows.find((p) => keyOf(p) === `${MS}|2026-11-01`)!.hookCurve).toEqual({ itemAmount: -400, onCurve: true });
    expect(rows.find((p) => keyOf(p) === `${WS}|2026-10-24`)!.hookCurve).toEqual({ itemAmount: -300, onCurve: false });
    expect(rows.find((p) => p.itemId === "mort")!.hookCurve).toBeUndefined();
  });

  it("⭐ a legacy partial on a hook decides nothing: November's row is an open occurrence at its whole reserve, never 'partly paid'", () => {
    const nov = build().allPlan.find((p) => keyOf(p) === `${MS}|2026-11-01`)!;
    expect(nov.status).toBe("future");
    expect(nov.amount).toBe(-620);
    expect(nov).not.toHaveProperty("plannedAmount");
    expect(nov).not.toHaveProperty("paidAmount");
    // The words name no partial: the parts of the curve's $620.
    const words = hookPayoffWords(hookLineOf(hookPayoffsOf(signal as never, () => "AMEX EPAYMENT ACH PMT"), nov)!, { face: Math.abs(nov.amount) });
    expect(words).toBe("Monthly Spend: card purchases $0.00 + left to spend $620.00");
    // A partial on a BILL still leaves its remainder (unchanged rule).
    const bill = buildLineRegister({
      events: [ev("gym", "2026-10-20", -45, "Gym")],
      txns: [],
      resolutions: [{ id: "g", recurringItemId: "gym", occurrenceDate: "2026-10-20", status: "partial", matchedTxnId: "tx-g", txnAmount: "-30.00" }],
      closedMonths: new Set(),
      startBalance: 0,
      fromISO: "2026-10-01",
      toISO: "2026-10-31",
      today: new Date(2026, 9, 14),
      hookCurve: hookCurveOf(signal as never),
    }).allPlan[0]!;
    expect([bill.status, bill.amount, bill.plannedAmount]).toEqual(["partial", -15, -45]);
  });

  it("⭐ for every day: Σ register rows that day = the day panel's outflows = the curve's step (no bank rows, no drags)", () => {
    const rows = planRows(build());
    const kinded = kindEvents(signal.events as never, new Map());
    const days = [...new Set(rows.map((p) => p.date))].sort();
    expect(days).toEqual(["2026-10-17", "2026-10-24", "2026-10-31", "2026-11-01"]);
    for (const day of days) {
      const register = rows.filter((p) => p.date === day).reduce((s, p) => s + Math.round(p.amount * 100), 0);
      const sum = daySummary(day, daily, kinded, { startingBalance: 2400 });
      const panel = Math.round((sum.outflows.bill + sum.outflows.card + sum.outflows.debt + sum.income) * 100);
      const step = Math.round((sum.close! - sum.opening!) * 100);
      expect([register, panel], day).toEqual([step, step]);
    }
    // Before Task 4 the Nov 1 rows read the stored −$400 twice: −$800 against a curve step of −$1,194.50.
    const before = planRows(build(false)).filter((p) => p.date === "2026-11-01").reduce((s, p) => s + p.amount, 0);
    expect(before).toBe(-400 + -400 + 85);
  });

  it("the register's running balance walks the curve's figures (a register with no bank rows)", () => {
    const rows = planRows(build());
    // The last row's running balance is the curve's close on its day.
    const last = rows[rows.length - 1]!;
    expect(last.runningBalance).toBe(daily.find((d) => d.rawDate === last.date)!.balance);
    expect(rows.map((p) => p.runningBalance)).toEqual([2140, 2140, 490, 175, -399.5, -1019.5]);
  });

  it("⭐ the register can never offer Partial on a hook: the server never pairs one, so no hook row carries a suggestion", () => {
    // The server's `matches` (forecastLedger: "a hook is a date, not a bill: it never competes for a row")
    // name bills only — even a row of the hook's exact figure is not paired. With a bill's pair present:
    const withBillPair = buildLineRegister({
      events: [...bundleEvents, ev("gym", "2026-10-20", -45, "Gym")],
      txns: [],
      resolutions: [],
      closedMonths: new Set(),
      startBalance: 2400,
      fromISO: "2026-09-01",
      toISO: "2026-11-12",
      today: new Date(2026, 9, 14),
      matches: [{ planKey: "gym|2026-10-20", planItemId: "gym", planDate: "2026-10-20", txnId: "tx-g", planAmount: "-45.00", txnAmount: "-30.00", difference: "-15.00", dayDelta: 0, confidence: "high", ambiguous: false, tier: 3, offCurve: false }],
      hookCurve: hookCurveOf(signal as never),
    });
    const hooks = withBillPair.allPlan.filter((p) => p.itemId === MS || p.itemId === WS);
    expect(hooks.length).toBeGreaterThan(0);
    for (const p of hooks) expect(p.probablyPaid, keyOf(p)).toBeUndefined();
    // Partial needs a pair (`canRecordPartial(row, pp)`): the bill has one and may answer Partial; no hook row has one.
    const gym = withBillPair.allPlan.find((p) => p.itemId === "gym")!;
    expect(canRecordPartial(gym, gym.probablyPaid!)).toBe(true);
  });

  it("without the curve's figures (no hooks, an older bundle) every line reads exactly as before", () => {
    const rows = planRows(build(false));
    expect(rows.every((p) => p.hookCurve === undefined)).toBe(true);
    expect(rows.find((p) => keyOf(p) === `${WS}|2026-10-17`)!.amount).toBe(-300);
    // …and the legacy partial is read as stored (the old register's reading).
    expect(build(false).allPlan.find((p) => keyOf(p) === `${MS}|2026-11-01`)!.status).toBe("partial");
  });
});

// ⭐ (PR-B2, owner decision 7) The everyday hooks' pure rule: the payoff for a
// period, and when a due payoff counts as paid. The forecast wiring is pinned
// by `everydayHooks.integration.test.ts` and the household scenario.

import { describe, expect, it } from "vitest";
import {
  accruedByCents,
  allocateHookPayments,
  capHookObligationsAtBalance,
  cardOwedNowCents,
  creditOutsideCardBalanceRead,
  hookOccurrenceAmounts,
  hookPeriodOf,
  namesCardIssuer,
  nextHookOccurrence,
  outsideCardBalanceRead,
  payoffFor,
  payoffsPaidBy,
  readEverydayHooks,
  type CardBalanceRead,
  type CardBalanceRow,
  type DuePayoff,
  type HookObligation,
  type HookOccurrenceFacts,
  type PayoffPaymentRow,
} from "@workspace/avalanche-core";

describe("readEverydayHooks — server-owned, read defensively", () => {
  it("reads both hooks", () => {
    expect(readEverydayHooks({ everydayHooks: { weekly: { recurringItemId: "w" }, monthly: { recurringItemId: "m" } } })).toEqual({
      weekly: { recurringItemId: "w" },
      monthly: { recurringItemId: "m" },
    });
  });
  it.each([
    ["no preferences", null],
    ["no key", { other: 1 }],
    ["null hooks", { everydayHooks: null }],
    ["an array", { everydayHooks: [] }],
    ["a bad id", { everydayHooks: { weekly: { recurringItemId: 7 }, monthly: { recurringItemId: "" } } }],
    ["explicit nulls", { everydayHooks: { weekly: null, monthly: null } }],
  ])("%s → no hook", (_n, prefs) => {
    expect(readEverydayHooks(prefs)).toEqual({ weekly: null, monthly: null });
  });
  it("one item can never hook both cadences: the weekly hook wins", () => {
    expect(readEverydayHooks({ everydayHooks: { weekly: { recurringItemId: "x" }, monthly: { recurringItemId: "x" } } })).toEqual({
      weekly: { recurringItemId: "x" },
      monthly: null,
    });
  });
});

describe("hookPeriodOf — the period an occurrence pays for", () => {
  it("weekly: the Sunday–Saturday week containing it (a Saturday hook = the week ending that day)", () => {
    expect(hookPeriodOf("weekly", "2026-10-10")).toEqual({ start: "2026-10-04", end: "2026-10-10" });
    expect(hookPeriodOf("weekly", "2026-10-03")).toEqual({ start: "2026-09-27", end: "2026-10-03" });
  });
  it("monthly: the calendar month containing it", () => {
    expect(hookPeriodOf("monthly", "2026-10-28")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(hookPeriodOf("monthly", "2026-02-28")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
});

describe("payoffFor — charges + what is left while the period is open", () => {
  const base = { chargesCents: 0, capCents: 30_000, spentCents: 0, periodEnd: "2026-10-10", todayISO: "2026-10-04" };

  it("(S1) nothing charged, nothing spent: the whole allowance — $300", () => {
    expect(payoffFor(base)).toEqual({ amountCents: 30_000, chargesCents: 0, remainingCents: 30_000, closed: false });
  });
  it("(S2) a weekly card charge moves money from remaining to charges: still $300", () => {
    expect(payoffFor({ ...base, chargesCents: 14_160, spentCents: 14_160 }).amountCents).toBe(30_000);
  });
  it("(S3) an unplanned card charge sits on top: $385", () => {
    expect(payoffFor({ ...base, chargesCents: 22_660, spentCents: 14_160 }).amountCents).toBe(38_500);
  });
  it("(S4) a checking debit tagged weekly shrinks the payoff by exactly its amount: $340", () => {
    const before = payoffFor({ ...base, chargesCents: 22_660, spentCents: 14_160 }).amountCents;
    const after = payoffFor({ ...base, chargesCents: 22_660, spentCents: 14_160 + 4_500 }).amountCents;
    expect(after).toBe(34_000);
    expect(before - after).toBe(4_500);
  });
  it("the period's last day is still open (today = Saturday)", () => {
    expect(payoffFor({ ...base, chargesCents: 100, todayISO: "2026-10-10" })).toMatchObject({ closed: false, amountCents: 30_100 });
  });
  it("a closed period owes its charges alone — nothing is left to spend in it", () => {
    expect(payoffFor({ ...base, chargesCents: 18_000, todayISO: "2026-10-11" })).toEqual({
      amountCents: 18_000,
      chargesCents: 18_000,
      remainingCents: 0,
      closed: true,
    });
  });
  it("overspent: remaining never goes below zero (the overspend is already in the charges)", () => {
    expect(payoffFor({ ...base, chargesCents: 40_000, spentCents: 40_000 })).toMatchObject({ remainingCents: 0, amountCents: 40_000 });
  });
  it("no cap: charges alone", () => {
    expect(payoffFor({ ...base, capCents: 0, chargesCents: 4_000 }).amountCents).toBe(4_000);
  });
});

describe("payoffsPaidBy — a due payoff is paid on evidence only", () => {
  const due = (key: string, occurrenceDate: string, amountCents: number, next = "2026-10-10"): DuePayoff => ({
    key,
    occurrenceDate,
    nextOccurrenceDate: next,
    amountCents,
  });
  const pay = (txnId: string, occurredOn: string, amount: number, description = "AMERICAN EXPRESS ACH PMT"): PayoffPaymentRow => ({
    txnId,
    occurredOn,
    amount,
    description,
  });

  it("(S3) the $180 Amex payment on Tue 10/6 pays the week that closed Sat 10/3", () => {
    expect(payoffsPaidBy([due("w|2026-10-03", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -180)]).get("w|2026-10-03")?.txnId).toBe("t");
  });
  it("(round 2) a payment that covers the payoff or MORE pays it; one smaller than owed (past max($1, 1%)) does not", () => {
    // Below: within the tolerance pays, past it does not (the payoff stays on the curve: low, never high).
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -178.2)]).size).toBe(1);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -178.19)]).size).toBe(0);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -100)]).size).toBe(0);
    expect(payoffsPaidBy([due("k", "2026-10-03", 300_000)], [pay("t", "2026-10-06", -2_970)]).size).toBe(1);
    // Above: no upper bound — the statement paid in full pays the week.
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -181.8)]).size).toBe(1);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -400)]).size).toBe(1);
  });
  it("only a payment dated from the occurrence up to (not including) the next one", () => {
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-02", -180)]).size).toBe(0);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-03", -180)]).size).toBe(1);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-10", -180)]).size).toBe(0);
  });
  it("only a row that names Amex, and only an outflow", () => {
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -180, "CAPITAL ONE CRCARDPMT")]).size).toBe(0);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", 180)]).size).toBe(0);
    expect(namesCardIssuer("AMEX EPAYMENT ACH PMT")).toBe(true);
    expect(namesCardIssuer("CAMEXICO TACOS")).toBe(false);
  });
  it("one row pays one occurrence: the older occurrence chooses first", () => {
    const out = payoffsPaidBy(
      [due("b", "2026-10-03", 18_000, "2026-10-10"), due("a", "2026-09-26", 18_000, "2026-10-03")],
      [pay("t1", "2026-09-29", -180), pay("t2", "2026-10-06", -180)],
    );
    expect(out.get("a")?.txnId).toBe("t1");
    expect(out.get("b")?.txnId).toBe("t2");
    expect(payoffsPaidBy([due("a", "2026-09-26", 18_000, "2026-10-10"), due("b", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -180)]).size).toBe(1);
  });
  it("a $0 payoff needs no payment and takes none", () => {
    expect(payoffsPaidBy([due("z", "2026-10-03", 0)], [pay("t", "2026-10-06", -1)]).size).toBe(0);
  });
});

describe("nextHookOccurrence — the window's end when no later occurrence is expanded", () => {
  it("weekly: seven days on; monthly: the same day next month, clamped", () => {
    expect(nextHookOccurrence("weekly", "2026-10-10")).toBe("2026-10-17");
    expect(nextHookOccurrence("monthly", "2026-10-28")).toBe("2026-11-28");
    expect(nextHookOccurrence("monthly", "2026-01-31")).toBe("2026-02-28");
    expect(nextHookOccurrence("monthly", "2026-12-15")).toBe("2027-01-15");
  });
});

// ── (F1) The obligations model.

const ob = (key: string, occurrenceDate: string, accountId: string, cents: number, cadence: "weekly" | "monthly" = "weekly"): HookObligation => ({
  key,
  cadence,
  occurrenceDate,
  accountId,
  cents,
});

describe("(F1) allocateHookPayments — one payment, allocated once, oldest obligation first", () => {
  it("a payment covering two weeks pays the older first, then the next; what is left of it pays nothing", () => {
    const out = allocateHookPayments(
      [ob("w|10-03", "2026-10-03", "plat", 8000), ob("w|10-10", "2026-10-10", "plat", 24000)],
      [{ txnId: "p", occurredOn: "2026-10-12", cents: 40000, accountId: null }],
    );
    expect(out).toEqual([
      { txnId: "p", key: "w|10-03", accountId: "plat", cents: 8000 },
      { txnId: "p", key: "w|10-10", accountId: "plat", cents: 24000 },
    ]);
  });

  it("partial payments add up; a payment never pays a week that has not closed on its date", () => {
    const out = allocateHookPayments(
      [ob("w|10-03", "2026-10-03", "plat", 13000), ob("w|10-10", "2026-10-10", "plat", 24000)],
      [
        { txnId: "a", occurredOn: "2026-10-05", cents: 5000, accountId: null },
        { txnId: "b", occurredOn: "2026-10-09", cents: 10000, accountId: null },
      ],
    );
    // b (10/9) cannot pay 10/10's week: 80 of it goes to 10/3's remaining 80, the 20 left pays nothing.
    expect(out).toEqual([
      { txnId: "a", key: "w|10-03", accountId: "plat", cents: 5000 },
      { txnId: "b", key: "w|10-03", accountId: "plat", cents: 8000 },
    ]);
  });

  it("a payment known to be one card's (a tag, the card's own ledger) pays only that card", () => {
    const out = allocateHookPayments(
      [ob("w|9-26", "2026-09-26", "gold", 3000), ob("w|9-26", "2026-09-26", "plat", 9000)],
      [{ txnId: "t", occurredOn: "2026-10-05", cents: 5000, accountId: "plat" }],
    );
    expect(out).toEqual([{ txnId: "t", key: "w|9-26", accountId: "plat", cents: 5000 }]);
  });

  it("order is stable: by date, weekly before monthly on a day, then the card; payments by date then id", () => {
    const out = allocateHookPayments(
      [ob("m|9-30", "2026-09-30", "blue", 5000, "monthly"), ob("w|9-30", "2026-09-30", "plat", 5000)],
      [
        { txnId: "z", occurredOn: "2026-10-01", cents: 6000, accountId: null },
        { txnId: "a", occurredOn: "2026-10-01", cents: 1000, accountId: null },
      ],
    );
    expect(out).toEqual([
      { txnId: "a", key: "w|9-30", accountId: "plat", cents: 1000 },
      { txnId: "z", key: "w|9-30", accountId: "plat", cents: 4000 },
      { txnId: "z", key: "m|9-30", accountId: "blue", cents: 2000 },
    ]);
  });

  it("a $0 obligation or payment takes part in nothing", () => {
    expect(allocateHookPayments([ob("w", "2026-10-03", "plat", 0)], [{ txnId: "p", occurredOn: "2026-10-05", cents: 100, accountId: null }])).toEqual([]);
    expect(allocateHookPayments([ob("w", "2026-10-03", "plat", 100)], [{ txnId: "p", occurredOn: "2026-10-05", cents: 0, accountId: null }])).toEqual([]);
  });
});

// ⭐ (F5 round 2) A PAYMENT'S LEFTOVER PAYS PURCHASES ALREADY MADE; A MATCHED ROW PAYS
// ITS WEEK FIRST; A CARD NEVER OWES MORE THAN ITS BALANCE.
describe("(F5 round 2) allocateHookPayments — the leftover pays purchases made on or before the payment", () => {
  const withRows = (key: string, occurrenceDate: string, rows: Array<[string, number]>, accountId = "plat"): HookObligation => ({
    ...ob(key, occurrenceDate, accountId, Math.max(0, rows.reduce((s, [, c]) => s + c, 0))),
    rows: rows.map(([on, cents]) => ({ on, cents })),
  });

  it("accruedByCents: the period's rows dated on or before the day, never below 0 nor above the obligation; all of it from the occurrence date", () => {
    const o = withRows("w|9-26", "2026-09-26", [["2026-09-21", 7000], ["2026-09-23", -2000], ["2026-09-24", 14000]]);
    expect([accruedByCents(o, "2026-09-20"), accruedByCents(o, "2026-09-22"), accruedByCents(o, "2026-09-23"), accruedByCents(o, "2026-09-25"), accruedByCents(o, "2026-09-26")]).toEqual([
      0, 7000, 5000, 19000, 19000,
    ]);
    // No rows: F1's rule — nothing before the occurrence date.
    expect([accruedByCents(ob("x", "2026-09-26", "plat", 5000), "2026-09-25"), accruedByCents(ob("x", "2026-09-26", "plat", 5000), "2026-09-26")]).toEqual([0, 5000]);
  });

  it("⭐ a statement-size payment pays the closed weeks, then the open week's purchases made before it — its leftover is no longer dropped", () => {
    const out = allocateHookPayments(
      [
        ob("w|9-12", "2026-09-12", "plat", 24000),
        ob("w|9-19", "2026-09-19", "plat", 13000),
        withRows("w|9-26", "2026-09-26", [["2026-09-21", 7000], ["2026-09-24", 14000]]),
      ],
      [{ txnId: "stmt", occurredOn: "2026-09-22", cents: 40000, accountId: null }],
    );
    expect(out).toEqual([
      { txnId: "stmt", key: "w|9-12", accountId: "plat", cents: 24000 },
      { txnId: "stmt", key: "w|9-19", accountId: "plat", cents: 13000 },
      // 30 left: only the 9/21 purchase (70) was made by 9/22, so 30 of it.
      { txnId: "stmt", key: "w|9-26", accountId: "plat", cents: 3000 },
    ]);
    // A later payment pays the rest of the week once it closes.
    const later = allocateHookPayments(
      [withRows("w|9-26", "2026-09-26", [["2026-09-21", 7000], ["2026-09-24", 14000]])],
      [
        { txnId: "a", occurredOn: "2026-09-22", cents: 10000, accountId: null },
        { txnId: "b", occurredOn: "2026-09-28", cents: 50000, accountId: null },
      ],
    );
    expect(later).toEqual([
      { txnId: "a", key: "w|9-26", accountId: "plat", cents: 7000 },
      { txnId: "b", key: "w|9-26", accountId: "plat", cents: 14000 },
    ]);
  });

  it("⭐ a row a matched answer tied to a week pays that week first, whatever its date; the rest of it pays the others (never thrown away)", () => {
    const out = allocateHookPayments(
      [ob("w|9-05", "2026-09-05", "plat", 8000), ob("w|9-12", "2026-09-12", "plat", 24000), ob("w|9-19", "2026-09-19", "plat", 13000)],
      [{ txnId: "m", occurredOn: "2026-09-22", cents: 52000, accountId: null, forKey: "w|9-19" }],
    );
    expect(out).toEqual([
      { txnId: "m", key: "w|9-19", accountId: "plat", cents: 13000 },
      { txnId: "m", key: "w|9-05", accountId: "plat", cents: 8000 },
      { txnId: "m", key: "w|9-12", accountId: "plat", cents: 24000 },
    ]);
    // A matched row smaller than its week pays part of it; the week's rest stays owed.
    expect(allocateHookPayments([ob("w|9-19", "2026-09-19", "plat", 13000)], [{ txnId: "m", occurredOn: "2026-09-20", cents: 5000, accountId: null, forKey: "w|9-19" }])).toEqual([
      { txnId: "m", key: "w|9-19", accountId: "plat", cents: 5000 },
    ]);
  });

  it("⭐ payment used once: Σ allocations of a payment never exceed it, and Σ over an obligation never exceeds it, whatever the mix", () => {
    const obligations = [
      ob("w|9-05", "2026-09-05", "plat", 12000),
      withRows("w|9-12", "2026-09-12", [["2026-09-08", 18000], ["2026-09-11", 6000]]),
      withRows("w|9-12", "2026-09-12", [["2026-09-09", 3000]], "gold"),
      withRows("w|9-19", "2026-09-19", [["2026-09-16", 13000]]),
    ];
    const payments = [
      { txnId: "a", occurredOn: "2026-09-10", cents: 50000, accountId: null },
      { txnId: "b", occurredOn: "2026-09-10", cents: 4000, accountId: "gold" },
      { txnId: "c", occurredOn: "2026-09-14", cents: 9000, accountId: null, forKey: "w|9-19" },
    ];
    const out = allocateHookPayments(obligations, payments);
    for (const p of payments) expect(out.filter((a) => a.txnId === p.txnId).reduce((s, a) => s + a.cents, 0)).toBeLessThanOrEqual(p.cents);
    for (const o of obligations) expect(out.filter((a) => a.key === o.key && a.accountId === o.accountId).reduce((s, a) => s + a.cents, 0)).toBeLessThanOrEqual(o.cents);
  });
});

describe("⭐ (F5 round 2) capHookObligationsAtBalance — a card's carried + current unpaid never exceeds what the card owes", () => {
  it("cuts the unpaid down to the cap, oldest first; a card with no cap is untouched; a paid obligation is never cut", () => {
    const obligations = [
      ob("w|9-26", "2026-09-26", "plat", 21000),
      ob("w|10-03", "2026-10-03", "plat", 18000),
      ob("w|10-10", "2026-10-10", "plat", 26000),
      ob("w|10-17", "2026-10-17", "plat", 9000),
      ob("w|10-10", "2026-10-10", "gold", 5000),
    ];
    const allocations = [{ txnId: "p", key: "w|9-26", accountId: "plat", cents: 21000 }];
    // Unpaid on plat: 180 + 260 + 90 = 530; the card says it owes 300 → cut 230: 10/3's 180, then 50 of 10/10.
    expect(capHookObligationsAtBalance(obligations, allocations, new Map([["plat", 30000]]))).toEqual([
      { txnId: "", key: "w|10-03", accountId: "plat", cents: 18000 },
      { txnId: "", key: "w|10-10", accountId: "plat", cents: 5000 },
    ]);
    // Under the cap, or no cap: nothing.
    expect(capHookObligationsAtBalance(obligations, allocations, new Map([["plat", 60000]]))).toEqual([]);
    expect(capHookObligationsAtBalance(obligations, allocations, new Map())).toEqual([]);
    // A card that owes nothing (or a credit balance): every unpaid purchase is cut.
    expect(capHookObligationsAtBalance(obligations, allocations, new Map([["gold", -2500]]))).toEqual([{ txnId: "", key: "w|10-10", accountId: "gold", cents: 5000 }]);
  });

  it("hookOccurrenceAmounts: the cut is off the curve and out of incurred / carried; own = incurred + paid + capped", () => {
    const a = hookOccurrenceAmounts(
      [
        { key: "a", itemId: "w", occurrenceDate: "2026-10-03", periodEnd: "2026-10-03", capCents: null, storedCents: 30000, spentCents: 0, ownCents: 18000, paidCents: 0, cappedCents: 18000, due: true, settled: false, partial: false },
        { key: "b", itemId: "w", occurrenceDate: "2026-10-10", periodEnd: "2026-10-10", capCents: null, storedCents: 30000, spentCents: 0, ownCents: 26000, paidCents: 2000, cappedCents: 5000, due: true, settled: false, partial: false },
      ],
      "2026-10-14",
    );
    expect(a.get("a")).toMatchObject({ incurredCents: 0, cappedCents: 18000, carriedTo: null, curveCents: 0, amountCents: 0 });
    expect(a.get("b")).toMatchObject({ incurredCents: 19000, paidCents: 2000, cappedCents: 5000, carriedCents: 0, curveCents: 19000, amountCents: 21000 });
  });
});

// ⭐ (F5 round 3) A MONTH'S PURCHASES ARE PAID ONLY BY PAYMENTS MADE AFTER THEM; A
// PAYMENT BEFORE THE WINDOW PAYS NOTHING IN IT.
describe("(F5 round 3) allocateHookPayments — accrual by the rows, whatever the occurrence date", () => {
  const monthly = (key: string, occurrenceDate: string, periodEnd: string, rows: Array<[string, number]>, accountId = "gold"): HookObligation => ({
    ...ob(key, occurrenceDate, accountId, Math.max(0, rows.reduce((s, [, c]) => s + c, 0)), "monthly"),
    periodEnd,
    rows: rows.map(([on, cents]) => ({ on, cents })),
  });

  it("⭐ a monthly occurrence is dated the 1st: a payment on 10/2 pays September, never October's 10/5 and 10/12 purchases", () => {
    const obligations = [
      monthly("m|9-01", "2026-09-01", "2026-09-30", [["2026-09-10", 50000]]),
      monthly("m|10-01", "2026-10-01", "2026-10-31", [["2026-10-05", 10000], ["2026-10-12", 20000]]),
    ];
    // Round 2 paid 500 + 300 (the whole October) from a 10/2 payment.
    expect(allocateHookPayments(obligations, [{ txnId: "p", occurredOn: "2026-10-02", cents: 80000, accountId: null }])).toEqual([
      { txnId: "p", key: "m|9-01", accountId: "gold", cents: 50000 },
    ]);
    // Paid on 10/13: what had been bought by then (100 + 200).
    expect(allocateHookPayments(obligations, [{ txnId: "p", occurredOn: "2026-10-13", cents: 80000, accountId: null }])).toEqual([
      { txnId: "p", key: "m|9-01", accountId: "gold", cents: 50000 },
      { txnId: "p", key: "m|10-01", accountId: "gold", cents: 30000 },
    ]);
    // accruedByCents: by the rows; with no rows, nothing before the period's END.
    expect([accruedByCents(obligations[1]!, "2026-10-01"), accruedByCents(obligations[1]!, "2026-10-06"), accruedByCents(obligations[1]!, "2026-11-02")]).toEqual([0, 10000, 30000]);
    const noRows: HookObligation = { ...ob("m", "2026-10-01", "gold", 30000, "monthly"), periodEnd: "2026-10-31" };
    expect([accruedByCents(noRows, "2026-10-02"), accruedByCents(noRows, "2026-10-31")]).toEqual([0, 30000]);
    // A weekly week is unchanged: by 10/13, 100 of its 300.
    const week: HookObligation = { ...ob("w", "2026-10-17", "plat", 30000), periodEnd: "2026-10-17", rows: [{ on: "2026-10-12", cents: 10000 }, { on: "2026-10-15", cents: 20000 }] };
    expect(accruedByCents(week, "2026-10-13")).toBe(10000);
  });

  it("⭐ a payment dated before the earliest sized occurrence of its cadence pays nothing in the window (it paid the statement before); from then on, the usual rule", () => {
    // The window's first Saturday is 9/5 (week 8/30–9/5); an 8/31 purchase is in it.
    const first: HookObligation = { ...ob("w|9-05", "2026-09-05", "plat", 10000), periodEnd: "2026-09-05", rows: [{ on: "2026-08-31", cents: 10000 }] };
    const opts = { firstOccurrence: { weekly: "2026-09-05" } };
    expect(allocateHookPayments([first], [{ txnId: "pre", occurredOn: "2026-09-01", cents: 60000, accountId: "plat" }], opts)).toEqual([]);
    // Without the window's start (an older caller): accrual pays it, as round 2 did.
    expect(allocateHookPayments([first], [{ txnId: "pre", occurredOn: "2026-09-01", cents: 60000, accountId: "plat" }])).toEqual([
      { txnId: "pre", key: "w|9-05", accountId: "plat", cents: 10000 },
    ]);
    // On or after the first occurrence: the closed week in full, then accrual.
    const second: HookObligation = { ...ob("w|9-12", "2026-09-12", "plat", 24000), periodEnd: "2026-09-12", rows: [{ on: "2026-09-06", cents: 4000 }, { on: "2026-09-10", cents: 20000 }] };
    expect(allocateHookPayments([first, second], [{ txnId: "p", occurredOn: "2026-09-07", cents: 60000, accountId: null }], opts)).toEqual([
      { txnId: "p", key: "w|9-05", accountId: "plat", cents: 10000 },
      { txnId: "p", key: "w|9-12", accountId: "plat", cents: 4000 },
    ]);
    // The other cadence's window is its own; a matched answer still ties its row.
    const m: HookObligation = { ...ob("m|9-01", "2026-09-01", "gold", 5000, "monthly"), periodEnd: "2026-09-30", rows: [{ on: "2026-09-01", cents: 5000 }] };
    expect(allocateHookPayments([first, m], [{ txnId: "q", occurredOn: "2026-09-02", cents: 9000, accountId: null }], { firstOccurrence: { weekly: "2026-09-05", monthly: "2026-09-01" } })).toEqual([
      { txnId: "q", key: "m|9-01", accountId: "gold", cents: 5000 },
    ]);
    expect(allocateHookPayments([first], [{ txnId: "pre", occurredOn: "2026-09-01", cents: 3000, accountId: "plat", forKey: "w|9-05" }], opts)).toEqual([
      { txnId: "pre", key: "w|9-05", accountId: "plat", cents: 3000 },
    ]);
  });
});

// ⭐ (F5 round 3) WHAT THE CARD OWES NOW: THE BALANCE READ, ROLLED FORWARD BY THE
// INSTANT — one rule for purchases and payment credits. (Round 4) The instant
// counts only on a read right after a sync (`pendingAtRead` kept); a leftover
// pending copy kept at the read never moves its posted twin.
describe("⭐ (F5 round 3/4) cardOwedNowCents / outsideCardBalanceRead — which rows the balance held", () => {
  /** `synced`: a read right after a sync keeps the pending ids (`[]`: none pending); `read()`: any other read (null). */
  const read = (pendingAtRead: string[] | null = null): CardBalanceRead => ({
    balanceCents: 28500,
    asOf: "2026-10-14T12:00:00.000Z", // 07:00 Central
    asOfDay: "2026-10-14",
    pendingAtRead: pendingAtRead ? new Set(pendingAtRead) : null,
  });
  const synced = (ids: string[] = []) => read(ids);
  const r = (txnId: string, on: string, cents: number, more: Partial<CardBalanceRow> = {}): CardBalanceRow => ({ txnId, on, cents, pending: false, createdAt: `${on}T05:00:00.000Z`, ...more });

  it("any read: pending now and dated after the read's day are outside; posted on or before it, inside", () => {
    for (const at of [read(), synced()]) {
      expect(outsideCardBalanceRead(r("a", "2026-10-13", 3500), at)).toBe(false);
      expect(outsideCardBalanceRead(r("a", "2026-10-13", 3500, { pending: true }), at)).toBe(true);
      expect(outsideCardBalanceRead(r("a", "2026-10-15", 3500), at)).toBe(true);
    }
  });

  it("⭐ a read right after a sync: a row pending at it (posted in place since) or stored after it is outside", () => {
    const at = synced(["p11"]);
    // Re-keyed in place: same id, posted now, dated the read day, stored long before.
    expect(outsideCardBalanceRead(r("p11", "2026-10-14", 3500, { createdAt: "2026-10-13T05:00:00.000Z" }), at)).toBe(true);
    // The review's probe: pending at a 07:00 read, posted later that day as a new row, dated the read day.
    expect(outsideCardBalanceRead(r("b", "2026-10-14", 3500, { createdAt: "2026-10-14T19:00:00.000Z" }), at)).toBe(true);
    expect(outsideCardBalanceRead(r("b", "2026-10-14", 3500, { createdAt: "2026-10-14T11:00:00.000Z" }), at)).toBe(false);
    // Unknown store time: the day decides.
    expect(outsideCardBalanceRead(r("b", "2026-10-14", 3500, { createdAt: null }), at)).toBe(false);
  });

  it("⭐ (round 4, review defect 2) any other read (null: a debt's Refresh, a link): the day decides alone — a row stored after it, or one H2 still shows posted that was pending then, reads inside", () => {
    const at = read();
    expect(outsideCardBalanceRead(r("b", "2026-10-14", 3500, { createdAt: "2026-10-14T19:00:00.000Z" }), at)).toBe(false);
    // The review's probe D: a payment credit the balance already held, stored by H2 at 09:00 after a 07:00 read.
    expect(outsideCardBalanceRead(r("kP5", "2026-10-14", 15000, { createdAt: "2026-10-14T14:00:00.000Z" }), at)).toBe(false);
    // (Round 5) …but as a payment credit it reads outside (`creditOutsideCardBalanceRead`): the cap may read LOW by it
    // until the next Sync — never over (the round-3 reviews' probe D gives way to the round-4 reviews' "never over").
    expect(creditOutsideCardBalanceRead(r("kP5", "2026-10-14", 15000, { createdAt: "2026-10-14T14:00:00.000Z" }), at)).toBe(true);
  });

  it("⭐ (round 5, both reviews) never over: on a read that kept no list, a PAYMENT CREDIT stored after it is outside (within the in-flight window); a purchase keeps the day rule", () => {
    const at = read(); // a debt's Refresh at 07:00 Central
    // The reviews' probe: Refresh at 07:00 (150), the household pays 100 at 10:00, the card credit (dated 10/14) stored 10:30.
    const credit = r("kPay", "2026-10-14", 10000, { createdAt: "2026-10-14T15:30:00.000Z" });
    expect(outsideCardBalanceRead(credit, at)).toBe(false); // the day alone (round 4)
    expect(creditOutsideCardBalanceRead(credit, at)).toBe(true);
    expect(cardOwedNowCents({ ...at, balanceCents: 15000 }, [], [credit], 3000)).toBe(2000); // round 4: 12000, 100 over the 20 owed
    // A credit dated the day before, stored after the read (Plaid dates it when it was sent): outside too.
    expect(creditOutsideCardBalanceRead(r("k", "2026-10-13", 3000, { createdAt: "2026-10-14T15:30:00.000Z" }), at)).toBe(true);
    // Stored before the read: the balance held it.
    expect(creditOutsideCardBalanceRead(r("k", "2026-10-14", 3000, { createdAt: "2026-10-14T11:00:00.000Z" }), at)).toBe(false);
    // History arriving late (a link, a backfill): older than the in-flight window (read day − 5) stays inside.
    expect(creditOutsideCardBalanceRead(r("k", "2026-10-09", 3000, { createdAt: "2026-10-14T15:30:00.000Z" }), at)).toBe(true);
    expect(creditOutsideCardBalanceRead(r("k", "2026-10-08", 3000, { createdAt: "2026-10-14T15:30:00.000Z" }), at)).toBe(false);
    // Unknown store time: the day decides.
    expect(creditOutsideCardBalanceRead(r("k", "2026-10-14", 3000, { createdAt: null }), at)).toBe(false);
    // A PURCHASE stored after the same read keeps the day rule: inside (the cap can only read low by it).
    expect(cardOwedNowCents({ ...at, balanceCents: 15000 }, [r("p", "2026-10-14", 3500, { createdAt: "2026-10-14T15:30:00.000Z" })], [], 3000)).toBe(12000);
    // A Sync's read is unchanged: stored after it is outside, whatever its date.
    expect(creditOutsideCardBalanceRead(r("k", "2026-10-01", 3000, { createdAt: "2026-10-14T15:30:00.000Z" }), synced())).toBe(true);
  });

  it("⭐ (round 6, review P2 / A) a REFUND reads by the credit rule: stored after a read that kept no Sync list, it is outside — never over; a purchase keeps the day rule", () => {
    const at = { ...read(), balanceCents: 15000 }; // a debt's Refresh at 07:00 Central reads 150; 30 in flight
    // P2: a +20 refund dated 10/14, stored 10:30 (after the read) → 150 − 20 − 30 = 100 (round 5: inside by the day, 120 — 20 over).
    const refund = r("rf", "2026-10-14", -2000, { createdAt: "2026-10-14T15:30:00.000Z" });
    expect(outsideCardBalanceRead(refund, at)).toBe(false); // the day alone (round 5)
    expect(creditOutsideCardBalanceRead(refund, at)).toBe(true);
    expect(cardOwedNowCents(at, [refund], [], 3000)).toBe(10000);
    // Dated 10/12 (the merchant's date), stored after the read: outside too.
    expect(cardOwedNowCents(at, [{ ...refund, on: "2026-10-12" }], [], 3000)).toBe(10000);
    // Probe A: a 40 refund stored 11:30 → 150 − 40 − 30 = 80 (round 5: 120, 40 over).
    expect(cardOwedNowCents(at, [{ ...refund, cents: -4000, createdAt: "2026-10-14T16:30:00.000Z" }], [], 3000)).toBe(8000);
    // Stored before the read: the balance held it — inside.
    expect(cardOwedNowCents(at, [{ ...refund, createdAt: "2026-10-14T11:00:00.000Z" }], [], 3000)).toBe(12000);
    // A purchase stored after the same read keeps the day rule: inside (the cap can only read low by it).
    expect(cardOwedNowCents(at, [r("p", "2026-10-14", 3500, { createdAt: "2026-10-14T15:30:00.000Z" })], [], 3000)).toBe(12000);
    // A Sync's read: the store time decides, as before.
    expect(cardOwedNowCents({ ...synced(), balanceCents: 15000 }, [refund], [], 3000)).toBe(10000);
  });

  it("⭐ (round 6, review P1 / B) a payment credit or refund PENDING at a read that kept no Sync list is outside, even after it posts in place; purchases keep the day rule; a stale flag reads low", () => {
    // P1 / B: a Refresh at 07:00 reads 150 (posted rows only) while H2 holds a pending +100 payment credit (stored 10/13 15:00).
    // The webhook sync posts it in place at 11:00: same row, same store time, dated 10/14 (or 10/13).
    const at: CardBalanceRead = { ...read(), balanceCents: 15000, pendingAtOtherRead: new Set(["kPay", "rf", "p"]) };
    for (const on of ["2026-10-14", "2026-10-13"]) {
      const posted = r("kPay", on, 10000, { createdAt: "2026-10-13T20:00:00.000Z" });
      expect(creditOutsideCardBalanceRead(posted, { ...at, pendingAtOtherRead: null })).toBe(false); // round 5: inside
      expect(creditOutsideCardBalanceRead(posted, at)).toBe(true);
      expect([on, cardOwedNowCents(at, [], [posted], 3000)]).toEqual([on, 2000]); // round 5: 12000, 100 over the 20 owed
    }
    // A refund pending at the read, posted in place since: outside too (150 − 20 − 30).
    expect(cardOwedNowCents(at, [r("rf", "2026-10-13", -2000, { createdAt: "2026-10-13T20:00:00.000Z" })], [], 3000)).toBe(10000);
    // A purchase on the list keeps the day rule: inside.
    expect(cardOwedNowCents(at, [r("p", "2026-10-13", 3500, { createdAt: "2026-10-13T20:00:00.000Z" })], [], 3000)).toBe(12000);
    // Not on the list, stored before the read: inside (the balance held it).
    expect(cardOwedNowCents(at, [], [r("k", "2026-10-13", 10000, { createdAt: "2026-10-13T20:00:00.000Z" })], 3000)).toBe(12000);
    // Older than the in-flight window: still outside when it was pending at the read.
    expect(creditOutsideCardBalanceRead(r("kPay", "2026-10-01", 10000, { createdAt: "2026-10-01T20:00:00.000Z" }), at)).toBe(true);
    // A Sync's read reads its own list (pendingAtRead) for every row; the other list never applies to it.
    expect(creditOutsideCardBalanceRead(r("kPay", "2026-10-13", 10000, { createdAt: "2026-10-13T20:00:00.000Z" }), { ...at, pendingAtRead: new Set() })).toBe(false);
    // Stale flag (the 150 already held the credit H2 still showed pending): subtracted anyway — the cap reads LOW, allowed.
    expect(cardOwedNowCents({ ...at, balanceCents: 5000 }, [], [r("kPay", "2026-10-12", 10000, { createdAt: "2026-10-12T20:00:00.000Z" })], 0)).toBe(0);
  });

  it("⭐ (round 4, review defect 1) a leftover pending copy kept at the read never puts its posted twin outside the balance", () => {
    // p8pending (10/8) stays pending beside its posted twin p8 (10/9, stored 10/9): the balance holds p8.
    expect(outsideCardBalanceRead(r("p8", "2026-10-09", 6000), synced(["p8pending"]))).toBe(false);
    // The same for a payment credit's leftover pending copy.
    expect(outsideCardBalanceRead(r("kP4", "2026-10-08", 15000), synced(["kP4pend"]))).toBe(false);
    // A twin stored AFTER the read is outside by its store time.
    expect(outsideCardBalanceRead(r("p8b", "2026-10-14", 6000, { createdAt: "2026-10-14T19:00:00.000Z" }), synced(["p8pending"]))).toBe(true);
  });

  it("⭐ the card owes: balance + purchases outside − credits outside − in flight; pending credits read like pending purchases", () => {
    // The review's probe A: balance 285 read 07:00 right after a sync, FUEL STOP 35 pending, then posted dated 10/14 after the read; 30 in flight.
    const pendingFuel = [r("p11", "2026-10-13", 3500, { pending: true })];
    const postedFuel = [r("p11b", "2026-10-14", 3500, { createdAt: "2026-10-14T19:00:00.000Z" })];
    expect(cardOwedNowCents(read(), pendingFuel, [], 3000)).toBe(29000);
    expect(cardOwedNowCents(synced(["p11"]), postedFuel, [], 3000)).toBe(29000);
    expect(cardOwedNowCents(synced(["p11"]), [r("p11", "2026-10-14", 3500, { createdAt: "2026-10-13T05:00:00.000Z" })], [], 3000)).toBe(29000);
    // Not right after a sync: the day decides (inside) — 285 − 30, until the next Sync.
    expect(cardOwedNowCents(read(), postedFuel, [], 3000)).toBe(25500);
    // Probe B: balance 320 (posted only); the card shows the 30 payment as a PENDING credit → 290, not 320.
    const at320 = { ...read(), balanceCents: 32000 };
    expect(cardOwedNowCents(at320, [], [r("k", "2026-10-13", 3000, { pending: true })], 0)).toBe(29000);
    // The same credit posted before the read is inside the 320 already.
    expect(cardOwedNowCents(at320, [], [r("k", "2026-10-13", 3000)], 0)).toBe(32000);
    // A credit pending at a synced read that posted in place since, or stored after a synced read: outside.
    expect(cardOwedNowCents({ ...at320, pendingAtRead: new Set(["k"]) }, [], [r("k", "2026-10-13", 3000)], 0)).toBe(29000);
    expect(cardOwedNowCents({ ...at320, pendingAtRead: new Set() }, [], [r("k", "2026-10-14", 3000, { createdAt: "2026-10-14T20:00:00.000Z" })], 0)).toBe(29000);
    // ⭐ (round 5) …and stored after any other read: outside too — never over (round 4: inside, 32000 — H2 held the payment again).
    expect(cardOwedNowCents(at320, [], [r("k", "2026-10-14", 3000, { createdAt: "2026-10-14T20:00:00.000Z" })], 0)).toBe(29000);
    // Second review's probe: the 10/8 +150 credit still pending, balance 300 (posted only), 30 in flight → 120.
    expect(cardOwedNowCents({ ...read(), balanceCents: 30000 }, [], [r("kP4", "2026-10-08", 15000, { pending: true })], 3000)).toBe(12000);
    // ⭐ (round 4) leftover pending copies kept at a synced read (balance 150): 150 − 30 = 120 — round 3: 180 (purchase twin), 30 (credit twin too).
    const p8 = [r("p8", "2026-10-09", 6000)];
    const kP4 = [r("kP4", "2026-10-08", 15000)];
    expect(cardOwedNowCents({ ...synced(["p8pending"]), balanceCents: 15000 }, p8, [], 3000)).toBe(12000);
    expect(cardOwedNowCents({ ...synced(["kP4pend", "p8pending"]), balanceCents: 15000 }, p8, kP4, 3000)).toBe(12000);
    // A refund outside the balance lowers it; never below 0.
    expect(cardOwedNowCents(read(), [r("rf", "2026-10-15", -2000)], [], 0)).toBe(26500);
    expect(cardOwedNowCents({ ...read(), balanceCents: 1000 }, [], [r("k", "2026-10-15", 5000)], 0)).toBe(0);
  });
});

describe("(F1) hookOccurrenceAmounts — incurred + carried + allowance left", () => {
  const f = (o: Partial<HookOccurrenceFacts> & { key: string; occurrenceDate: string; periodEnd: string }): HookOccurrenceFacts => ({
    itemId: "ws",
    capCents: null,
    storedCents: 45000,
    spentCents: 0,
    ownCents: 0,
    paidCents: 0,
    due: false,
    settled: false,
    partial: false,
    ...o,
  });
  const TODAY = "2026-10-14";

  it("with a plan: open → max(0, cap − spent); closed → 0; future → the cap", () => {
    const a = hookOccurrenceAmounts(
      [
        f({ key: "c", occurrenceDate: "2026-10-10", periodEnd: "2026-10-10", capCents: 30000, ownCents: 24000, due: true }),
        f({ key: "o", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", capCents: 15000, spentCents: 18000, ownCents: 12000 }),
        f({ key: "u", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", capCents: 30000, spentCents: 18000, ownCents: 12000, itemId: "x" }),
        f({ key: "n", occurrenceDate: "2026-10-24", periodEnd: "2026-10-24", capCents: 30000 }),
      ],
      TODAY,
    );
    expect([...a.entries()].map(([k, v]) => [k, v.amountCents, v.allowanceLeftCents, v.curveCents, v.closed])).toEqual([
      ["c", 24000, 0, 24000, true],
      ["o", 12000, 0, 12000, false],
      ["u", 24000, 12000, 24000, false],
      ["n", 30000, 30000, 30000, false],
    ]);
  });

  it("with no plan: the stored amount less the period's own purchases (never below 0) while open; closed → its purchases only", () => {
    const a = hookOccurrenceAmounts(
      [
        f({ key: "c", occurrenceDate: "2026-10-10", periodEnd: "2026-10-10", ownCents: 12000, due: true }),
        f({ key: "o", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", ownCents: 12000 }),
        f({ key: "big", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", ownCents: 50000, itemId: "y" }),
      ],
      TODAY,
    );
    expect([...a.values()].map((v) => [v.amountCents, v.allowanceLeftCents])).toEqual([
      [12000, 0],
      [45000, 33000],
      [50000, 0],
    ]);
  });

  it("⭐ the latest due, unanswered occurrence carries every earlier unpaid one; each obligation once (Σ amount = Σ own + Σ left)", () => {
    const facts = [
      f({ key: "9-26", occurrenceDate: "2026-09-26", periodEnd: "2026-09-26", ownCents: 12000, paidCents: 12000, due: true }),
      f({ key: "10-03", occurrenceDate: "2026-10-03", periodEnd: "2026-10-03", ownCents: 13000, paidCents: 8000, due: true }),
      f({ key: "10-10", occurrenceDate: "2026-10-10", periodEnd: "2026-10-10", ownCents: 24000, due: true }),
      f({ key: "10-17", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", ownCents: 12000 }),
    ];
    const a = hookOccurrenceAmounts(facts, TODAY);
    expect(a.get("10-03")).toMatchObject({ incurredCents: 5000, paidCents: 8000, carriedTo: "10-10", amountCents: 8000, curveCents: 0 });
    expect(a.get("10-10")).toMatchObject({ incurredCents: 24000, carriedCents: 5000, carriedFrom: [{ key: "10-03", occurrenceDate: "2026-10-03", cents: 5000 }], amountCents: 29000, curveCents: 29000 });
    expect(a.get("9-26")).toMatchObject({ carriedTo: null, amountCents: 12000, curveCents: 0 });
    const sumAmount = [...a.values()].reduce((s, v) => s + v.amountCents, 0);
    const sumOwn = facts.reduce((s, x) => s + x.ownCents, 0);
    const sumLeft = [...a.values()].reduce((s, v) => s + v.allowanceLeftCents, 0);
    expect(sumAmount).toBe(sumOwn + sumLeft);
    // On the curve: the due unpaid once (290) + this week.
    expect([...a.values()].reduce((s, v) => s + v.curveCents, 0)).toBe(29000 + 45000);
  });

  it("⭐ (F5) a missed / skipped answer closes the RESERVE, never the purchases: answered weeks carry and the latest due one carries them, even when every due week is answered", () => {
    // The live shape: every due week answered, the open week not due.
    const facts = [
      f({ key: "a", occurrenceDate: "2026-09-26", periodEnd: "2026-09-26", ownCents: 10000, due: true, reserveClosed: true }),
      f({ key: "b", occurrenceDate: "2026-10-03", periodEnd: "2026-10-03", ownCents: 20000, paidCents: 5000, due: true, reserveClosed: true }),
      f({ key: "c", occurrenceDate: "2026-10-10", periodEnd: "2026-10-10", ownCents: 30000, due: true, reserveClosed: true }),
      f({ key: "d", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", ownCents: 5000 }),
    ];
    const a = hookOccurrenceAmounts(facts, TODAY);
    expect(a.get("a")).toMatchObject({ incurredCents: 10000, carriedTo: "c", curveCents: 0 });
    expect(a.get("b")).toMatchObject({ incurredCents: 15000, paidCents: 5000, carriedTo: "c", curveCents: 0 });
    expect(a.get("c")).toMatchObject({ incurredCents: 30000, carriedCents: 25000, carriedTo: null, curveCents: 55000, allowanceLeftCents: 0 });
    expect(a.get("d")).toMatchObject({ carriedCents: 0, curveCents: 45000, allowanceLeftCents: 40000 });
    // Σ curve = Σ own − Σ paid + Σ allowance left: every unpaid purchase once.
    const sumCurve = [...a.values()].reduce((s, v) => s + v.curveCents, 0);
    expect(sumCurve).toBe(65000 - 5000 + 40000);
    // The same facts unanswered give the same purchases on the curve (only the reserve differs: none left on a closed week).
    const unanswered = hookOccurrenceAmounts(facts.map((x) => ({ ...x, reserveClosed: false })), TODAY);
    expect([...unanswered.values()].map((v) => v.curveCents)).toEqual([...a.values()].map((v) => v.curveCents));
  });

  it("(F5) a missed / skipped answer on the OPEN or a future period drops what is left of its allowance, never its purchases so far", () => {
    const a = hookOccurrenceAmounts(
      [
        f({ key: "open", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", ownCents: 9000, reserveClosed: true }),
        f({ key: "plan", occurrenceDate: "2026-10-17", periodEnd: "2026-10-17", capCents: 30000, spentCents: 5000, ownCents: 9000, reserveClosed: true, itemId: "x" }),
        f({ key: "future", occurrenceDate: "2026-10-24", periodEnd: "2026-10-24", reserveClosed: true }),
      ],
      TODAY,
    );
    expect([...a.values()].map((v) => [v.curveCents, v.allowanceLeftCents])).toEqual([
      [9000, 0],
      [9000, 0],
      [0, 0],
    ]);
  });

  it("a matched (settled) occurrence never carries nor is carried; a partial one keeps its own amount; carry stays within one hook item", () => {
    const a = hookOccurrenceAmounts(
      [
        f({ key: "a", occurrenceDate: "2026-09-26", periodEnd: "2026-09-26", ownCents: 1000, due: true, settled: true }),
        f({ key: "b", occurrenceDate: "2026-10-03", periodEnd: "2026-10-03", ownCents: 2000, due: true, partial: true }),
        f({ key: "c", occurrenceDate: "2026-10-03", periodEnd: "2026-10-31", ownCents: 4000, due: true, itemId: "monthly" }),
        f({ key: "d", occurrenceDate: "2026-10-10", periodEnd: "2026-10-10", ownCents: 3000, due: true }),
      ],
      TODAY,
    );
    expect(a.get("d")).toMatchObject({ carriedCents: 0, amountCents: 3000 });
    expect(a.get("b")).toMatchObject({ carriedTo: null, amountCents: 2000 });
    expect(a.get("c")).toMatchObject({ carriedTo: null, carriedCents: 0 });
  });
});

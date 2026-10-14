// ⭐ (PR-B2, owner decision 7) The everyday hooks' pure rule: the payoff for a
// period, and when a due payoff counts as paid. The forecast wiring is pinned
// by `everydayHooks.integration.test.ts` and the household scenario.

import { describe, expect, it } from "vitest";
import {
  allocateHookPayments,
  hookOccurrenceAmounts,
  hookPeriodOf,
  namesCardIssuer,
  nextHookOccurrence,
  payoffFor,
  payoffsPaidBy,
  readEverydayHooks,
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

  it("an answered occurrence never carries nor is carried; a partial one keeps its own amount; carry stays within one hook item", () => {
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

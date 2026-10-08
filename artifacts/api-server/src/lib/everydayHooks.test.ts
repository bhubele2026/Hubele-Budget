// ⭐ (PR-B2, owner decision 7) The everyday hooks' pure rule: the payoff for a
// period, and when a due payoff counts as paid. The forecast wiring is pinned
// by `everydayHooks.integration.test.ts` and the household scenario.

import { describe, expect, it } from "vitest";
import {
  hookPeriodOf,
  namesCardIssuer,
  nextHookOccurrence,
  payoffFor,
  payoffsPaidBy,
  readEverydayHooks,
  type DuePayoff,
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
  it("within max($1, 1%) either way pays it; beyond does not (the payoff stays on the curve: low, never high)", () => {
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -181.8)]).size).toBe(1);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -178.19)]).size).toBe(0);
    expect(payoffsPaidBy([due("k", "2026-10-03", 18_000)], [pay("t", "2026-10-06", -400)]).size).toBe(0);
    expect(payoffsPaidBy([due("k", "2026-10-03", 300_000)], [pay("t", "2026-10-06", -2_970)]).size).toBe(1);
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

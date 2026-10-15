// ⭐ (F6 round 4, review finding 9 — lead's decision) AN ANSWER ON AN EXPIRED HOLD
// NAMES NO ROW. A "matched" (or partial) Review answer whose row is an expired
// hold — a payment still pending more than 7 days after its date, that failed or
// posted under another row — is read as if it had not been given: it settles
// nothing, its row pays no Weekly Spend week, and the occurrence drags again
// until a posted twin or a card credit pays it once through the evidence path.
// The owner's rule (2026-10-15): the hold counts nowhere, the forecast included.
//
// Synthetic only (`_fixtures/missedAnswersScenario.ts`, answered household —
// every name, amount and number is made up). Clock Thu 10/15 15:00 Central.
// Platinum ••7101 weekly, paid in full, a weekly plan of 450; the payments after
// the 9/22 statement payment never happened, so 9/26 owes 140, 10/3 180 and
// 10/10 260 (580, carried to Fri 10/16); this week's 90 is pending (Sat 10/17:
// 90 + 360 left). Checking ••6120 read at 2,400.00 — either Sun 10/11 (after the
// rows below: "fresh") or Thu 10/01 (before them: "old").
//
// Each case runs with the rule's kill switch too (`EXPIRED_HOLDS_RULE=off` =
// the base, 5e2480e1); the review's measured round 3 figures are in the note.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

// (F6 round 5) The GET /forecast bundle is read as the household below.
const as: { owner: string; household: string } = { owner: "", household: "" };
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = as.owner;
    req.actualUserId = as.owner;
    req.householdId = as.household;
    req.householdOwnerId = as.owner;
    next();
  },
}));
import { db, allowancePlansTable, forecastResolutionsTable, forecastSettingsTable, recurringItemsTable } from "@workspace/db";
import { computeCashSignalDetailed, type CashSignal } from "../lib/cashSignal";
import { buildBillsSummary } from "../lib/billsSummary";
import { loadConfirmedPayments } from "../lib/debtPlan";
import { loadAnswerTwins, readAnsweredRows } from "../lib/supersededPending";
import forecastRouter from "../routes/forecast";
import recurringRouter from "../routes/recurring";
import { cleanupMissedHouseholds, seedMissedHousehold, type MissedHousehold, type MissedRow } from "./_fixtures/missedAnswersScenario";

const NOW = new Date("2026-10-15T15:00:00-05:00");
const owners: string[] = [];
const households: string[] = [];
const LATER_PAYMENTS = new Set(["c2", "c3", "c4", "kP2", "kP3", "kP4"]);
const THIS_WEEK = new Set(["p10", "p11"]);
const thisWeek: MissedRow[] = [
  { key: "p10", on: "2026-10-12", desc: "GREEN GROCER", amt: "-55.00", acct: "platinum", pending: true },
  { key: "p11", on: "2026-10-13", desc: "FUEL STOP", amt: "-35.00", acct: "platinum", pending: true },
];

type Read = "fresh" | "old";

async function household(read: Read, extra: MissedRow[] = []): Promise<MissedHousehold> {
  const owner = `f6r4-answers-${process.pid}-${randomUUID().slice(0, 8)}`;
  const h = await seedMissedHousehold(owner, {
    answered: true,
    rows: (r) => !LATER_PAYMENTS.has(r.key) && !THIS_WEEK.has(r.key),
    extra: [...thisWeek, ...extra],
    platinumBalance: { balance: "580.00", at: new Date("2026-10-14T15:11:00-05:00") },
  });
  await db.insert(allowancePlansTable).values({ householdId: h.householdId, memberUserId: null, period: "weekly", amount: "450.00", effectiveFrom: "2026-08-01", source: "owner" });
  if (read === "old") {
    await db
      .update(forecastSettingsTable)
      .set({ bankSnapshotAt: new Date("2026-10-01T08:00:00-05:00"), bankSnapshotBalance: "2400.00" })
      .where(eq(forecastSettingsTable.householdId, h.householdId));
  }
  owners.push(owner);
  households.push(h.householdId);
  return h;
}

async function answerWeek(h: MissedHousehold, day: string, txnKey: string, status: "matched" | "partial" = "matched"): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(and(eq(forecastResolutionsTable.householdId, h.householdId), eq(forecastResolutionsTable.recurringItemId, h.weeklySpendId), eq(forecastResolutionsTable.occurrenceDate, day)));
  await db.insert(forecastResolutionsTable).values({ userId: h.ownerUserId, householdId: h.householdId, recurringItemId: h.weeklySpendId, occurrenceDate: day, status, matchedTxnId: h.txn[txnKey]! });
}

const signal = async (h: MissedHousehold): Promise<CashSignal> => (await computeCashSignalDetailed(h.householdId, h.ownerUserId, { horizonDays: 30 })).signal;
async function base<T>(read: () => Promise<T>): Promise<T> {
  vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
  try {
    return await read();
  } finally {
    vi.unstubAllEnvs();
  }
}
const cents = (v: string | number) => Math.round(Number(v) * 100);
/** What the forecast shows, in the words of the review: bank today, the lowest day, the weekly drags, what is held for the card, other items' drags. */
function figures(sig: CashSignal, h: MissedHousehold, otherIds: string[] = []) {
  return {
    bank: sig.bankToday,
    lowest: sig.lowestProjected,
    weekly: (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date <= "2026-10-17").map((e) => `${e.date} ${e.amount}`),
    held: (sig.hookReserves ?? []).filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred), 0) / 100,
    other: (sig.events ?? []).filter((e) => otherIds.includes(e.itemId)).map((e) => `${e.date} ${e.amount}`),
  };
}

// The payment that never posted (it failed), the posted payment under another
// row, and the card credit that payment made.
const FAILED_PMT: MissedRow = { key: "pmtHold", on: "2026-10-03", desc: "AMEX EPAYMENT ACH PMT", amt: "-180.00", acct: "checking", pending: true, category: "buffer", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };
const POSTED_TWIN: MissedRow = { key: "pmtPosted", on: "2026-10-05", desc: "AMERICAN EXPRESS ACH PMT W8812", amt: "-180.00", acct: "checking", category: "buffer", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };
const CARD_CREDIT: MissedRow = { key: "pmtCredit", on: "2026-10-06", desc: "ONLINE PAYMENT - THANK YOU", amt: "180.00", acct: "platinum" };

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(async () => {
  vi.useRealTimers();
  await cleanupMissedHouseholds(owners, households);
});

describe("⭐ F6 round 4 · a 'matched' answer whose row is an expired hold names no row", () => {
  // The control: no hold, Weekly Spend 10/3 unanswered (unpaid) — what a payment
  // that failed should read like.
  const CONTROL = { weekly: ["2026-10-16 -580.00", "2026-10-17 -450.00"], held: 670, lowest: "1370.00" };

  for (const read of ["fresh", "old"] as const) {
    it(`⭐ a payment that FAILED (pending 10/03 −180, never posted), answered 'matched' on Weekly Spend 10/03 — ${read} read: the week drags again, like the control (Fri −580, lowest 1,370)`, async () => {
      const h = await household(read, [FAILED_PMT]);
      await answerWeek(h, "2026-10-03", "pmtHold");
      expect(figures(await signal(h), h)).toEqual({ bank: "2400.00", other: [], ...CONTROL });
      // The base: the answer paid the week with money that never left (Fri −400).
      // On the old read the hold's own cash-out (−180 after it) hid the error.
      expect(figures(await base(() => signal(h)), h)).toEqual({
        bank: read === "fresh" ? "2400.00" : "2220.00",
        lowest: read === "fresh" ? "1550.00" : "1370.00",
        weekly: ["2026-10-16 -400.00", "2026-10-17 -450.00"],
        held: 490,
        other: [],
      });
    });

    it(`⭐ a payment that POSTED under another row (10/05 −180 + the card's +180 on 10/06), the answer on its pending copy — ${read} read: paid once, through the evidence path (= the answer on the posted row)`, async () => {
      const h = await household(read, [FAILED_PMT, POSTED_TWIN, CARD_CREDIT]);
      await answerWeek(h, "2026-10-03", "pmtHold");
      const sig = figures(await signal(h), h);
      // The household's answer on the posted row: the reference.
      const ref = await household(read, [POSTED_TWIN, CARD_CREDIT]);
      await answerWeek(ref, "2026-10-03", "pmtPosted");
      expect(sig).toEqual(figures(await signal(ref), ref));
      expect(sig).toEqual({
        bank: read === "fresh" ? "2400.00" : "2220.00",
        lowest: read === "fresh" ? "1550.00" : "1370.00",
        weekly: ["2026-10-16 -400.00", "2026-10-17 -450.00"],
        held: 490,
        other: [],
      });
      // The base: the pending copy's answer AND the posted payment both paid — 180 twice (Fri −220).
      expect(figures(await base(() => signal(h)), h)).toEqual({
        bank: read === "fresh" ? "2400.00" : "2040.00",
        lowest: read === "fresh" ? "1730.00" : "1370.00",
        weekly: ["2026-10-16 -220.00", "2026-10-17 -450.00"],
        held: 310,
        other: [],
      });
    });

    it(`⭐ a one-time bill of 120 (10/02) answered 'matched' to a pending row that never posted — ${read} read: the bill drags again (−120 on Fri 10/16)`, async () => {
      const h = await household(read, [{ key: "billHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-120.00", acct: "checking", pending: true, category: "buffer" }]);
      const [bill] = await db
        .insert(recurringItemsTable)
        .values({ userId: h.ownerUserId, householdId: h.householdId, name: "City Power", kind: "bill", amount: "120", frequency: "onetime", anchorDate: "2026-10-02", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
        .returning();
      await db.insert(forecastResolutionsTable).values({ userId: h.ownerUserId, householdId: h.householdId, recurringItemId: bill!.id, occurrenceDate: "2026-10-02", status: "matched", matchedTxnId: h.txn.billHold! });
      expect(figures(await signal(h), h, [bill!.id])).toEqual({ bank: "2400.00", lowest: "1250.00", ...{ weekly: CONTROL.weekly, held: CONTROL.held }, other: ["2026-10-16 -120.00"] });
      // The base: the answer settled the bill. On the old read the hold's cash-out made it right by accident.
      expect(figures(await base(() => signal(h)), h, [bill!.id])).toEqual({
        bank: read === "fresh" ? "2400.00" : "2280.00",
        lowest: read === "fresh" ? "1370.00" : "1250.00",
        weekly: CONTROL.weekly,
        held: CONTROL.held,
        other: [],
      });
      // Bills › "$X paid" reads the same answer: nothing paid (base: 120.00).
      const paid = async () =>
        [...(await buildBillsSummary(h.householdId, h.ownerUserId, "2026-10-01")).bills].find((r) => r.item.id === bill!.id)?.actualAmount;
      expect(await paid()).toBe("0.00");
      expect(await base(paid)).toBe("120.00");
    });
  }

  it("a partial answer on an expired hold is no partial either: the week drags whole (the control)", async () => {
    const h = await household("fresh", [FAILED_PMT]);
    await answerWeek(h, "2026-10-03", "pmtHold", "partial");
    expect(figures(await signal(h), h)).toEqual({ bank: "2400.00", other: [], ...CONTROL });
  });

  it("an answer on a pending payment 7 days old (not yet expired) still pays its week — the rule starts on day 8", async () => {
    const young: MissedRow = { ...FAILED_PMT, on: "2026-10-08" };
    const h = await household("fresh", [young]);
    await answerWeek(h, "2026-10-03", "pmtHold");
    const on = figures(await signal(h), h);
    expect(on).toEqual(figures(await base(() => signal(h)), h));
    expect(on.weekly[0]).not.toBe("2026-10-16 -580.00");
  });
});

// ⭐ (F6 round 5, review finding 5 — lead's decision) AN ANSWER ON AN EXPIRED ROW
// WHOSE PAYMENT POSTED UNDER ANOTHER NAME counts on that posted row. Round 4
// dropped it: the one-time bill counted again beside the posted row (fresh read:
// the bill dragged −120 on Fri; old read: the posted row's cash-out AND the
// drag — twice). The answer now moves to the one posted twin (same account,
// money out, the cents to canSupersede's cap, 0–7 days after, not answered,
// tagged or claimed): read so, nothing written. The control: the household's
// answer on the posted row itself.
describe("⭐ F6 round 5 · an answer on an expired row counts on its posted twin", () => {
  const BILL_HOLD: MissedRow = { key: "billHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-120.00", acct: "checking", pending: true, category: "buffer" };
  const BILL_POSTED: MissedRow = { key: "billPosted", on: "2026-10-03", desc: "CPWR UTIL WEB PMT 8812", amt: "-120.00", acct: "checking" };

  async function oneTimeBill(h: MissedHousehold, txnKey: string): Promise<string> {
    const [bill] = await db
      .insert(recurringItemsTable)
      .values({ userId: h.ownerUserId, householdId: h.householdId, name: "City Power", kind: "bill", amount: "120", frequency: "onetime", anchorDate: "2026-10-02", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
      .returning();
    await db.insert(forecastResolutionsTable).values({ userId: h.ownerUserId, householdId: h.householdId, recurringItemId: bill!.id, occurrenceDate: "2026-10-02", status: "matched", matchedTxnId: h.txn[txnKey]! });
    return bill!.id;
  }
  const paidOf = async (h: MissedHousehold, billId: string) =>
    [...(await buildBillsSummary(h.householdId, h.ownerUserId, "2026-10-01")).bills].find((r) => r.item.id === billId)?.actualAmount;

  for (const [read, lowest, baseLowest, bank] of [
    ["fresh", "1370.00", "1370.00", "2400.00"],
    ["old", "1250.00", "1130.00", "2280.00"],
  ] as const) {
    it(`⭐ a one-time bill answered on its pending copy, posted 10/03 as "CPWR UTIL WEB PMT" — ${read} read: lowest ${lowest} = the control (round 4: 1,250 fresh / 1,130 old); Bills paid 120.00`, async () => {
      const h = await household(read, [BILL_HOLD, BILL_POSTED]);
      const billId = await oneTimeBill(h, "billHold");
      const ref = await household(read, [BILL_POSTED]);
      const refBill = await oneTimeBill(ref, "billPosted");
      const on = figures(await signal(h), h, [billId]);
      expect(on).toEqual(figures(await signal(ref), ref, [refBill]));
      expect(on).toMatchObject({ bank, lowest, other: [] });
      expect(await paidOf(h, billId)).toBe("120.00");
      expect(await paidOf(ref, refBill)).toBe("120.00");
      // The base (kill switch): the answer settles the bill on the pending copy; on
      // the old read the posted row's cash-out comes on top (counted twice).
      const off = await base(() => signal(h));
      expect(off.lowestProjected).toBe(baseLowest);
      // Nothing was written: the answer still names the pending copy.
      const [stored] = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.recurringItemId, billId));
      expect(stored!.matchedTxnId).toBe(h.txn.billHold);
    });
  }

  it("a posted row someone already answered is no twin: the answer on the expired copy is dropped (the bill drags), the other answer keeps its row", async () => {
    const h = await household("fresh", [BILL_HOLD, BILL_POSTED]);
    const billId = await oneTimeBill(h, "billHold");
    // Another answer already names the posted row (Weekly Spend 10/03, say).
    await answerWeek(h, "2026-10-03", "billPosted");
    const sig = figures(await signal(h), h, [billId]);
    expect(sig.other).toEqual(["2026-10-16 -120.00"]);
    expect(await paidOf(h, billId)).toBe("0.00");
  });

  it("the GET /forecast bundle reads the answer the same way: it names the posted row (Reconcile agrees with the curve); a failed payment's answer is not sent (the occurrence is open)", async () => {
    const app = express();
    app.use(express.json());
    app.use(forecastRouter);
    const server = createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    type Bundle = { resolutions: Array<{ recurringItemId: string; matchedTxnId: string | null; txnDescription: string | null }> };
    const bundleOf = async (h: MissedHousehold): Promise<Bundle> => {
      as.owner = h.ownerUserId;
      as.household = h.householdId;
      const r = await fetch(`http://127.0.0.1:${addr.port}/forecast`);
      if (!r.ok) throw new Error(`GET /forecast -> ${r.status}`);
      return (await r.json()) as Bundle;
    };
    try {
      const h = await household("fresh", [BILL_HOLD, BILL_POSTED]);
      const billId = await oneTimeBill(h, "billHold");
      expect((await bundleOf(h)).resolutions.find((r) => r.recurringItemId === billId)).toMatchObject({
        matchedTxnId: h.txn.billPosted,
        txnDescription: "CPWR UTIL WEB PMT 8812",
      });
      expect((await base(() => bundleOf(h))).resolutions.find((r) => r.recurringItemId === billId)?.matchedTxnId).toBe(h.txn.billHold);
      const failed = await household("fresh", [BILL_HOLD]);
      const failedBill = await oneTimeBill(failed, "billHold");
      expect((await bundleOf(failed)).resolutions.some((r) => r.recurringItemId === failedBill)).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});


// ⭐ (F6 round 6, review of round 5: findings 2, 3, 4 — lead's decisions) WHEN
// UNSURE, DO LESS. A posted twin has the SAME cents (± $1.00; no 1.3× band),
// reads as a payment, is spoken for by nothing (no answer, tag, claim, and no
// other plan the forecast's evidence path could give it to), and is the only
// candidate of the only claimant — one map for the household
// (`loadAnswerTwins`), every reader. Else the answer is dropped (round 4).
describe("⭐ F6 round 6 · a posted twin is one sure pair, one map for every reader", () => {
  const HOME_CENTER: MissedRow = { key: "homeCenter", on: "2026-10-05", desc: "HOME CENTER 0412", amt: "-130.00", acct: "checking" };
  async function monthlyBill(h: MissedHousehold, name: string, amount: string, day: number): Promise<string> {
    const [bill] = await db
      .insert(recurringItemsTable)
      .values({ userId: h.ownerUserId, householdId: h.householdId, name, kind: "bill", amount, frequency: "monthly", dayOfMonth: day, anchorDate: `2026-08-${String(day).padStart(2, "0")}`, active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
      .returning();
    return bill!.id;
  }
  async function answer(h: MissedHousehold, itemId: string, day: string, txnKey: string): Promise<void> {
    await db.insert(forecastResolutionsTable).values({ userId: h.ownerUserId, householdId: h.householdId, recurringItemId: itemId, occurrenceDate: day, status: "matched", matchedTxnId: h.txn[txnKey]! });
  }
  const paidIn = async (h: MissedHousehold, itemId: string, month: string) =>
    [...(await buildBillsSummary(h.householdId, h.ownerUserId, month)).bills].find((r) => r.item.id === itemId)?.actualAmount;
  const twinsOf = async (h: MissedHousehold) => [...(await loadAnswerTwins(h.householdId)).twinOf.entries()].map(([k, v]) => [k, v.id]);

  for (const [read, lowest] of [
    ["fresh", "1250.00"],
    ["old", "1120.00"],
  ] as const) {
    it(`⭐ finding 2: a FAILED City Power payment (−120 pending 10/02) and an unrelated HOME CENTER −130 (10/05) — ${read} read: the truth control (lowest ${lowest}); Bills paid 0.00 (round 5: 1,370 / 1,240, "paid 130.00")`, async () => {
      const bill: MissedRow = { key: "powerHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-120.00", acct: "checking", pending: true };
      const h = await household(read, [bill, HOME_CENTER]);
      const power = await monthlyBill(h, "City Power", "120", 2);
      await answer(h, power, "2026-10-02", "powerHold");
      // The truth: the bill unpaid, the same outflow.
      const ctl = await household(read, [HOME_CENTER]);
      const ctlPower = await monthlyBill(ctl, "City Power", "120", 2);
      const on = figures(await signal(h), h, [power]);
      expect(on).toEqual(figures(await signal(ctl), ctl, [ctlPower]));
      expect(on.lowest).toBe(lowest);
      expect(await paidIn(h, power, "2026-10-01")).toBe("0.00");
      expect(await twinsOf(h)).toEqual([]);
    });
  }

  it("finding 2 (variant): City Water's OWN payment (CITY WATER WEB PMT −120.50, within $1) is never City Power's twin — the evidence path pays City Water, City Power drags (= the control)", async () => {
    const bill: MissedRow = { key: "powerHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-120.00", acct: "checking", pending: true };
    const water: MissedRow = { key: "waterPmt", on: "2026-10-05", desc: "CITY WATER WEB PMT", amt: "-120.50", acct: "checking" };
    const h = await household("fresh", [bill, water]);
    const power = await monthlyBill(h, "City Power", "120", 2);
    const cityWater = await monthlyBill(h, "City Water", "120", 4);
    await answer(h, power, "2026-10-02", "powerHold");
    const ctl = await household("fresh", [water]);
    const ctlPower = await monthlyBill(ctl, "City Power", "120", 2);
    const ctlWater = await monthlyBill(ctl, "City Water", "120", 4);
    expect(figures(await signal(h), h, [power, cityWater])).toEqual(figures(await signal(ctl), ctl, [ctlPower, ctlWater]));
    expect(await twinsOf(h)).toEqual([]);
    expect(await paidIn(h, power, "2026-10-01")).toBe("0.00");
  });

  it("⭐ finding 4 (case 1): one ACH DEBIT −200 after a failed City Power −200 (answered) and a failed −200 tagged to Blue — it pays neither (round 5: both: 200 counted as 400); the debt plan reads no payment", async () => {
    const power: MissedRow = { key: "powerHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-200.00", acct: "checking", pending: true };
    const blue: MissedRow = { key: "blueHold", on: "2026-10-03", desc: "AMEX BLUE CASH PMT", amt: "-200.00", acct: "checking", pending: true, tag: "blue" };
    const ach: MissedRow = { key: "achDebit", on: "2026-10-05", desc: "ACH DEBIT 8812", amt: "-200.00", acct: "checking" };
    const h = await household("fresh", [power, blue, ach]);
    const powerId = await monthlyBill(h, "City Power", "200", 2);
    await answer(h, powerId, "2026-10-02", "powerHold");
    expect(await twinsOf(h)).toEqual([]);
    // The curve: City Power drags again, as when it was never answered.
    const ctl = await household("fresh", [power, blue, ach]);
    const ctlPower = await monthlyBill(ctl, "City Power", "200", 2);
    const sig = await signal(h);
    expect(figures(sig, h, [powerId])).toEqual(figures(await signal(ctl), ctl, [ctlPower]));
    expect(await paidIn(h, powerId, "2026-10-01")).toBe("0.00");
    // The debt plan: no 200 payment (round 5: 200 on the ACH row as well).
    const payments = await loadConfirmedPayments(h.householdId, { overdueAssumedPaid: sig.overdueAssumedPaid }, "2026-10-01", "2026-10-15");
    expect(payments.filter((p) => p.amount === 200)).toEqual([]);
  });

  it("⭐ finding 4 (case 2): Gas Co 9/29 and Phone Co 10/01, 90 each, answered on failed payments; one ONLINE PMT −90 (10/03) — neither is paid by it, in the curve, the bundle or Bills (round 5: Gas by the curve, Phone by Bills)", async () => {
    const gas: MissedRow = { key: "gasHold", on: "2026-09-29", desc: "GAS CO AUTOPAY", amt: "-90.00", acct: "checking", pending: true };
    const phone: MissedRow = { key: "phoneHold", on: "2026-10-01", desc: "PHONE CO AUTOPAY", amt: "-90.00", acct: "checking", pending: true };
    const pmt: MissedRow = { key: "onlinePmt", on: "2026-10-03", desc: "ONLINE PMT 4410", amt: "-90.00", acct: "checking" };
    const h = await household("fresh", [gas, phone, pmt]);
    const gasId = await monthlyBill(h, "Gas Co", "90", 29);
    const phoneId = await monthlyBill(h, "Phone Co", "90", 1);
    await answer(h, gasId, "2026-09-29", "gasHold");
    await answer(h, phoneId, "2026-10-01", "phoneHold");
    expect(await twinsOf(h)).toEqual([]);
    const ctl = await household("fresh", [gas, phone, pmt]);
    const ctlGas = await monthlyBill(ctl, "Gas Co", "90", 29);
    const ctlPhone = await monthlyBill(ctl, "Phone Co", "90", 1);
    expect(figures(await signal(h), h, [gasId, phoneId])).toEqual(figures(await signal(ctl), ctl, [ctlGas, ctlPhone]));
    expect(await paidIn(h, phoneId, "2026-10-01")).toBe("0.00");
    expect(await paidIn(h, gasId, "2026-09-01")).toBe("0.00");
    // Each reader looks its rows up in the one map: the forecast's answer read and Bills agree.
    const read = await readAnsweredRows(h.householdId, [
      { id: h.txn.gasHold!, pending: true, plaidAccountId: h.accounts.checking, occurredOn: "2026-09-29", amount: "-90.00" },
      { id: h.txn.phoneHold!, pending: true, plaidAccountId: h.accounts.checking, occurredOn: "2026-10-01", amount: "-90.00" },
    ]);
    expect(read.expired.size).toBe(2);
    expect(read.postedTwinOf.size).toBe(0);
  });

  it("(Final #9) two answers on failed payments in two months and one posted payment: Bills, month by month, reads what the ledger reads — neither is paid by it; each reader's own rows read the one map", async () => {
    const water: MissedRow = { key: "waterHold", on: "2026-09-28", desc: "CITY WATER UTIL WEB", amt: "-60.00", acct: "checking", pending: true };
    const gasco: MissedRow = { key: "gascoHold", on: "2026-10-02", desc: "GASCO ENERGY AUTOPAY", amt: "-60.00", acct: "checking", pending: true };
    const pmt: MissedRow = { key: "bankPmt", on: "2026-10-03", desc: "ONLINE BANKING PMT 9931", amt: "-60.00", acct: "checking" };
    const h = await household("fresh", [water, gasco, pmt]);
    const waterId = await monthlyBill(h, "City Water", "60", 28);
    const gasId = await monthlyBill(h, "Gasco Energy", "60", 2);
    await answer(h, waterId, "2026-09-28", "waterHold");
    await answer(h, gasId, "2026-10-02", "gascoHold");
    expect(await twinsOf(h)).toEqual([]);
    // The ledger: no occurrence of either bill is paid by the posted row (it may only suggest it).
    const { ledger } = await computeCashSignalDetailed(h.householdId, h.ownerUserId, { horizonDays: 30 });
    const paidByPmt = ledger.planOccurrences.filter(
      (o) => [waterId, gasId].includes(o.itemId) && o.txnId === h.txn.bankPmt && ["matched", "partial", "paid_on_evidence"].includes(o.fate),
    );
    expect(paidByPmt).toEqual([]);
    // Bills, each month on its own (it reads only that month's answers): nothing paid — as the ledger.
    expect(await paidIn(h, waterId, "2026-09-01")).toBe("0.00");
    expect(await paidIn(h, gasId, "2026-10-01")).toBe("0.00");
    // One reader's subset and another's read the same map (round 5 assigned twins per caller).
    const named = (key: string, on: string) => ({ id: h.txn[key]!, pending: true, plaidAccountId: h.accounts.checking, occurredOn: on, amount: "-60.00" });
    const alone = await readAnsweredRows(h.householdId, [named("gascoHold", "2026-10-02")]);
    const both = await readAnsweredRows(h.householdId, [named("waterHold", "2026-09-28"), named("gascoHold", "2026-10-02")]);
    expect([alone.postedTwinOf.size, both.postedTwinOf.size]).toEqual([0, 0]);
  });

  it("finding 5 (round 5's pin) still holds through the one map: CPWR UTIL WEB PMT (no other plan's name) is the one sure twin", async () => {
    const h = await household("fresh", [
      { key: "billHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-120.00", acct: "checking", pending: true, category: "buffer" },
      { key: "billPosted", on: "2026-10-03", desc: "CPWR UTIL WEB PMT 8812", amt: "-120.00", acct: "checking" },
    ]);
    const [bill] = await db
      .insert(recurringItemsTable)
      .values({ userId: h.ownerUserId, householdId: h.householdId, name: "City Power", kind: "bill", amount: "120", frequency: "onetime", anchorDate: "2026-10-02", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
      .returning();
    await answer(h, bill!.id, "2026-10-02", "billHold");
    expect(await twinsOf(h)).toEqual([[h.txn.billHold, h.txn.billPosted]]);
    // A purchase of the same cents is no twin (it does not read as a payment).
    const shop = await household("fresh", [
      { key: "billHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-120.00", acct: "checking", pending: true },
      { key: "shop", on: "2026-10-03", desc: "HOME CENTER 0412", amt: "-120.00", acct: "checking" },
    ]);
    const shopPower = await monthlyBill(shop, "City Power", "120", 2);
    await answer(shop, shopPower, "2026-10-02", "billHold");
    expect(await twinsOf(shop)).toEqual([]);
    // The kill switch: no map at all.
    expect(await base(() => twinsOf(h))).toEqual([]);
  });

  // ⭐ (Finding 3) A one-time bill answered on a payment that failed is not
  // archived as resolved: it keeps dragging after every page that archives.
  describe("finding 3 · archiving a one-time bill reads the answer the same way", () => {
    const POWER_HOLD: MissedRow = { key: "billHold", on: "2026-10-02", desc: "CITY POWER AUTOPAY", amt: "-120.00", acct: "checking", pending: true };
    async function oneTime(h: MissedHousehold): Promise<string> {
      const [bill] = await db
        .insert(recurringItemsTable)
        .values({ userId: h.ownerUserId, householdId: h.householdId, name: "City Power", kind: "bill", amount: "120", frequency: "onetime", anchorDate: "2026-10-02", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
        .returning();
      await answer(h, bill!.id, "2026-10-02", "billHold");
      return bill!.id;
    }
    const activeOf = async (id: string) => (await db.select({ active: recurringItemsTable.active }).from(recurringItemsTable).where(eq(recurringItemsTable.id, id)))[0]!.active;
    async function loadPages(h: MissedHousehold): Promise<void> {
      as.owner = h.ownerUserId;
      as.household = h.householdId;
      const app = express();
      app.use(express.json());
      app.use(forecastRouter);
      app.use(recurringRouter);
      const server = createServer(app);
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no address");
      try {
        await buildBillsSummary(h.householdId, h.ownerUserId);
        for (const path of ["/forecast", "/recurring-items"]) {
          const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
          if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
        }
      } finally {
        await new Promise<void>((res) => server.close(() => res()));
      }
    }

    it("⭐ after a Bills, a Forecast and a bill-list load the bill is still active and drags −120 on Fri 10/16 (lowest 1,250; round 4/5: archived, 1,370)", async () => {
      const h = await household("fresh", [POWER_HOLD]);
      const bill = await oneTime(h);
      await loadPages(h);
      expect(await activeOf(bill)).toBe("true");
      expect(figures(await signal(h), h, [bill])).toMatchObject({ lowest: "1250.00", other: ["2026-10-16 -120.00"] });
    });

    it("loaded the day after the bill (its payment 1 day old, still pending) the bill waits; once the payment expired it drags", async () => {
      const h = await household("fresh", [POWER_HOLD]);
      const bill = await oneTime(h);
      vi.setSystemTime(new Date("2026-10-03T12:00:00-05:00"));
      try {
        await buildBillsSummary(h.householdId, h.ownerUserId);
      } finally {
        vi.setSystemTime(NOW);
      }
      expect(await activeOf(bill)).toBe("true");
      await loadPages(h);
      expect(figures(await signal(h), h, [bill]).other).toEqual(["2026-10-16 -120.00"]);
    });

    it("a payment that posted (the row itself, or its posted twin) resolves the bill as before; the kill switch archives as before", async () => {
      const posted = await household("fresh", [{ ...POWER_HOLD, pending: false }]);
      const postedBill = await oneTime(posted);
      await loadPages(posted);
      expect(await activeOf(postedBill)).toBe("false");
      const twin = await household("fresh", [POWER_HOLD, { key: "billPosted", on: "2026-10-03", desc: "CPWR UTIL WEB PMT 8812", amt: "-120.00", acct: "checking" }]);
      const twinBill = await oneTime(twin);
      await loadPages(twin);
      expect(await activeOf(twinBill)).toBe("false");
      const off = await household("fresh", [POWER_HOLD]);
      const offBill = await oneTime(off);
      await base(() => buildBillsSummary(off.householdId, off.ownerUserId));
      expect(await activeOf(offBill)).toBe("false");
    });
  });

  // ⭐ (Final polish, round 6 verifier) A POSTED ROW THAT IS EVIDENCE FOR THE
  // HOLD'S OWN BILL IS NO TWIN. A weekly 150 paid by ACH, a new reference number
  // each week. The answered payment failed (pending, expired); the NEXT week's
  // payment posted, unanswered. Round 6 took that payment as the failed one's
  // twin: the paid week dragged −150 again and Bills read the failed week paid.
  // Now it is left to the evidence path, which pays the week it belongs to: the
  // answer reads exactly as no answer (the control) — round 4's figures.
  //   W1 (Wed 9/30 failed · 10/07 · 10/14 posted), lowest fresh / old:
  //     base 1,070 / 920 (Bills Sept "paid 150") · r4 1,070 / 920 · r6 920 / 770
  //     (an extra −150 on Fri 10/16, Bills Sept "paid 150") · now 1,070 / 920, Sept 0.00.
  //   W2 (Fri 10/02 failed · 10/09 posted): r6 = now on the curve (1,070 / 920);
  //     Bills Oct r6 "paid 150" (the 10/09 payment counted for 10/02) · now 0.00 (= the control).
  describe("the hold's own bill: its next payment is no twin", () => {
    async function weeklyBill(h: MissedHousehold, anchor: string): Promise<string> {
      const [bill] = await db
        .insert(recurringItemsTable)
        .values({ userId: h.ownerUserId, householdId: h.householdId, name: "Bright Kids Care", kind: "bill", amount: "150", frequency: "weekly", anchorDate: anchor, active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
        .returning();
      return bill!.id;
    }
    const ach = (key: string, on: string, pending: boolean): MissedRow => ({
      key,
      on,
      desc: `BRIGHT KIDS CARE ACH PMT ${on.slice(5).replace("-", "")}`,
      amt: "-150.00",
      acct: "checking",
      ...(pending ? { pending: true } : {}),
    });
    const view = async (h: MissedHousehold, bill: string) => {
      const s = await signal(h);
      return {
        bank: s.bankToday,
        lowest: s.lowestProjected,
        drags: (s.events ?? []).filter((e) => e.itemId === bill && e.date <= "2026-10-31").map((e) => `${e.date} ${e.amount}`),
        paidSep: await paidIn(h, bill, "2026-09-01"),
        paidOct: await paidIn(h, bill, "2026-10-01"),
      };
    };

    for (const [label, anchor, failed, posted, later, fresh, old] of [
      ["W1 (Wed 9/30 · 10/07 · 10/14)", "2026-09-02", "2026-09-30", "2026-10-07", "2026-10-14", { bank: "2250.00", lowest: "1070.00" }, { bank: "2100.00", lowest: "920.00" }],
      ["W2 (Fri 10/02 · 10/09)", "2026-09-04", "2026-10-02", "2026-10-09", null, { bank: "2400.00", lowest: "1070.00" }, { bank: "2250.00", lowest: "920.00" }],
    ] as const) {
      for (const read of ["fresh", "old"] as const) {
        it(`⭐ ${label} ${read} read: the answer on the failed payment reads as no answer (lowest ${(read === "fresh" ? fresh : old).lowest}); Bills pays nothing; no twin`, async () => {
          const rows = [ach("P", failed, true), ach("Q", posted, false), ...(later ? [ach("R", later, false)] : [])];
          const h = await household(read, rows);
          const bill = await weeklyBill(h, anchor);
          await answer(h, bill, failed, "P");
          const ctl = await household(read, rows);
          const ctlBill = await weeklyBill(ctl, anchor);
          const got = await view(h, bill);
          expect(got).toEqual(await view(ctl, ctlBill));
          expect(got).toMatchObject({ ...(read === "fresh" ? fresh : old), paidSep: "0.00", paidOct: "0.00" });
          if (label.startsWith("W1")) expect(got.drags).toEqual(["2026-10-21 -150.00", "2026-10-28 -150.00"]);
          expect(await twinsOf(h)).toEqual([]);
        });
      }
    }

    it("a payee name that differs from the bill's is still the one sure twin (round 5's CPWR pin, weekly)", async () => {
      const h = await household("fresh", [
        ach("P", "2026-09-30", true),
        { key: "Q", on: "2026-10-01", desc: "BKC CHILDCARE WEB PMT 7781", amt: "-150.00", acct: "checking" },
      ]);
      const bill = await weeklyBill(h, "2026-09-02");
      await answer(h, bill, "2026-09-30", "P");
      expect(await twinsOf(h)).toEqual([[h.txn.P, h.txn.Q]]);
    });
  });
});

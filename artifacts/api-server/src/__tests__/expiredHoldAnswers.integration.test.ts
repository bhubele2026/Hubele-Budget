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
import { and, eq } from "drizzle-orm";
import { db, allowancePlansTable, forecastResolutionsTable, forecastSettingsTable, recurringItemsTable } from "@workspace/db";
import { computeCashSignalDetailed, type CashSignal } from "../lib/cashSignal";
import { buildBillsSummary } from "../lib/billsSummary";
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

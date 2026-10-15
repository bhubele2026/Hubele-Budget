// ⭐ (F1) EVERY REAL CASH OBLIGATION OF THE EVERYDAY HOOKS, EXACTLY ONCE.
//
// The scenario and its hand-worked figures are in
// `_fixtures/obligationsScenario.ts` (Wed 2026-10-14; Platinum weekly with an
// ARCHIVED debt → in_full; Gold weekly, no debt → in_full; Blue Cash monthly
// with an ACTIVE debt → debt_plan). The dated cash-flow table these tests pin is
// in docs/reviews/2026-10-14-f1-oblig.md. "Before F1" figures are the same
// ledger with `HOOK_OBLIGATIONS=off` (the pre-F1 card-band model, kept behind
// the kill switch); a plan the pre-F1 path could not reach through the gate is
// inserted straight into the table for that comparison only.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const owners: string[] = [];
const households: string[] = [];
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { headers: Record<string, string | string[] | undefined>; userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"]);
    const hh = HH[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import { db, allowancePlansTable, settingsTable, transactionsTable } from "@workspace/db";
import { CreateAllowancePlanResponse, GetForecastCashSignalResponse } from "@workspace/api-zod";
import moneyRouter from "../routes/money";
import forecastRouter from "../routes/forecast";
import amexRouter from "../routes/amex";
import { computeCashSignalDetailed, type CashSignal } from "../lib/cashSignal";
import { planWriteGate } from "../lib/planSafety";
import { buildAmexSummary } from "../lib/amexSummary";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import {
  OBL_NOW,
  OBL_THIS_SUNDAY,
  cleanupObligationsHouseholds,
  seedObligationsHousehold,
  type ObligationsHousehold,
} from "./_fixtures/obligationsScenario";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(forecastRouter);
app.use(amexRouter);
let server: Server;
let baseUrl: string;

async function call(method: "GET" | "PUT" | "POST", path: string, as: string, body?: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-test-user": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function household(opts: Parameters<typeof seedObligationsHousehold>[1] = {}): Promise<ObligationsHousehold> {
  const owner = `f1-obl-${process.pid}-${randomUUID().slice(0, 8)}`;
  const h = await seedObligationsHousehold(owner, opts);
  owners.push(owner);
  households.push(h.householdId);
  HH[owner] = { householdId: h.householdId, ownerUserId: owner };
  return h;
}

const signalOf = async (h: ObligationsHousehold) => (await computeCashSignalDetailed(h.householdId, h.ownerUserId, { horizonDays: 30 })).signal;
const legacy = async <T>(f: () => Promise<T>): Promise<T> => {
  process.env.HOOK_OBLIGATIONS = "off";
  try {
    return await f();
  } finally {
    delete process.env.HOOK_OBLIGATIONS;
  }
};
/** "date label amount (occurrence, assumption)" for every expense event. */
const events = (sig: CashSignal) =>
  (sig.events ?? []).map((e) => `${e.date} ${e.label} ${e.amount}${e.originalDate !== e.date ? ` (${e.originalDate} ${e.assumption})` : ""}`);
/** The days the balance moves, and the low point. */
const curve = (sig: CashSignal) => ({
  moves: (sig.daily ?? []).filter((d, i, a) => i === 0 || d.balance !== a[i - 1]!.balance).map((d) => `${d.date} ${d.balance}`),
  low: `${sig.lowestProjected} @ ${sig.lowestDate}`,
});
const reserves = (sig: CashSignal) =>
  (sig.hookReserves ?? []).map((r) => `${r.occurrenceDate} ${r.amount} = incurred ${r.incurred} + paid ${r.paid} + carried ${r.carried} + left ${r.allowanceLeft}${r.carriedTo ? ` → ${r.carriedTo}` : ""}`);
const cents = (v: string | number) => Math.round(Number(v) * 100);

beforeAll(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(OBL_NOW);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterEach(() => {
  delete process.env.HOOK_OBLIGATIONS;
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanupObligationsHouseholds(owners, households);
});

// ── The dated cash-flow table, scenario A: NO PLAN (the household's live state).
const A_EVENTS_AFTER = [
  "2026-10-15 Weekly Spend -290.00 (2026-10-10 overdue_assumed_unpaid)",
  "2026-10-17 Weekly Spend -450.00",
  "2026-10-20 Amex Blue Cash minimum -143.05",
  "2026-10-24 Weekly Spend -450.00",
  "2026-10-31 Weekly Spend -450.00",
  "2026-11-07 Weekly Spend -450.00",
];
const A_EVENTS_BEFORE = [
  "2026-10-15 Weekly Spend -450.00 (2026-10-03 overdue_assumed_unpaid)",
  "2026-10-15 Weekly Spend -450.00 (2026-10-10 overdue_assumed_unpaid)",
  "2026-10-17 Weekly Spend -450.00",
  "2026-10-20 Amex Blue Cash minimum -143.05",
  "2026-10-24 Weekly Spend -450.00",
  "2026-10-31 Weekly Spend -450.00",
  "2026-11-07 Weekly Spend -450.00",
];

describe("A · no plan — every in_full purchase is owed once, every payment counted once, Blue's purchases by its debt plan only", () => {
  let h: ObligationsHousehold;
  beforeAll(async () => {
    h = await household();
  });

  it("the curve (after F1) vs the pre-F1 model: 10/15 one carried 290 instead of two stored 450s; low 1,941.95 instead of 1,331.95", async () => {
    const after = await signalOf(h);
    const before = await legacy(() => signalOf(h));
    expect(after.bankToday).toBe("2825.00");
    expect(events(after)).toEqual(A_EVENTS_AFTER);
    expect(events(before)).toEqual(A_EVENTS_BEFORE);
    expect(curve(after)).toEqual({
      moves: ["2026-10-14 2825.00", "2026-10-15 2535.00", "2026-10-17 2085.00", "2026-10-20 1941.95", "2026-10-23 3941.95", "2026-10-24 3491.95", "2026-10-31 3041.95", "2026-11-06 5041.95", "2026-11-07 4591.95"],
      low: "1941.95 @ 2026-10-20",
    });
    expect(curve(before).low).toBe("1331.95 @ 2026-10-20");
  });

  it("each occurrence's split: paid weeks off the curve, 10/3's unpaid 50 carried into 10/10, this week 120 charged + 330 of the reserve", async () => {
    const sig = await signalOf(h);
    expect(() => GetForecastCashSignalResponse.parse(sig)).not.toThrow();
    expect(reserves(sig)).toEqual([
      "2026-09-05 0.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 0.00",
      "2026-09-12 0.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 0.00",
      "2026-09-19 80.00 = incurred 0.00 + paid 80.00 + carried 0.00 + left 0.00",
      "2026-09-26 120.00 = incurred 0.00 + paid 120.00 + carried 0.00 + left 0.00",
      "2026-10-03 80.00 = incurred 50.00 + paid 80.00 + carried 0.00 + left 0.00 → 2026-10-10",
      "2026-10-10 290.00 = incurred 240.00 + paid 0.00 + carried 50.00 + left 0.00",
      "2026-10-17 450.00 = incurred 120.00 + paid 0.00 + carried 0.00 + left 330.00",
      "2026-10-24 450.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 450.00",
      "2026-10-31 450.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 450.00",
      "2026-11-07 450.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 450.00",
    ]);
    const r = (d: string) => sig.hookReserves!.find((x) => x.occurrenceDate === d)!;
    expect(r("2026-10-10").carriedFrom).toEqual([{ occurrenceDate: "2026-10-03", periodStart: "2026-09-27", periodEnd: "2026-10-03", amount: "50.00" }]);
    // The cards each occurrence bills: Platinum (archived debt) and Gold, never Blue (debt plan).
    // 10/10: Platinum 200 — the pending BISTRO 22 its posted row replaced counts once (not 245).
    expect(r("2026-10-10").cards.map((c) => `${c.mask} ${c.mode} ${c.amount}`).sort()).toEqual(["2207 in_full 200.00", "3307 in_full 40.00"]);
    // 10/3: Platinum 150 less the 20 refund dated in that week.
    expect(r("2026-10-03").cards.map((c) => `${c.mask} ${c.amount}`).sort()).toEqual(["2207 130.00", "3307 0.00"]);
    expect(r("2026-10-17").cards.map((c) => `${c.mask} ${c.amount}`).sort()).toEqual(["2207 100.00", "3307 20.00"]);
    expect(sig.hookReserves!.every((x) => x.cards.every((c) => c.mask !== "1106"))).toBe(true);
  });

  it("⭐ exactly once: every in_full purchase − refund lands in one occurrence; every payment is allocated once; due unpaid = the one dragged event", async () => {
    const sig = await signalOf(h);
    const rs = sig.hookReserves!;
    // Purchases − refunds on Platinum + Gold, 9/13 – 10/14 (fixture): 690.00.
    const ownTotal = rs.reduce((s, r) => s + r.cards.reduce((t, c) => t + cents(c.amount), 0), 0);
    expect(ownTotal).toBe(69000);
    // Payments that may pay the hooks: 9/21 80 + 10/5 50 (Platinum's tag) + 10/12 150 = 280 — all used, once.
    expect(rs.reduce((s, r) => s + cents(r.paid), 0)).toBe(28000);
    // incurred (own unpaid, wherever it sits) + paid = own, per occurrence.
    for (const r of rs) expect(cents(r.incurred) + cents(r.paid), r.occurrenceDate).toBe(r.cards.reduce((t, c) => t + cents(c.amount), 0));
    // Summed over the reserves every obligation counts once: Σ amount = Σ own + Σ allowance left.
    expect(rs.reduce((s, r) => s + cents(r.amount), 0)).toBe(ownTotal + rs.reduce((s, r) => s + cents(r.allowanceLeft), 0));
    // On the curve: the due weeks' unpaid (570 − 280 = 290) once, on Thu 10/15.
    const hookOnCurve = (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId);
    expect(hookOnCurve.filter((e) => e.date === "2026-10-15").map((e) => e.amount)).toEqual(["-290.00"]);
    // Every payment row stays in cash once (bank today 3,000 − 150 − 25); none is a second expense event.
    expect(sig.bankToday).toBe("2825.00");
    expect((sig.events ?? []).filter((e) => /PMT|TRANSFER/.test(e.label))).toEqual([]);
  });

  it("paid weeks are listed (never silent): 9/19 by the 80, 9/26 by the 150 (with the tagged 50); Blue's 9/20 minimum by its own tagged payment", async () => {
    const sig = await signalOf(h);
    expect((sig.overdueAssumedPaid ?? []).map((p) => `${p.label} ${p.dueDate} ${p.planAmount} ← ${p.txnAmount} left ${p.unpaidRemainder} ${p.confidence}`)).toEqual([
      "Weekly Spend 2026-09-19 -80.00 ← -80.00 left 0.00 card_payment",
      "Amex Blue Cash minimum 2026-09-20 -143.05 ← -143.05 left 0.00 debt_tag",
      "Weekly Spend 2026-09-26 -120.00 ← -150.00 left 0.00 card_payment",
    ]);
  });

  it("the Amex summary: Platinum (archived debt) answers to the weekly hook now; Blue to its debt", async () => {
    const plat = await buildAmexSummary(h.householdId, h.ownerUserId, { accountId: h.accounts.platinum, from: OBL_THIS_SUNDAY, to: "2026-10-14", rowsPerGroup: 5 });
    expect(plat.scope.cards[0]!.payoffMode).toEqual({ mode: "in_full", source: "default", reason: "debt_not_active" });
    expect(plat.planLink).toMatchObject({ kind: "weekly_hook", payoff: "450.00", payoffDate: "2026-10-17", basis: "stored_amount" });
    const blue = await buildAmexSummary(h.householdId, h.ownerUserId, { accountId: h.accounts.blue, from: OBL_THIS_SUNDAY, to: "2026-10-14", rowsPerGroup: 5 });
    expect(blue.scope.cards[0]!.payoffMode).toEqual({ mode: "debt_plan", source: "default", reason: "debt_active" });
    expect(blue.planLink).toMatchObject({ kind: "debt", minimum: "143.05", status: "active" });
  });
});

describe("B/C · a plan set — under and over — before and after activation (dry run, then the real POST)", () => {
  it("the gate is open on the code defaults (Platinum in_full, Gold in_full; Blue is monthly)", async () => {
    const h = await household();
    expect(await planWriteGate(h.householdId, h.ownerUserId)).toEqual({ ok: true });
  });

  for (const [label, amount, sat, later, low, legacySat, legacyLow] of [
    // spent this week 180: under $300 → 120 + 120 = 240; over $150 → 120 + 0 = 120.
    ["under ($300)", "300", "-240.00", "-300.00", "2151.95 @ 2026-10-20", "-140.00", "1641.95 @ 2026-10-20"],
    ["over ($150)", "150", "-120.00", "-150.00", "2271.95 @ 2026-10-20", "-20.00", "1761.95 @ 2026-10-20"],
  ] as const) {
    it(`${label}: the dry run shows 10/17 450 → ${sat.slice(1)} and the low point, writes nothing; the real POST gives exactly that; before F1 the Saturday would have been ${legacySat.slice(1)} (Platinum's purchases lost)`, async () => {
      const h = await household();
      const owner = h.ownerUserId;
      const body = { period: "weekly", amount, effectiveFrom: OBL_THIS_SUNDAY };
      const dry = await call("POST", "/allowance-plans?dryRun=1", owner, body);
      expect(dry.status).toBe(200);
      expect(() => CreateAllowancePlanResponse.parse(dry.body)).not.toThrow();
      expect(await db.select().from(allowancePlansTable).where(eq(allowancePlansTable.householdId, h.householdId))).toEqual([]);
      expect(dry.body).toMatchObject({ dryRun: true, allowed: true, reason: null });
      expect(dry.body.lowPoint).toEqual({ before: { amount: "1941.95", date: "2026-10-20" }, after: { amount: low.slice(0, 7), date: "2026-10-20" } });
      const sat17 = dry.body.occurrences.find((o: { occurrenceDate: string }) => o.occurrenceDate === "2026-10-17");
      expect(sat17.before).toMatchObject({ amount: "450.00", onCurve: "450.00", basis: "stored_amount", incurred: "120.00", allowanceLeft: "330.00" });
      expect(sat17.after).toMatchObject({ amount: sat.slice(1), onCurve: sat.slice(1), basis: "plan", incurred: "120.00", paid: "0.00", carried: "0.00" });
      expect(sat17.cards.map((c: { mask: string; amount: string }) => `${c.mask} ${c.amount}`).sort()).toEqual(["2207 100.00", "3307 20.00"]);
      // The plan governs this week on (every Saturday of the 90-day low-point horizon, 10/17 – 1/9);
      // the closed weeks (no plan then) do not move, so they are not listed.
      const dates = dry.body.occurrences.map((o: { occurrenceDate: string }) => o.occurrenceDate);
      expect([dates[0], dates[1], dates.length, dates[dates.length - 1]]).toEqual(["2026-10-17", "2026-10-24", 13, "2027-01-09"]);
      expect(dry.body.occurrences.slice(1).every((o: { before: { amount: string }; after: { amount: string } }) => o.before.amount === "450.00" && o.after.amount === later.slice(1))).toBe(true);

      const post = await call("POST", "/allowance-plans", owner, body);
      expect(post.status).toBe(200);
      const sig = await signalOf(h);
      expect(events(sig)).toEqual([
        "2026-10-15 Weekly Spend -290.00 (2026-10-10 overdue_assumed_unpaid)",
        `2026-10-17 Weekly Spend ${sat}`,
        "2026-10-20 Amex Blue Cash minimum -143.05",
        `2026-10-24 Weekly Spend ${later}`,
        `2026-10-31 Weekly Spend ${later}`,
        `2026-11-07 Weekly Spend ${later}`,
      ]);
      expect(curve(sig).low).toBe(low);
      // The dry run said exactly this (its own 90-day horizon: every occurrence and the low point).
      const sig90 = (await computeCashSignalDetailed(h.householdId, owner, { horizonDays: 90 })).signal;
      for (const o of dry.body.occurrences) {
        const r = sig90.hookReserves!.find((x) => x.planKey === o.planKey)!;
        expect([r.amount, r.basis, r.incurred, r.paid, r.carried, r.allowanceLeft], o.occurrenceDate).toEqual([o.after.amount, o.after.basis, o.after.incurred, o.after.paid, o.after.carried, o.after.allowanceLeft]);
      }
      expect({ amount: sig90.lowestProjected, date: sig90.lowestDate }).toEqual(dry.body.lowPoint.after);

      // Before F1: the same plan row, read by the card-band model (`HOOK_OBLIGATIONS=off`).
      const old = await legacy(() => signalOf(h));
      expect(events(old).filter((e) => e.startsWith("2026-10-17"))).toEqual([`2026-10-17 Weekly Spend ${legacySat}`]);
      expect(curve(old).low).toBe(legacyLow);
    });
  }
});

describe("payment evidence — the card's own ledger, debt tags and pending → posted", () => {
  it("a card's payment credit and the checking row that sent it are one payment: Platinum's +150 credit on 10/13 pins the 10/12 −150 to Platinum (Gold's 30 stays owed); 280 paid in all, never 430", async () => {
    const h = await household();
    await db.insert(transactionsTable).values({
      userId: h.ownerUserId,
      householdId: h.householdId,
      occurredOn: "2026-10-13",
      description: "ONLINE PAYMENT - THANK YOU",
      amount: "150.00",
      plaidAccountId: h.accounts.platinum,
      source: "plaid:amex",
      plaidTransactionId: `obl-credit-${randomUUID().slice(0, 8)}`,
    });
    const sig = await signalOf(h);
    expect(sig.hookReserves!.reduce((s, r) => s + cents(r.paid), 0)).toBe(28000);
    expect(reserves(sig).slice(2, 6)).toEqual([
      "2026-09-19 80.00 = incurred 0.00 + paid 80.00 + carried 0.00 + left 0.00",
      // 10/5 −50 (Platinum's tag) and the −150 (Platinum's ledger) pay Platinum only: 90 + 110 of 130.
      "2026-09-26 90.00 = incurred 30.00 + paid 90.00 + carried 0.00 + left 0.00 → 2026-10-10",
      "2026-10-03 110.00 = incurred 20.00 + paid 110.00 + carried 0.00 + left 0.00 → 2026-10-10",
      "2026-10-10 290.00 = incurred 240.00 + paid 0.00 + carried 50.00 + left 0.00",
    ]);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -290.00 (2026-10-10 overdue_assumed_unpaid)");
  });

  it("a payment Blue's own ledger received (+150 on Blue, 10/13) paid the DEBT-PLAN card: it pays no in_full week (440 owed on 10/15)", async () => {
    const h = await household();
    await db.insert(transactionsTable).values({
      userId: h.ownerUserId,
      householdId: h.householdId,
      occurredOn: "2026-10-13",
      description: "ONLINE PAYMENT - THANK YOU",
      amount: "150.00",
      plaidAccountId: h.accounts.blue,
      source: "plaid:amex",
      plaidTransactionId: `obl-credit-${randomUUID().slice(0, 8)}`,
    });
    const sig = await signalOf(h);
    // Paid: 80 (9/19) + the tagged 50 (Platinum, 9/26). Owed: 9/26 70 + 10/3 130 + 10/10 240 = 440.
    expect(sig.hookReserves!.reduce((s, r) => s + cents(r.paid), 0)).toBe(13000);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -440.00 (2026-10-10 overdue_assumed_unpaid)");
  });

  it("a payment made from elsewhere (only the card's own +240 credit, no checking row) pays the in_full card's oldest weeks", async () => {
    const h = await household({ rows: (r) => r.key !== "c3" });
    await db.insert(transactionsTable).values({
      userId: h.ownerUserId,
      householdId: h.householdId,
      occurredOn: "2026-10-13",
      description: "MOBILE PAYMENT - THANK YOU",
      amount: "240.00",
      plaidAccountId: h.accounts.platinum,
      source: "plaid:amex",
      plaidTransactionId: `obl-credit-${randomUUID().slice(0, 8)}`,
    });
    const sig = await signalOf(h);
    // 9/26 Platinum 40 + 10/3 130 + 10/10 Platinum 70 = 240; Gold's 30 (9/26) and 40 (10/10) and Platinum's 130 (10/10) remain.
    expect(sig.hookReserves!.reduce((s, r) => s + cents(r.paid), 0)).toBe(37000);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -200.00 (2026-10-10 overdue_remainder_assumed_unpaid)");
    // Bank today has no −150 this time: 3,000 − 25.
    expect(sig.bankToday).toBe("2975.00");
  });

  it("a pending payment and its posted row are one payment (counted once)", async () => {
    const h = await household({ rows: (r) => r.key !== "c3" });
    const base = { userId: h.ownerUserId, householdId: h.householdId, plaidAccountId: h.accounts.checking, source: "plaid:lakeside", forecastFlag: true };
    await db.insert(transactionsTable).values([
      { ...base, occurredOn: "2026-10-12", description: "AMERICAN EXPRESS ACH PMT", amount: "-150.00", pending: true, plaidTransactionId: `obl-pp-${randomUUID().slice(0, 8)}`, createdAt: createdAtStartOfHouseholdDay("2026-10-12") },
      { ...base, occurredOn: "2026-10-13", description: "AMERICAN EXPRESS ACH PMT", amount: "-150.00", pending: false, plaidTransactionId: `obl-pq-${randomUUID().slice(0, 8)}`, createdAt: createdAtStartOfHouseholdDay("2026-10-13") },
    ]);
    const sig = await signalOf(h);
    expect(sig.hookReserves!.reduce((s, r) => s + cents(r.paid), 0)).toBe(28000);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -290.00 (2026-10-10 overdue_assumed_unpaid)");
  });

  it("(F5) a missed answer on 10/3 closes its reserve, never its purchases: its unpaid 50 is still carried — 10/15 −290, as unanswered (F1: −160, the 130 of purchases erased)", async () => {
    const h = await household();
    const { forecastResolutionsTable } = await import("@workspace/db");
    await db.insert(forecastResolutionsTable).values({
      userId: h.ownerUserId,
      householdId: h.householdId,
      recurringItemId: h.weeklySpendId,
      occurrenceDate: "2026-10-03",
      status: "missed",
    });
    const sig = await signalOf(h);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -290.00 (2026-10-10 overdue_assumed_unpaid)");
    expect(reserves(sig).slice(4, 6)).toEqual([
      "2026-10-03 80.00 = incurred 50.00 + paid 80.00 + carried 0.00 + left 0.00 → 2026-10-10",
      "2026-10-10 290.00 = incurred 240.00 + paid 0.00 + carried 50.00 + left 0.00",
    ]);
  });

  it("a matched answer that names NO row still settles its week (nothing to allocate; a matched ROW pays its week first and the rest goes on — missedAnswers): 10/3 → its 130 is no longer owed and the payment it would have used pays 10/10 (80 of 240)", async () => {
    const h = await household();
    const { forecastResolutionsTable } = await import("@workspace/db");
    await db.insert(forecastResolutionsTable).values({
      userId: h.ownerUserId,
      householdId: h.householdId,
      recurringItemId: h.weeklySpendId,
      occurrenceDate: "2026-10-03",
      status: "matched",
    });
    const sig = await signalOf(h);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -160.00 (2026-10-10 overdue_remainder_assumed_unpaid)");
  });
});

describe("Blue set to IN FULL by the owner (and billed weekly): its minimum leaves the curve and its purchases join the hook — never both", () => {
  it("no 10/20 minimum; Blue's 60 (10/2) and 35 (this week) are in the weekly hook", async () => {
    const h = await household();
    const [s] = await db.select().from(settingsTable).where(eq(settingsTable.userId, h.ownerUserId));
    await db
      .update(settingsTable)
      .set({ preferences: { ...(s!.preferences as object), amexCardCadence: { [h.accounts.blue]: "weekly" }, amexCardPayoffMode: { [h.accounts.blue]: "in_full" } } })
      .where(and(eq(settingsTable.userId, h.ownerUserId)));
    const sig = await signalOf(h);
    expect(events(sig).filter((e) => /minimum/.test(e))).toEqual([]);
    const r = (d: string) => sig.hookReserves!.find((x) => x.occurrenceDate === d)!;
    expect(r("2026-10-03").cards.find((c) => c.mask === "1106")).toMatchObject({ mode: "in_full", amount: "60.00" });
    expect(r("2026-10-17").cards.find((c) => c.mask === "1106")).toMatchObject({ mode: "in_full", amount: "35.00" });
    // Owed: 10/3 130 + 60 = 190, paid 80 → 110 carried; 10/10 240 → 350 on 10/15. This week 155 + max(0, 450 − 155) = 450.
    expect(events(sig).slice(0, 2)).toEqual(["2026-10-15 Weekly Spend -350.00 (2026-10-10 overdue_assumed_unpaid)", "2026-10-17 Weekly Spend -450.00"]);
    // The kill switch puts the pre-F1 model back whole: Blue is not billed by the hook, so its minimum stays.
    const old = await legacy(() => signalOf(h));
    expect(events(old).filter((e) => /minimum/.test(e))).toEqual(["2026-10-20 Amex Blue Cash minimum -143.05"]);
  });
});

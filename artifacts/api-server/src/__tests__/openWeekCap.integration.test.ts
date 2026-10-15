// ⭐ (F6) THE CARD CAP HOLDS THE OPEN WEEK TOO — the owner's rule, pinned on the
// live shape (synthetic: every name, amount and number here is made up).
//
// The live finding (2026-10-15, after F5 shipped): the forecast held a weekly
// in_full card's carried due weeks (dragged to the next business day) PLUS the
// open week's purchases, and the sum read above what the card owes now (its
// balance read mid-week + the week's purchases not in it). The owner's rule:
// the card's carried + current unpaid never exceeds what the card owes; every
// obligation exactly once. So the ceiling (core `cardOwedNowCents`) applies to
// the due weeks AND the open week's purchases together
// (`capHookObligationsAtBalance`), oldest first: the open week keeps its own
// purchases, the excess comes off the oldest carried week. What is left of the
// week's allowance is future spending: never part of the cap.
//
// The shape (`_fixtures/missedAnswersScenario.ts`, answered household): Platinum
// ••7101 weekly, paid in full; a weekly plan of 450 (the live shape; F5's
// fixture had none); the household's payments stop after the 9/22 statement
// payment, so three closed weeks owe — 9/26's remainder 140 (the 9/22 payment
// paid its 9/21 purchase), 10/3's 180 and 10/10's 260 — carried into the
// latest due one and dragged to Fri 10/16. This week's purchases (10/12 55,
// 10/13 35) are PENDING: outside the balance Plaid read. Clock Thu 10/15 15:00
// Central; Platinum's balance read Wed 10/14 15:11 Central.
//
//   U (due unpaid)               140 + 180 + 260 = 580
//   P (this week, pending)       55 + 35 = 90 = the open week's incurred
//   B (balance read)             520.00 → owed now B + P = 610
//   U > B − P (580 > 430), U ≤ B + P (580 ≤ 610): a cap on the due weeks ALONE
//   cuts nothing and the open week's 90 sits on top (670 held, 60 over). The
//   cap on both: 670 − 610 = 60 cut off 9/26, the oldest → 610 held.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, allowancePlansTable, debtsTable, plaidAccountsTable, transactionsTable } from "@workspace/db";
import { resolveAmexAnchor } from "../lib/amexAnchorRead";
import { buildAmexSummary } from "../lib/amexSummary";
import { computeCashSignalDetailed, type CashSignal } from "../lib/cashSignal";
import { cleanupMissedHouseholds, seedMissedHousehold, type MissedHousehold, type MissedRow } from "./_fixtures/missedAnswersScenario";

const NOW = new Date("2026-10-15T15:00:00-05:00");
const READ_AT = new Date("2026-10-14T15:11:00-05:00");

const owners: string[] = [];
const households: string[] = [];

/** The payments after the 9/22 statement payment never happened; this week's purchases are pending. */
const LATER_PAYMENTS = new Set(["c2", "c3", "c4", "kP2", "kP3", "kP4"]);
const THIS_WEEK = new Set(["p10", "p11"]);
const thisWeek = (pending: boolean): MissedRow[] => [
  { key: "p10", on: "2026-10-12", desc: "GREEN GROCER", amt: "-55.00", acct: "platinum", pending },
  { key: "p11", on: "2026-10-13", desc: "FUEL STOP", amt: "-35.00", acct: "platinum", pending },
];

async function household(
  opts: { balance?: string; pending?: boolean; afterSync?: boolean; extra?: MissedRow[]; readAt?: Date; pendingAtRead?: string[] } = {},
): Promise<MissedHousehold> {
  const owner = `f6-opencap-${process.pid}-${randomUUID().slice(0, 8)}`;
  const pending = opts.pending ?? true;
  const h = await seedMissedHousehold(owner, {
    answered: true,
    rows: (r) => !LATER_PAYMENTS.has(r.key) && !THIS_WEEK.has(r.key),
    extra: [...thisWeek(pending), ...(opts.extra ?? [])],
    ...(opts.balance
      ? {
          platinumBalance: {
            balance: opts.balance,
            at: opts.readAt ?? READ_AT,
            ...(opts.afterSync ? { pendingAtRead: opts.pendingAtRead ?? (pending ? ["p10", "p11"] : []) } : {}),
          },
        }
      : {}),
  });
  await db.insert(allowancePlansTable).values({ householdId: h.householdId, memberUserId: null, period: "weekly", amount: "450.00", effectiveFrom: "2026-08-01", source: "owner" });
  owners.push(owner);
  households.push(h.householdId);
  return h;
}

const read = async (h: MissedHousehold): Promise<CashSignal> =>
  (await computeCashSignalDetailed(h.householdId, h.ownerUserId, { horizonDays: 30 })).signal;
const cents = (v: string | number) => Math.round(Number(v) * 100);
const weekly = (sig: CashSignal, h: MissedHousehold) =>
  (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date <= "2026-10-17").map((e) => `${e.date} ${e.amount}`);
const reserves = (sig: CashSignal) =>
  (sig.hookReserves ?? [])
    .filter((r) => r.hook === "weekly" && r.occurrenceDate >= "2026-09-26" && r.occurrenceDate <= "2026-10-17")
    .map(
      (r) =>
        `${r.occurrenceDate} incurred ${r.incurred} + carried ${r.carried} + left ${r.allowanceLeft} · paid ${r.paid} · capped ${r.cappedByBalance ?? "0.00"}${r.carriedTo ? ` → ${r.carriedTo}` : ""}`,
    );
/** What the curve holds for the card's purchases: every week's own unpaid, once (carried or not). */
const heldCents = (sig: CashSignal) => (sig.hookReserves ?? []).filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred), 0);
const openWeek = (sig: CashSignal) => sig.hookReserves!.find((x) => x.hook === "weekly" && x.occurrenceDate === "2026-10-17")!;

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(async () => {
  vi.useRealTimers();
  await cleanupMissedHouseholds(owners, households);
});

describe("⭐ F6 · the card's carried + current unpaid never exceeds what it owes now — the open week is in the cap", () => {
  it("no live balance (control; the archived debt row's 900 is never a cap): every unpaid purchase held once — 580 carried to Fri 10/16, the open week 90 + 360 left of the 450 plan; 670 held", async () => {
    const h = await household();
    const sig = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-16 -580.00", "2026-10-17 -450.00"]);
    expect(reserves(sig)).toEqual([
      "2026-09-26 incurred 140.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 0.00 → 2026-10-10",
      "2026-10-03 incurred 180.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 0.00 → 2026-10-10",
      "2026-10-10 incurred 260.00 + carried 320.00 + left 0.00 · paid 0.00 · capped 0.00",
      "2026-10-17 incurred 90.00 + carried 0.00 + left 360.00 · paid 0.00 · capped 0.00",
    ]);
    expect(heldCents(sig)).toBe(67000);
  });

  for (const afterSync of [false, true]) {
    it(`⭐ balance 520.00 read Wed 15:11 (${afterSync ? "a Sync's read" : "a Refresh"}), this week's 90 pending: owed now 610 = 520 + 90; held (due) + held (open incurred) = 610, never more — the open week keeps its 90, the 60 comes off 9/26, the oldest (a cap on the due weeks alone: 580 ≤ 610, nothing cut, 670 held)`, async () => {
      const h = await household({ balance: "520.00", afterSync });
      const sig = await read(h);
      expect(weekly(sig, h)).toEqual(["2026-10-16 -520.00", "2026-10-17 -450.00"]);
      expect(reserves(sig)).toEqual([
        "2026-09-26 incurred 80.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 60.00 → 2026-10-10",
        "2026-10-03 incurred 180.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 0.00 → 2026-10-10",
        "2026-10-10 incurred 260.00 + carried 260.00 + left 0.00 · paid 0.00 · capped 0.00",
        "2026-10-17 incurred 90.00 + carried 0.00 + left 360.00 · paid 0.00 · capped 0.00",
      ]);
      const dueHeld = -cents(weekly(sig, h)[0]!.split(" ")[1]!);
      expect(dueHeld + cents(openWeek(sig).incurred)).toBe(52000 + 9000);
      expect(heldCents(sig)).toBe(61000);
      // The allowance left is future spending: never part of the cap.
      expect(openWeek(sig).allowanceLeft).toBe("360.00");
      expect(openWeek(sig).cappedByBalance).toBeUndefined();
    });
  }

  it("no pending (this week's 90 posted before the read, inside the 520): owed now 520; held 520 — the open week keeps its 90, the 150 cut comes off 9/26 (140) then 10/3 (10)", async () => {
    const h = await household({ balance: "520.00", pending: false });
    const sig = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-16 -430.00", "2026-10-17 -450.00"]);
    expect(reserves(sig)).toEqual([
      "2026-09-26 incurred 0.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 140.00",
      "2026-10-03 incurred 170.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 10.00 → 2026-10-10",
      "2026-10-10 incurred 260.00 + carried 170.00 + left 0.00 · paid 0.00 · capped 0.00",
      "2026-10-17 incurred 90.00 + carried 0.00 + left 360.00 · paid 0.00 · capped 0.00",
    ]);
    expect(heldCents(sig)).toBe(52000);
  });

  it("the card's balance read 0.00 (a payment from elsewhere cleared it): every carried week is cut, the open week keeps all 90 = owed now (0 + 90 pending)", async () => {
    const h = await household({ balance: "0.00" });
    const sig = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-17 -450.00"]);
    expect(cents(openWeek(sig).incurred)).toBe(9000);
    expect(heldCents(sig)).toBe(9000);
  });

  it("a cap only lowers: a balance above everything held (900.00) cuts nothing — the same 670 as with no balance", async () => {
    const h = await household({ balance: "900.00" });
    const sig = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-16 -580.00", "2026-10-17 -450.00"]);
    expect(heldCents(sig)).toBe(67000);
    expect(sig.hookReserves!.every((x) => x.cappedByBalance === undefined)).toBe(true);
  });
});

// ⭐ (F6 round 2) THE LIVE SHAPE OF THE CARD'S ROW, AND WHY NO CUT WAS SHOWN.
// The lead's read-only evidence (2026-10-15): the per-card anchor answers `plaid`
// (read Wed 15:11 Central, before 0210 shipped: no pending list, no Sync flag);
// the card's debt row is ARCHIVED and linked; the hooks held carried due weeks +
// this week's purchases ABOVE that balance + the purchases pending now — and no
// week read `cappedByBalance`.
//   (A) The suspects (the id the cap reads the anchor by, the owner argument, the
//       archived debt row, the read's day vs the rows read): the cap applies on
//       that shape — the anchor is the card's Plaid balance, one entry per card.
//   (B) What reproduces "no cut": purchases H2 STILL shows pending weeks after
//       their date (bank holds that never posted, kept because the household had
//       flagged them — `plaid_removed_at`). Each counts in its week AND, being
//       pending now, as "outside the balance" in owed-now: the cap rose with the
//       weeks and never cut. Round 2 read such a purchase as inside the balance
//       when dated more than 7 days before the READ's day.
// ⭐ (F6 round 3) The owner's rule (2026-10-15) replaces round 2's: a row still
// pending more than 7 days after its date (the household's TODAY), never
// replaced, is an EXPIRED HOLD and counts nowhere — not in its week, not in
// owed-now — with its pending reversal (round 3: opposite sign, same amount, up
// to 7 days after it; F6 round 4: a pending credit reversing an expired charge,
// up to 31 days after it). Round 2's read-day cut is gone. Every case below runs
// with the rule's kill switch too (`EXPIRED_HOLDS_RULE=off` = the base, 5e2480e1).
describe("⭐ F6 round 2/3 · the live card row: the cap applies; expired holds count nowhere", () => {
  /** The live shape of Platinum's row: a credit liability, read before 0210 (no list, no flag); its debt archived with an old balance. */
  async function liveShape(h: MissedHousehold): Promise<void> {
    await db
      .update(plaidAccountsTable)
      .set({ liabilityKind: "credit", liabilityPendingTxnIds: null, liabilityPendingAfterSync: null })
      .where(eq(plaidAccountsTable.accountId, h.accounts.platinum));
    const [debt] = await db.select().from(debtsTable).where(eq(debtsTable.id, h.debts.platinum));
    expect([debt!.status, debt!.balance, debt!.plaidAccountId != null]).toEqual(["archived", "900.00", true]);
  }
  /** Two bank holds that never posted, still pending in H2, kept by the bank-removed guard. */
  const HOLDS: MissedRow[] = [
    { key: "hold1", on: "2026-09-24", desc: "HARBOR HOTEL HOLD", amt: "-150.00", acct: "platinum", pending: true },
    { key: "hold2", on: "2026-09-30", desc: "CITY CAR RENTAL HOLD", amt: "-250.00", acct: "platinum", pending: true },
  ];
  async function keptByBank(h: MissedHousehold): Promise<void> {
    await db
      .update(transactionsTable)
      .set({ plaidRemovedAt: new Date("2026-10-06T10:00:00-05:00"), weeklyAllowance: true })
      .where(and(eq(transactionsTable.householdId, h.householdId), inArray(transactionsTable.id, [h.txn.hold1!, h.txn.hold2!])));
  }

  it("(A) the suspects: the per-card anchor the cap reads (external Plaid id) is the card's Plaid balance, whatever the owner argument or the archived debt row; the cap applies — 610 held, the 60 off 9/26", async () => {
    const h = await household({ balance: "520.00" });
    await liveShape(h);
    for (const owner of [h.ownerUserId, "someone-else"]) {
      const a = await resolveAmexAnchor(h.householdId, owner, h.accounts.platinum);
      expect([a.source, a.amexEndingBalance, a.asOf]).toEqual(["plaid", 520, READ_AT.toISOString()]);
    }
    const sig = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-16 -520.00", "2026-10-17 -450.00"]);
    expect(heldCents(sig)).toBe(61000);
  });

  /** The same read with the rule's kill switch on: the base's answer (5e2480e1). */
  async function readBase(h: MissedHousehold): Promise<CashSignal> {
    vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
    try {
      return await read(h);
    } finally {
      vi.unstubAllEnvs();
    }
  }
  /** The weekly reserves of the control (no expired hold, nothing capped): the same household with every hold gone. */
  const CONTROL_RESERVES = [
    "2026-09-26 incurred 140.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 0.00 → 2026-10-10",
    "2026-10-03 incurred 180.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 0.00 → 2026-10-10",
    "2026-10-10 incurred 260.00 + carried 320.00 + left 0.00 · paid 0.00 · capped 0.00",
    "2026-10-17 incurred 90.00 + carried 0.00 + left 360.00 · paid 0.00 · capped 0.00",
  ];

  it("⭐ (B, round 3) two bank holds (150 on 9/24, 250 on 9/30) still pending weeks later are expired holds: in no week and not in owed-now — held 670 = what the card owes (580 read + this week's 90 pending), nothing cut (base 5e2480e1: 1,070 held, no cut; round 2: 670 with 400 cut off 9/26 and 10/3)", async () => {
    const h = await household({ balance: "580.00", extra: HOLDS });
    await liveShape(h);
    await keptByBank(h);
    const sig = await read(h);
    expect(reserves(sig)).toEqual(CONTROL_RESERVES);
    expect(weekly(sig, h)).toEqual(["2026-10-16 -580.00", "2026-10-17 -450.00"]);
    expect(heldCents(sig)).toBe(58000 + 9000);
    expect(sig.hookReserves!.every((x) => x.cappedByBalance === undefined)).toBe(true);
    // Kill switch: the base, exactly.
    const base = await readBase(h);
    expect(weekly(base, h)).toEqual(["2026-10-16 -980.00", "2026-10-17 -450.00"]);
    expect(heldCents(base)).toBe(107000);
    expect(base.hookReserves!.every((x) => x.cappedByBalance === undefined)).toBe(true);

    // The card page reads them out the same way: the card summary (9/20 – 10/3
    // purchases: 70 + 140 + 200; base + 150 + 250).
    const summary = () => buildAmexSummary(h.householdId, h.ownerUserId, { accountId: h.accounts.platinum, from: "2026-09-20", to: "2026-10-03", rowsPerGroup: 5 });
    expect((await summary()).purchases).toMatchObject({ amount: "410.00", count: 3 });
    vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
    try {
      expect((await summary()).purchases).toMatchObject({ amount: "810.00", count: 5 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("(B) control: the same holds with no live balance — expired, in no week: 670 held (base: 1,070)", async () => {
    const h = await household({ extra: HOLDS });
    await liveShape(h);
    await keptByBank(h);
    const sig = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-16 -580.00", "2026-10-17 -450.00"]);
    expect(heldCents(sig)).toBe(67000);
    expect(sig.hookReserves!.every((x) => x.cappedByBalance === undefined)).toBe(true);
    const base = await readBase(h);
    expect(weekly(base, h)).toEqual(["2026-10-16 -980.00", "2026-10-17 -450.00"]);
    expect(heldCents(base)).toBe(107000);
  });

  // ⭐ Review finding 1 (round 2): a stale pending ± pair — a hold and its pending
  // reversal — no longer cancelled: round 2 read the hold inside the balance but
  // still subtracted the reversal, so owed-now read low by it and the cap cut real
  // carried purchases (670 → 520: 140 off 9/26, 10 off 10/3). Round 3: the hold is
  // expired and its reversal (same amount, opposite sign, a generic description,
  // within 7 days) goes with it — in no week, not in owed-now.
  const pair = (holdOn: string, reversalOn: string): MissedRow[] => [
    { key: "hold", on: holdOn, desc: "SOME TAVERN 0042", amt: "-150.00", acct: "platinum", pending: true },
    { key: "reversal", on: reversalOn, desc: "Restaurant Transaction", amt: "150.00", acct: "platinum", pending: true },
  ];
  async function pairKeptByBank(h: MissedHousehold): Promise<void> {
    await db
      .update(transactionsTable)
      .set({ plaidRemovedAt: new Date("2026-10-09T10:00:00-05:00"), weeklyAllowance: true })
      .where(and(eq(transactionsTable.householdId, h.householdId), inArray(transactionsTable.id, [h.txn.hold!, h.txn.reversal!])));
  }
  for (const [holdOn, reversalOn, label] of [
    ["2026-10-01", "2026-10-03", "both stale"],
    ["2026-10-05", "2026-10-08", "the variant: the hold 10 days old, its reversal 7 (younger than the rule's 8)"],
  ] as const) {
    it(`⭐ finding 1 — a pending hold ${holdOn} and its pending reversal ${reversalOn} (${label}): held 670 = owed now, nothing cut (base 670; round 2: 520, 140 off 9/26 and 10 off 10/3)`, async () => {
      const h = await household({ balance: "580.00", extra: pair(holdOn, reversalOn) });
      await liveShape(h);
      await pairKeptByBank(h);
      const sig = await read(h);
      expect(reserves(sig)).toEqual(CONTROL_RESERVES);
      expect(weekly(sig, h)).toEqual(["2026-10-16 -580.00", "2026-10-17 -450.00"]);
      expect(heldCents(sig)).toBe(67000);
      // The base: the pair cancelled in its week and in owed-now — the same 670.
      const base = await readBase(h);
      expect(weekly(base, h)).toEqual(["2026-10-16 -580.00", "2026-10-17 -450.00"]);
      expect(heldCents(base)).toBe(67000);
    });
  }

  // ⭐ Review finding 2 (round 2): the window was anchored on the balance READ's
  // day. Card balances are re-read only on a Refresh / Sync / link, while pending
  // flags stay current: after an old read (Sat 10/03) a never-posting hold dated
  // 9/30 and still pending on 10/15 was inside round 2's window and lifted the cap
  // with its week (700 held; 450 without it). Round 3 reads today's age.
  it("⭐ finding 2 — an old read (100.00 on Sat 10/03): a hold dated 9/30, still pending on 10/15, is expired — held 450, the same as without it (base and round 2: 700)", async () => {
    const OLD_READ = new Date("2026-10-03T15:11:00-05:00");
    const hold: MissedRow[] = [{ key: "hold", on: "2026-09-30", desc: "CITY CAR RENTAL HOLD", amt: "-250.00", acct: "platinum", pending: true }];
    const control = await household({ balance: "100.00", readAt: OLD_READ });
    await liveShape(control);
    const h = await household({ balance: "100.00", readAt: OLD_READ, extra: hold });
    await liveShape(h);
    await db.update(transactionsTable).set({ plaidRemovedAt: new Date("2026-10-06T10:00:00-05:00"), weeklyAllowance: true }).where(eq(transactionsTable.id, h.txn.hold!));
    // Owed now: 100 read + the rows after it (10/5 110, 10/9 60, 10/10 90) + this week's 90 pending = 450.
    const ctl = await read(control);
    expect(heldCents(ctl)).toBe(45000);
    const sig = await read(h);
    expect(heldCents(sig)).toBe(45000);
    expect(weekly(sig, h)).toEqual(weekly(ctl, control).map((x) => x));
    expect(reserves(sig)).toEqual(reserves(ctl));
    // The base (kill switch): the hold lifts owed-now with its week — 700.
    expect(heldCents(await readBase(h))).toBe(70000);
    expect(heldCents(await readBase(control))).toBe(45000);
  });

  // ⭐ Review finding 3 (round 2): after a Sync's read, a purchase pending AT the
  // read, dated more than 7 days before it, that has since POSTED in place was
  // read inside the balance (round 2's read-day cut) — owed-now low by it until
  // the next read. Round 3: a posted row keeps the base rule (pending at a Sync's
  // read → outside).
  it("⭐ finding 3 — a Sync's read (520.00, Wed 10/14 15:11) with a 10/05 purchase pending at it that has since posted in place: outside the balance, owed now 660 — 60 cut off 9/26 (round 2: 610, 110 cut)", async () => {
    const late: MissedRow[] = [{ key: "late", on: "2026-10-05", desc: "HARDWARE DEPOT", amt: "-50.00", acct: "platinum" }];
    const h = await household({ balance: "520.00", afterSync: true, pendingAtRead: ["p10", "p11", "late"], extra: late });
    const sig = await read(h);
    expect(reserves(sig)).toEqual([
      "2026-09-26 incurred 80.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 60.00 → 2026-10-10",
      "2026-10-03 incurred 180.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 0.00 → 2026-10-10",
      "2026-10-10 incurred 310.00 + carried 260.00 + left 0.00 · paid 0.00 · capped 0.00",
      "2026-10-17 incurred 90.00 + carried 0.00 + left 360.00 · paid 0.00 · capped 0.00",
    ]);
    expect(weekly(sig, h)).toEqual(["2026-10-16 -570.00", "2026-10-17 -450.00"]);
    expect(heldCents(sig)).toBe(66000);
    // The base reads it the same: no expired hold here.
    expect(heldCents(await readBase(h))).toBe(66000);
  });
});

// ⭐ (F6 round 4) Two review findings on round 3, on the same live card row.
//   Finding 8: a hotel or car-rental reversal comes LATE — more than 7 days after
//   its hold. Round 3 paired a reversal only up to 7 days after; one dated later
//   expired its hold alone and counted on its own as a −150 refund (its week's
//   purchases 260 → 110, owed-now 670 → 520: real carried purchases cut). Lead's
//   decision: an expired charge takes its reversal credit up to 31 days after.
//   Finding 10: an expired CREDIT (an orphan "Restaurant Transaction" whose hold a
//   tipped final replaced) took a 3-day-old real purchase of the same amount as
//   its "reversal". Lead's decision: only an expired charge takes a reversal.
describe("⭐ F6 round 4 · late reversals cancel their hold; an orphan credit never takes a purchase", () => {
  async function liveShape(h: MissedHousehold): Promise<void> {
    await db
      .update(plaidAccountsTable)
      .set({ liabilityKind: "credit", liabilityPendingTxnIds: null, liabilityPendingAfterSync: null })
      .where(eq(plaidAccountsTable.accountId, h.accounts.platinum));
  }
  async function readBase(h: MissedHousehold): Promise<CashSignal> {
    vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
    try {
      return await read(h);
    } finally {
      vi.unstubAllEnvs();
    }
  }
  const hotel = (holdOn: string, reversalOn: string): MissedRow[] => [
    { key: "hold", on: holdOn, desc: "HARBOR HOTEL HOLD", amt: "-150.00", acct: "platinum", pending: true },
    { key: "reversal", on: reversalOn, desc: "Hotel Transaction", amt: "150.00", acct: "platinum", pending: true },
  ];
  const CONTROL = [
    "2026-09-26 incurred 140.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 0.00 → 2026-10-10",
    "2026-10-03 incurred 180.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 0.00 → 2026-10-10",
    "2026-10-10 incurred 260.00 + carried 320.00 + left 0.00 · paid 0.00 · capped 0.00",
    "2026-10-17 incurred 90.00 + carried 0.00 + left 360.00 · paid 0.00 · capped 0.00",
  ];

  for (const [holdOn, reversalOn, gap] of [
    ["2026-10-01", "2026-10-08", 7],
    ["2026-10-01", "2026-10-09", 8],
    ["2026-09-10", "2026-10-10", 30],
  ] as const) {
    it(`⭐ finding 8 — a hotel hold ${holdOn} −150 and its reversal ${reversalOn} +150, ${gap} days later, both pending: the pair counts nowhere — held 670, Fri −580, lowest 1,370 (= the control)`, async () => {
      const h = await household({ balance: "580.00", extra: hotel(holdOn, reversalOn) });
      await liveShape(h);
      const sig = await read(h);
      expect(reserves(sig)).toEqual(CONTROL);
      expect(weekly(sig, h)).toEqual(["2026-10-16 -580.00", "2026-10-17 -450.00"]);
      expect(heldCents(sig)).toBe(67000);
      expect(sig.lowestProjected).toBe("1370.00");
      // The base (kill switch) reads the same: the pair cancelled in owed-now and
      // across its weeks. (Round 3: at 8 and 30 days the hold expired alone and
      // the reversal counted as a −150 refund — held 520, Fri −430, lowest 1,520.)
      const base = await readBase(h);
      expect({ fri: weekly(base, h)[0], held: heldCents(base) / 100, lowest: base.lowestProjected }).toEqual({ fri: "2026-10-16 -580.00", held: 670, lowest: "1370.00" });
    });
  }

  it("finding 8, the edge — a reversal 32 days after its hold is no reversal: the hold expires alone, and the credit (5 days old) counts on its own as a refund until it is 8 days old", async () => {
    const h = await household({ balance: "580.00", extra: hotel("2026-09-08", "2026-10-10") });
    await liveShape(h);
    const sig = await read(h);
    expect(reserves(sig)[2]).toBe("2026-10-10 incurred 110.00 + carried 320.00 + left 0.00 · paid 0.00 · capped 0.00");
    expect(heldCents(sig)).toBe(52000);
    expect(weekly(sig, h)[0]).toBe("2026-10-16 -430.00");
    // The base cancelled the two across their weeks (the 9/12 week's 150 carried): 670.
    const base = await readBase(h);
    expect({ fri: weekly(base, h)[0], held: heldCents(base) / 100, lowest: base.lowestProjected }).toEqual({ fri: "2026-10-16 -580.00", held: 670, lowest: "1370.00" });
  });

  it("⭐ finding 10 — an orphan credit (+40 'Restaurant Transaction', 10/07, its hold replaced by a tipped final) expires ALONE; the real 10/12 BOOK NOOK −40 (3 days old) counts: open week 130 bought, 320 left", async () => {
    const coffee: MissedRow[] = [
      { key: "coffeeHold", on: "2026-10-06", desc: "COFFEE BAR", amt: "-40.00", acct: "platinum", pending: true },
      { key: "coffeeFinal", on: "2026-10-07", desc: "COFFEE BAR", amt: "-48.00", acct: "platinum" },
      { key: "orphan", on: "2026-10-07", desc: "Restaurant Transaction", amt: "40.00", acct: "platinum", pending: true },
      { key: "book", on: "2026-10-12", desc: "BOOK NOOK", amt: "-40.00", acct: "platinum", pending: true },
    ];
    const h = await household({ balance: "580.00", extra: coffee });
    await liveShape(h);
    const sig = await read(h);
    expect(openWeek(sig)).toMatchObject({ incurred: "130.00", allowanceLeft: "320.00" });
    expect(weekly(sig, h)[1]).toBe("2026-10-17 -450.00");
    // Owed now: 580 read + this week's 130 pending = 710 = held; the tipped final
    // (−48, posted 10/07, inside the read) lifts its week and the cut comes off 9/26.
    expect({ reserves: reserves(sig), held: heldCents(sig) / 100, fri: weekly(sig, h)[0], lowest: sig.lowestProjected }).toEqual({
      reserves: [
        "2026-09-26 incurred 92.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 48.00 → 2026-10-10",
        "2026-10-03 incurred 180.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 0.00 → 2026-10-10",
        "2026-10-10 incurred 308.00 + carried 272.00 + left 0.00 · paid 0.00 · capped 0.00",
        "2026-10-17 incurred 130.00 + carried 0.00 + left 320.00 · paid 0.00 · capped 0.00",
      ],
      held: 710,
      fri: "2026-10-16 -580.00",
      lowest: "1370.00",
    });
    // The base (kill switch): the orphan credit counted as a +40 refund in the
    // 10/10 week and off owed-now (670) — money that never came back. (Round 3:
    // the orphan took the 10/12 BOOK NOOK with it, so the open week read 90
    // bought, 360 left: a real purchase counted nowhere.)
    const base = await readBase(h);
    expect({ reserves: reserves(base), held: heldCents(base) / 100, fri: weekly(base, h)[0], lowest: base.lowestProjected }).toEqual({
      reserves: [
        "2026-09-26 incurred 92.00 + carried 0.00 + left 0.00 · paid 70.00 · capped 48.00 → 2026-10-10",
        "2026-10-03 incurred 180.00 + carried 0.00 + left 0.00 · paid 0.00 · capped 0.00 → 2026-10-10",
        "2026-10-10 incurred 268.00 + carried 272.00 + left 0.00 · paid 0.00 · capped 0.00",
        "2026-10-17 incurred 130.00 + carried 0.00 + left 320.00 · paid 0.00 · capped 0.00",
      ],
      held: 670,
      fri: "2026-10-16 -540.00",
      lowest: "1410.00",
    });
  });
});

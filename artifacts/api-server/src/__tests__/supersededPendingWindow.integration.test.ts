// (PR-D review M3) The WINDOWED pairing read gives, for every row dated inside
// its range, exactly the answer of pairing the household's whole ledger:
//   - which pending rows a posted row replaced, and
//   - which pending row each posted row replaced (with its filing, review H1).
// It never runs a candidate query, or the pairing, when no pending row is in reach.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

vi.mock("@workspace/avalanche-core", async () => {
  const actual = await vi.importActual<typeof import("@workspace/avalanche-core")>(
    "@workspace/avalanche-core",
  );
  return { ...actual, pairPendingWithPostedAmong: vi.fn(actual.pairPendingWithPostedAmong) };
});

import { db, transactionsTable } from "@workspace/db";
import { expiredHolds, heldExpiredPairs, isInSnapshot, pairPendingWithPosted, pairPendingWithPostedAmong } from "@workspace/avalanche-core";
import {
  findExpiredLabelsAmong,
  findSupersededPending,
  findSupersededPendingForRange,
} from "../lib/supersededPending";
import { createTestHousehold } from "./_helpers/testHousehold";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const USERS = {
  random: `prd-win-random-${RUN}`,
  chain: `prd-win-chain-${RUN}`,
  none: `prd-win-none-${RUN}`,
  filing: `prd-win-filing-${RUN}`,
  expired: `prd-win-expired-${RUN}`,
  reversalChain: `prd-win-revchain-${RUN}`,
  reversalSkip: `prd-win-revskip-${RUN}`,
  outside: `prd-win-outside-${RUN}`,
  lateReversal: `prd-win-late-${RUN}`,
  labels: `prd-win-labels-${RUN}`,
};
const households = {} as Record<keyof typeof USERS, string>;

type Row = {
  occurredOn: string;
  amount: string;
  description: string;
  plaidAccountId: string;
  pending: boolean;
  createdAt: Date;
  categoryId?: string | null;
  weeklyAllowance?: boolean;
  weeklyBucket?: string | null;
};

async function insertRows(key: keyof typeof USERS, rows: Row[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const out = await db
      .insert(transactionsTable)
      .values(
        rows.slice(i, i + 500).map((r) => ({
          userId: USERS[key],
          householdId: households[key],
          source: "plaid:chase",
          ...r,
        })),
      )
      .returning({ id: transactionsTable.id });
    ids.push(...out.map((o) => o.id));
  }
  return ids;
}

const at = (day: string, minutes = 0) => {
  const d = new Date(`${day}T15:00:00Z`);
  d.setUTCMinutes(minutes);
  return d;
};
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The reference: PR4c's pairing over EVERY row, restricted to the range. */
async function wholeLedgerAnswer(householdId: string, from: string, to: string) {
  const all = await db
    .select({
      id: transactionsTable.id,
      plaidAccountId: transactionsTable.plaidAccountId,
      pending: transactionsTable.pending,
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
      description: transactionsTable.description,
      createdAt: transactionsTable.createdAt,
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.householdId, householdId));
  const byId = new Map(all.map((r) => [r.id, r]));
  const pairs = pairPendingWithPosted(all.map((r) => ({ ...r, amount: Number(r.amount) })));
  const inRange = (d: string) => d >= from && d <= to;
  return {
    replaced: [...pairs.values()].filter((p) => inRange(p.occurredOn)).map((p) => p.id).sort(),
    pairs: [...pairs.entries()]
      .filter(([postedId]) => inRange(byId.get(postedId)!.occurredOn))
      .map(([postedId, p]) => `${postedId}>${p.id}`)
      .sort(),
  };
}

const windowedAnswer = (r: Awaited<ReturnType<typeof findSupersededPendingForRange>>) => ({
  replaced: [...r.replacedIds].sort(),
  pairs: [...r.replacedBy.entries()].map(([postedId, p]) => `${postedId}>${p.id}`).sort(),
});

beforeAll(async () => {
  for (const key of Object.keys(USERS) as (keyof typeof USERS)[]) {
    households[key] = (await createTestHousehold(USERS[key])).householdId;
  }
});
afterAll(async () => {
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, Object.values(USERS)));
});

describe("findSupersededPendingForRange — the whole-ledger answer inside the range", () => {
  it("⭐ equals whole-ledger pairing on a dense randomized ledger of chains, for every month and 40 random ranges", async () => {
    // mulberry32, fixed seed. $5 pending / $6 posted at one merchant on two
    // cards, 50% pending, arrivals up to two days late: greedy one-to-one
    // chains run straight through every window edge.
    let seed = 20260912;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const accounts = [`acct-w1-${RUN}`, `acct-w2-${RUN}`];
    const rows: Row[] = [];
    for (let i = 0; i < 700; i += 1) {
      const day = addDays("2026-05-01", Math.floor(rand() * 120));
      const pending = rand() < 0.5;
      rows.push({
        occurredOn: day,
        amount: pending ? (rand() < 0.5 ? "-5.00" : "-5.50") : rand() < 0.5 ? "-6.00" : "-5.50",
        description: rand() < 0.8 ? "STARBUCKS STORE 1234" : "STARBUCKS",
        plaidAccountId: accounts[Math.floor(rand() * accounts.length)]!,
        pending,
        createdAt: at(day, Math.floor(rand() * 2880)),
      });
    }
    await insertRows("random", rows);

    const ranges: [string, string][] = [
      ["2026-05-01", "2026-05-31"],
      ["2026-06-01", "2026-06-30"],
      ["2026-07-01", "2026-07-31"],
      ["2026-08-01", "2026-08-31"],
    ];
    for (let i = 0; i < 40; i += 1) {
      const from = addDays("2026-04-20", Math.floor(rand() * 130));
      ranges.push([from, addDays(from, Math.floor(rand() * 35))]);
    }

    let extended = 0;
    let compared = 0;
    for (const [from, to] of ranges) {
      const reference = await wholeLedgerAnswer(households.random, from, to);
      const windowed = await findSupersededPendingForRange(households.random, from, to);
      expect(windowedAnswer(windowed), `${from}..${to}`).toEqual(reference);
      // A chain crossed from − 7, so the pairing started earlier than a fixed window would.
      if (windowed.windowStart !== null && windowed.windowStart < addDays(from, -7)) extended += 1;
      compared += reference.pairs.length;
    }
    // The fixture exercises what it claims: many pairs, and chains that
    // pushed the window's start back.
    expect(compared).toBeGreaterThan(200);
    expect(extended).toBeGreaterThan(0);

    // And a month reads fewer rows than the whole ledger does.
    const whole = await findSupersededPending(households.random);
    const june = await findSupersededPendingForRange(households.random, "2026-06-01", "2026-06-30");
    expect(june.rowsRead).toBeLessThan(whole.rowsRead);
  });

  it("a chain crossing the window's start pushes the start back instead of re-pairing (the 11.00 case)", async () => {
    const card = `acct-chain-${RUN}`;
    const row = (occurredOn: string, amount: string, pending: boolean): Row => ({
      occurredOn,
      amount,
      description: "STARBUCKS STORE 1234",
      plaidAccountId: card,
      pending,
      createdAt: at(occurredOn),
    });
    const [p0813, p0817, q0818, p0823, q0824] = await insertRows("chain", [
      row("2026-08-13", "-5.00", true),
      row("2026-08-17", "-5.00", true),
      row("2026-08-18", "-6.00", false),
      row("2026-08-23", "-5.00", true),
      row("2026-08-24", "-6.00", false),
    ]);
    // Range 8/23–8/29: a window starting 8/15 would let 8/18 take 8/17 and
    // 8/24 take 8/23. The whole ledger says 8/18 took 8/13, 8/24 took 8/17,
    // and 8/23 is still pending.
    const r = await findSupersededPendingForRange(households.chain, "2026-08-23", "2026-08-29");
    expect([...r.replacedIds]).toEqual([]);
    expect(r.replacedBy.get(q0824!)?.id).toBe(p0817);
    expect(r.replacedIds.has(p0823!)).toBe(false);
    // One read; the cut moved back to 8/13, the first day no accepted pair crosses.
    expect(r.queries).toBe(1);
    expect(r.windowStart).toBe("2026-08-13");
    expect(windowedAnswer(r)).toEqual(await wholeLedgerAnswer(households.chain, "2026-08-23", "2026-08-29"));
    // Rows outside the range are not reported, even when paired.
    expect(r.replacedBy.has(q0818!)).toBe(false);
    expect(r.replacedIds.has(p0813!)).toBe(false);
  });

  it("no pending row in [from − 7 days, to]: no candidate query and no pairing call", async () => {
    const card = `acct-none-${RUN}`;
    await insertRows("none", [
      // 8 days before the range: can only be replaced before it starts.
      { occurredOn: "2027-02-21", amount: "-5.00", description: "SHELL OIL 57442", plaidAccountId: card, pending: true, createdAt: at("2027-02-21") },
      { occurredOn: "2027-03-02", amount: "-6.00", description: "SHELL OIL 57442", plaidAccountId: card, pending: false, createdAt: at("2027-03-02") },
      // After the range: not this range's business.
      { occurredOn: "2027-04-01", amount: "-5.00", description: "SHELL OIL 57442", plaidAccountId: card, pending: true, createdAt: at("2027-04-01") },
    ]);
    const spy = vi.mocked(pairPendingWithPostedAmong);
    spy.mockClear();
    const r = await findSupersededPendingForRange(households.none, "2027-03-01", "2027-03-31");
    expect(r.queries).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(r.replacedIds.size).toBe(0);
    expect(r.replacedBy.size).toBe(0);
    expect(windowedAnswer(r)).toEqual(await wholeLedgerAnswer(households.none, "2027-03-01", "2027-03-31"));
  });

  it("each pair carries the replaced pending row's filing, for the posted row to inherit (review H1)", async () => {
    const card = `acct-filing-${RUN}`;
    const catId = randomUUID();
    const [pendingId, postedId] = await insertRows("filing", [
      { occurredOn: "2026-12-10", amount: "-40.00", description: "OLIVE GARDEN 1234", plaidAccountId: card, pending: true, createdAt: at("2026-12-10"), categoryId: catId, weeklyAllowance: true, weeklyBucket: "dining" },
      { occurredOn: "2026-12-11", amount: "-48.00", description: "OLIVE GARDEN 1234", plaidAccountId: card, pending: false, createdAt: at("2026-12-11") },
    ]);
    const r = await findSupersededPendingForRange(households.filing, "2026-12-01", "2026-12-31");
    expect(r.replacedIds.has(pendingId!)).toBe(true);
    expect(r.replacedBy.get(postedId!)).toEqual({
      id: pendingId,
      occurredOn: "2026-12-10",
      description: "OLIVE GARDEN 1234",
      filing: {
        categoryId: catId,
        weeklyAllowance: true,
        monthlyAllowance: false,
        unplannedAllowance: false,
        weeklyBucket: "dining",
        reimbursable: false,
        debtId: null,
        isTransfer: false,
        isTransferUserOverridden: false,
        // (PR-A) The pending row's lock travels with its category.
        categoryLockedByUser: false,
      },
      // (F2) Its Plaid categories ride along as evidence (never filing); this row has none.
      pfc: { pfcPrimary: null, pfcDetailed: null },
    });
  });
});

// ⭐ (F6 round 3) THE EXPIRED HOLDS IN A RANGE ARE THE WHOLE LEDGER'S. A row dated
// before today − 7 is expired when pending and not replaced; a younger one only
// as the reversal of an expired hold — and that pairing (one to one, oldest hold
// first) chains back through older pending rows of the same amount and opposite
// signs. The range read starts its pairing at a clean cut before the range (and
// reads the replaced rows from there); these tests hold it to the whole-ledger
// answer: `expiredHolds` over every row, with the whole ledger's replaced rows.
async function wholeLedgerExpired(householdId: string, from: string, to: string, today: string): Promise<string[]> {
  const all = await db
    .select({
      id: transactionsTable.id,
      plaidAccountId: transactionsTable.plaidAccountId,
      pending: transactionsTable.pending,
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
      description: transactionsTable.description,
      createdAt: transactionsTable.createdAt,
      // (F6 round 5) What makes a credit a payment or a transfer (never a reversal).
      isTransfer: transactionsTable.isTransfer,
      debtId: transactionsTable.debtId,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      pfcPrimary: transactionsTable.pfcPrimary,
      pfcDetailed: transactionsTable.pfcDetailed,
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.householdId, householdId));
  const rows = all.map((r) => ({ ...r, amount: Number(r.amount) }));
  const replaced = new Set([...pairPendingWithPosted(rows).values()].map((p) => p.id));
  const { expiredIds } = expiredHolds(rows, today, replaced);
  return rows.filter((r) => r.occurredOn >= from && r.occurredOn <= to && expiredIds.has(r.id)).map((r) => r.id).sort();
}

describe("(F6 round 3) findSupersededPendingForRange — expired holds, the whole-ledger answer inside the range", () => {
  it("⭐ equals expiredHolds over the whole ledger on a dense randomized ledger of ± holds, reversals and postings, for 60 ranges and three todays", async () => {
    let seed = 20261015;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const accounts = [`acct-x1-${RUN}`, `acct-x2-${RUN}`];
    // (F6 round 5) A payment among them: never a reversal, in either read.
    const descs = ["SOME TAVERN 0042", "Restaurant Transaction", "HARBOR HOTEL HOLD", "Hotel Transaction", "PAYMENT - THANK YOU"];
    const rows: Row[] = [];
    for (let i = 0; i < 600; i += 1) {
      const day = addDays("2026-10-01", Math.floor(rand() * 75));
      const pending = rand() < 0.7;
      const sign = rand() < 0.5 ? "-" : "";
      rows.push({
        occurredOn: day,
        amount: `${sign}${rand() < 0.5 ? "20.00" : "35.50"}`,
        description: descs[Math.floor(rand() * descs.length)]!,
        plaidAccountId: accounts[Math.floor(rand() * accounts.length)]!,
        pending,
        createdAt: at(day, Math.floor(rand() * 2880)),
      });
    }
    await insertRows("expired", rows);

    let compared = 0;
    let young = 0;
    for (const today of ["2026-11-20", "2026-12-01", "2026-12-14"]) {
      const ranges: [string, string][] = [
        ["2026-10-01", "2026-12-14"],
        [addDays(today, -6), today],
        [addDays(today, -13), addDays(today, -7)],
      ];
      for (let i = 0; i < 17; i += 1) {
        const from = addDays("2026-09-25", Math.floor(rand() * 85));
        ranges.push([from, addDays(from, Math.floor(rand() * 20))]);
      }
      for (const [from, to] of ranges) {
        const reference = await wholeLedgerExpired(households.expired, from, to, today);
        const r = await findSupersededPendingForRange(households.expired, from, to, db, { today });
        expect([...r.expiredIds].sort(), `${from}..${to} on ${today}`).toEqual(reference);
        compared += reference.length;
        if (to >= addDays(today, -7)) young += reference.length;
      }
    }
    // The fixture exercises what it claims: many expired rows, in ranges that reach the young days.
    expect(compared).toBeGreaterThan(300);
    expect(young).toBeGreaterThan(0);
  });

  it("a young reversal in the range whose hold is OUTSIDE it is still named (the read reaches back for the hold)", async () => {
    const card = `acct-outside-${RUN}`;
    const [hold, reversal] = await insertRows("outside", [
      { occurredOn: "2026-10-03", amount: "-64.18", description: "SOME TAVERN 0042", plaidAccountId: card, pending: true, createdAt: at("2026-10-03") },
      { occurredOn: "2026-10-09", amount: "64.18", description: "Restaurant Transaction", plaidAccountId: card, pending: true, createdAt: at("2026-10-09") },
    ]);
    const today = "2026-10-15";
    const week = await findSupersededPendingForRange(households.outside, "2026-10-04", "2026-10-10", db, { today });
    expect([...week.expiredIds]).toEqual([reversal]);
    // The hold's own week names the hold; the whole ledger names both.
    expect([...(await findSupersededPendingForRange(households.outside, "2026-09-27", "2026-10-03", db, { today })).expiredIds]).toEqual([hold]);
    expect([...(await findSupersededPending(households.outside, db, { today })).expiredIds].sort()).toEqual([hold!, reversal!].sort());
    // A day earlier the reversal's hold was 11 days old too, so the same; the
    // reversal itself only became "young" — the rule never needed its own age.
    expect([...(await findSupersededPendingForRange(households.outside, "2026-10-04", "2026-10-10", db, { today: "2026-10-14" })).expiredIds]).toEqual([reversal]);
    // Before the hold was 8 days old: nothing.
    expect((await findSupersededPendingForRange(households.outside, "2026-10-01", "2026-10-10", db, { today: "2026-10-10" })).expiredIds.size).toBe(0);
  });

  it("⭐ (F6 round 4, re-derived round 5 and 6) a chain of charges and credits of one amount, each credit up to 31 days from several charges, pushes the pairing's start back instead of re-pairing", async () => {
    const card = `acct-revchain-${RUN}`;
    // Charges −20 every 5 days 9/01 … 10/01 (all expired on 10/15) and credits
    // +20 six days after each of the first six (9/07 … 10/02), then one young
    // credit 10/12 (3 days old). ⭐ (F6 round 6) A maximum matching: all seven
    // credits pair (the 9/07 credit takes 9/01, which no later credit can
    // reach, …), the young 10/12 credit included — 14 rows.
    // (Round 5, the credit greedy: 9/07↔9/06 … 10/02↔10/01, and 10/12 found
    // every charge since 9/11 taken: it counted — 13. Round 4: 10/01 took 10/12.)
    const charges = Array.from({ length: 7 }, (_, i) => addDays("2026-09-01", i * 5));
    const credits = charges.slice(0, 6).map((d) => addDays(d, 6)).concat(["2026-10-12"]);
    const rows = [
      ...charges.map((d) => ({ occurredOn: d, amount: "-20.00", description: "PARKING GARAGE", plaidAccountId: card, pending: true, createdAt: at(d) })),
      ...credits.map((d) => ({ occurredOn: d, amount: "20.00", description: "Parking Transaction", plaidAccountId: card, pending: true, createdAt: at(d) })),
    ];
    await insertRows("reversalChain", rows);
    const today = "2026-10-15";
    const ids = await db.select({ id: transactionsTable.id, on: transactionsTable.occurredOn, amount: transactionsTable.amount }).from(transactionsTable).where(eq(transactionsTable.householdId, households.reversalChain));
    const young = ids.find((r) => r.on === "2026-10-12")!.id;
    const all = await findSupersededPending(households.reversalChain, db, { today });
    expect(all.expiredIds.size).toBe(14);
    expect(all.expiredIds.has(young)).toBe(true);
    for (const [from, to] of [
      ["2026-10-08", "2026-10-15"],
      ["2026-10-11", "2026-10-17"],
      ["2026-10-12", "2026-10-12"],
      ["2026-10-01", "2026-10-15"],
      ["2026-09-01", "2026-10-15"],
    ] as const) {
      const r = await findSupersededPendingForRange(households.reversalChain, from, to, db, { today });
      expect([...r.expiredIds].sort(), `${from}..${to}`).toEqual(await wholeLedgerExpired(households.reversalChain, from, to, today));
    }
    const week = await findSupersededPendingForRange(households.reversalChain, "2026-10-11", "2026-10-17", db, { today });
    expect(week.expiredIds.has(young)).toBe(true);
    // The chain reaches back about six weeks from the range: the pairing started at 9/01 or before.
    expect(week.windowStart === null || week.windowStart <= "2026-09-01").toBe(true);
  });

  it("⭐ (F6 round 5) the same chain with the 9/12 credit missing: 9/11 stays free, and the young 10/12 credit takes it, 31 days back — a range holding only the young days still names it", async () => {
    const card = `acct-revskip-${RUN}`;
    const charges = Array.from({ length: 7 }, (_, i) => addDays("2026-09-01", i * 5));
    const credits = charges.slice(0, 6).map((d) => addDays(d, 6)).filter((d) => d !== "2026-09-12").concat(["2026-10-12"]);
    await insertRows("reversalSkip", [
      ...charges.map((d) => ({ occurredOn: d, amount: "-20.00", description: "PARKING GARAGE", plaidAccountId: card, pending: true, createdAt: at(d) })),
      ...credits.map((d) => ({ occurredOn: d, amount: "20.00", description: "Parking Transaction", plaidAccountId: card, pending: true, createdAt: at(d) })),
    ]);
    const today = "2026-10-15";
    const ids = await db.select({ id: transactionsTable.id, on: transactionsTable.occurredOn }).from(transactionsTable).where(eq(transactionsTable.householdId, households.reversalSkip));
    const young = ids.find((r) => r.on === "2026-10-12")!.id;
    expect((await findSupersededPending(households.reversalSkip, db, { today })).expiredIds.has(young)).toBe(true);
    for (const [from, to] of [
      ["2026-10-11", "2026-10-17"],
      ["2026-10-12", "2026-10-12"],
      ["2026-09-10", "2026-09-12"],
    ] as const) {
      const r = await findSupersededPendingForRange(households.reversalSkip, from, to, db, { today });
      expect([...r.expiredIds].sort(), `${from}..${to}`).toEqual(await wholeLedgerExpired(households.reversalSkip, from, to, today));
    }
    expect((await findSupersededPendingForRange(households.reversalSkip, "2026-10-11", "2026-10-17", db, { today })).expiredIds.has(young)).toBe(true);
  });

  it("⭐ (F6 round 4) a reversal 30 days after its hold is named by a range holding only the reversal; 32 days after, it is not a reversal", async () => {
    const card = `acct-late-${RUN}`;
    await insertRows("lateReversal", [
      { occurredOn: "2026-09-12", amount: "-150.00", description: "HARBOR HOTEL HOLD", plaidAccountId: card, pending: true, createdAt: at("2026-09-12") },
      { occurredOn: "2026-10-12", amount: "150.00", description: "Hotel Transaction", plaidAccountId: card, pending: true, createdAt: at("2026-10-12") },
      { occurredOn: "2026-09-10", amount: "-75.00", description: "CITY CAR RENTAL HOLD", plaidAccountId: card, pending: true, createdAt: at("2026-09-10") },
      { occurredOn: "2026-10-12", amount: "75.00", description: "Car Rental Transaction", plaidAccountId: card, pending: true, createdAt: at("2026-10-12") },
    ]);
    const today = "2026-10-15";
    const rows = await db.select({ id: transactionsTable.id, amount: transactionsTable.amount }).from(transactionsTable).where(eq(transactionsTable.householdId, households.lateReversal));
    const byAmount = (a: string) => rows.find((r) => r.amount === a)!.id;
    const week = await findSupersededPendingForRange(households.lateReversal, "2026-10-11", "2026-10-17", db, { today });
    // 9/12 → 10/12 is 30 days: a reversal, expired with its hold. 9/10 → 10/12 is 32: the credit (3 days old) counts.
    expect([...week.expiredIds]).toEqual([byAmount("150.00")]);
    expect([...week.expiredIds].sort()).toEqual(await wholeLedgerExpired(households.lateReversal, "2026-10-11", "2026-10-17", today));
    expect((await findSupersededPending(households.lateReversal, db, { today })).expiredIds.has(byAmount("75.00"))).toBe(false);
  });
});

// ⭐ (Final polish, round 6 verifier) THE LIST'S LABELS = THE WHOLE LEDGER.
// `findExpiredLabelsAmong` (the list's read: every pair, the snapshot's
// preference) reads a window, and the pairing is a maximum matching: a later
// credit can move an earlier credit's pair. So the window reaches FORWARD to a
// clean cut (`forwardCleanCut`). On a randomized ledger of holds, reversals,
// payments and look-alikes on a checking account (the snapshot's) and a card,
// for random ranges, two "todays" and three snapshot days, every asked row's
// label (expired hold / expired held pair / none) equals the whole ledger's
// (`expiredHolds` + `heldExpiredPairs` over every row, the same `isHeld`). This
// is the test that fails when the forward cut is switched off.
describe("findExpiredLabelsAmong — the whole-ledger labels inside any range", () => {
  it("⭐ equals the whole-ledger pairing with the same snapshot test, for random ranges, two todays and three snapshot days", async () => {
    let seed = 4242;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const chk = `acct-lab-chk-${RUN}`;
    const card = `acct-lab-card-${RUN}`;
    const descs = ["SOME TAVERN 0042", "Restaurant Transaction", "HARBOR HOTEL HOLD", "Hotel Transaction", "PAYMENT - THANK YOU"];
    const rows: Row[] = [];
    for (let i = 0; i < 400; i += 1) {
      const day = addDays("2026-08-01", Math.floor(rand() * 100));
      rows.push({
        occurredOn: day,
        amount: `${rand() < 0.5 ? "-" : ""}${["20.00", "35.50", "12.00"][Math.floor(rand() * 3)]}`,
        description: descs[Math.floor(rand() * descs.length)]!,
        plaidAccountId: rand() < 0.7 ? chk : card,
        pending: rand() < 0.75,
        createdAt: at(day, Math.floor(rand() * 2880)),
      });
    }
    await insertRows("labels", rows);
    const all = (
      await db
        .select({
          id: transactionsTable.id,
          plaidAccountId: transactionsTable.plaidAccountId,
          pending: transactionsTable.pending,
          occurredOn: transactionsTable.occurredOn,
          amount: transactionsTable.amount,
          description: transactionsTable.description,
          createdAt: transactionsTable.createdAt,
          occurredAt: transactionsTable.occurredAt,
        })
        .from(transactionsTable)
        .where(eq(transactionsTable.householdId, households.labels))
    ).map((r) => ({ ...r, amount: Number(r.amount) }));
    const byId = new Map(all.map((r) => [r.id, r] as const));
    const replaced = new Set([...pairPendingWithPosted(all).values()].map((p) => p.id));
    const snapRow = (r: (typeof all)[number]) => ({
      occurredOn: r.occurredOn,
      amount: r.amount,
      createdAt: r.createdAt,
      occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
      plaidAccountId: r.plaidAccountId,
    });
    let compared = 0;
    let pairsSeen = 0;
    for (const today of ["2026-10-15", "2026-11-02"]) {
      for (const snapDay of ["2026-09-05", "2026-09-28", "2026-10-10"]) {
        const anchor = { at: new Date(`${snapDay}T14:00:00Z`), day: snapDay };
        const held = (r: (typeof all)[number]) => r.plaidAccountId === chk && isInSnapshot(snapRow(r), anchor.at, anchor.day);
        const whole = expiredHolds(all, today, replaced, { isHeld: (r) => held(byId.get(r.id)!) });
        const pairs = heldExpiredPairs(
          whole.holdOf,
          (id) => {
            const r = byId.get(id);
            return r && r.plaidAccountId === chk ? snapRow(r) : undefined;
          },
          anchor,
        );
        for (let i = 0; i < 12; i += 1) {
          const from = addDays("2026-07-25", Math.floor(rand() * 105));
          const to = addDays(from, Math.floor(rand() * 25));
          const asked = all.filter((r) => r.occurredOn >= from && r.occurredOn <= to);
          const got = await findExpiredLabelsAmong(households.labels, asked, { anchor, accountExternalId: chk }, db, { today });
          const wantHold = asked.filter((r) => whole.expiredIds.has(r.id) && !pairs.has(r.id)).map((r) => r.id).sort();
          const wantPair = asked.filter((r) => whole.expiredIds.has(r.id) && pairs.has(r.id)).map((r) => r.id).sort();
          expect([...got.expiredPair].sort(), `pair ${from}..${to} today ${today} snap ${snapDay}`).toEqual(wantPair);
          expect([...got.expiredHold].sort(), `hold ${from}..${to} today ${today} snap ${snapDay}`).toEqual(wantHold);
          compared += wantHold.length + wantPair.length;
          pairsSeen += wantPair.length;
        }
      }
    }
    // The fixture exercises what it claims: many labels, held pairs among them.
    expect(compared).toBeGreaterThan(50);
    expect(pairsSeen).toBeGreaterThan(0);
  });
});

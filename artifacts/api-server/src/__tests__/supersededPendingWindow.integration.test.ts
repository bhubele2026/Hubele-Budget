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
import { pairPendingWithPosted, pairPendingWithPostedAmong } from "@workspace/avalanche-core";
import {
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
      },
    });
  });
});

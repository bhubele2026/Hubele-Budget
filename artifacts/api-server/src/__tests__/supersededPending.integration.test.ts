// (PR7b review M1) The bounded pairing read gives EXACTLY the answer of pairing
// the household's whole ledger, reads only rows that can pair, and never pairs
// across households.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import { pairPendingWithPosted } from "@workspace/avalanche-core";
import { findSupersededPending } from "../lib/supersededPending";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { createTestHousehold } from "./_helpers/testHousehold";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const USERS = {
  random: `pr7b-sp-random-${RUN}`,
  order: `pr7b-sp-order-${RUN}`,
  cost: `pr7b-sp-cost-${RUN}`,
  houseA: `pr7b-sp-house-a-${RUN}`,
  houseB: `pr7b-sp-house-b-${RUN}`,
  houseC: `pr7b-sp-house-c-${RUN}`,
};
const households: Record<keyof typeof USERS, string> = {} as Record<keyof typeof USERS, string>;

type Row = {
  occurredOn: string;
  amount: string;
  description: string;
  plaidAccountId: string;
  pending: boolean;
  createdAt: Date;
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

/** The reference: PR4c's pairing over EVERY row the household has. */
async function wholeLedgerReplaced(householdId: string): Promise<string[]> {
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
  const pairs = pairPendingWithPosted(all.map((r) => ({ ...r, amount: Number(r.amount) })));
  return [...pairs.values()].map((p) => p.id).sort();
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

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, Object.values(USERS)));
}

beforeAll(async () => {
  for (const key of Object.keys(USERS) as (keyof typeof USERS)[]) {
    households[key] = (await createTestHousehold(USERS[key])).householdId;
  }
  await cleanup();
});
afterAll(async () => {
  await cleanup();
});

describe("findSupersededPending — the whole-ledger answer, bounded", () => {
  it("equals pairing the whole ledger on a dense randomized ledger (two accounts, look-alike merchants, out-of-order arrivals)", async () => {
    // mulberry32, fixed seed: the same ledger every run.
    let seed = 20260911;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const accounts = [`acct-r1-${RUN}`, `acct-r2-${RUN}`];
    const merchants = ["STARBUCKS STORE 1234", "STARBUCKS", "PANERA BREAD 601", "SHELL OIL 57442"];
    const amounts = [5, 5.5, 6, 6.5, 20, 22, 25, 45, 47.4, 50, 58];
    const rows: Row[] = [];
    for (let i = 0; i < 400; i += 1) {
      const day = addDays("2026-03-01", Math.floor(rand() * 45));
      const sign = rand() < 0.1 ? 1 : -1;
      rows.push({
        occurredOn: day,
        amount: (sign * pick(amounts)).toFixed(2),
        description: pick(merchants),
        plaidAccountId: pick(accounts),
        pending: rand() < 0.4,
        // Up to two days late: sometimes a posted row arrives before its pending row.
        createdAt: at(day, Math.floor(rand() * 2880)),
      });
    }
    await insertRows("random", rows);

    const reference = await wholeLedgerReplaced(households.random);
    const bounded = await findSupersededPending(households.random);
    expect([...bounded.replacedIds].sort()).toEqual(reference);
    // A meaningful ledger: many pairs, and fewer rows read than it holds.
    expect(reference.length).toBeGreaterThan(20);
    expect(bounded.rowsRead).toBeLessThan(rows.length);
  });

  it("equals pairing the whole ledger where pairing order matters (the 92.40 and 11.00 cases)", async () => {
    const card = `acct-order-${RUN}`;
    const row = (occurredOn: string, amount: string, pending: boolean, description: string): Row => ({
      occurredOn,
      amount,
      description,
      plaidAccountId: card,
      pending,
      createdAt: at(occurredOn),
    });
    const [p0905] = await insertRows("order", [
      row("2026-09-05", "-45.00", true, "PANERA BREAD 601"),
      row("2026-09-06", "-45.00", true, "PANERA BREAD 601"),
      row("2026-09-07", "-47.40", false, "PANERA BREAD 601"),
    ]);
    const [p0813, p0817] = await insertRows("order", [
      row("2026-08-13", "-5.00", true, "STARBUCKS STORE 1234"),
      row("2026-08-17", "-5.00", true, "STARBUCKS STORE 1234"),
      row("2026-08-18", "-6.00", false, "STARBUCKS STORE 1234"),
      row("2026-08-23", "-5.00", true, "STARBUCKS STORE 1234"),
      row("2026-08-24", "-6.00", false, "STARBUCKS STORE 1234"),
    ]);

    const bounded = await findSupersededPending(households.order);
    // The older pending row is replaced, and the chain resolves oldest first.
    expect([...bounded.replacedIds].sort()).toEqual([p0905!, p0813!, p0817!].sort());
    expect([...bounded.replacedIds].sort()).toEqual(await wholeLedgerReplaced(households.order));
    // Candidates: Panera's posted row × 2 pending; each Starbucks posted row × 2.
    expect(bounded).toMatchObject({ candidatePairs: 6, rowsRead: 8 });
  });

  it("cost guard: 3,000 unrelated posted rows are never read; only the 30 real pairs are", async () => {
    const card = `acct-cost-${RUN}`;
    const rows: Row[] = [];
    // Ten small posted purchases a day for 300 days.
    for (let d = 0; d < 300; d += 1) {
      const day = addDays("2025-06-01", d);
      for (let i = 0; i < 10; i += 1) {
        rows.push({
          occurredOn: day,
          amount: (-(5 + ((d * 10 + i) % 1500) / 100)).toFixed(2),
          description: `COFFEE SHOP ${i}`,
          plaidAccountId: card,
          pending: false,
          createdAt: at(day, i),
        });
      }
    }
    // Every ten days a $250.00 hotel hold that posts the next day at $262.50.
    for (let k = 0; k < 30; k += 1) {
      const day = addDays("2025-06-01", k * 10);
      rows.push({ occurredOn: day, amount: "-250.00", description: "HOTEL 88", plaidAccountId: card, pending: true, createdAt: at(day, 30) });
      const next = addDays(day, 1);
      rows.push({ occurredOn: next, amount: "-262.50", description: "HOTEL 88", plaidAccountId: card, pending: false, createdAt: at(next, 30) });
    }
    await insertRows("cost", rows);

    const started = performance.now();
    const bounded = await findSupersededPending(households.cost);
    const elapsedMs = performance.now() - started;

    expect(rows.length).toBe(3060);
    expect(bounded.candidatePairs).toBe(30);
    expect(bounded.rowsRead).toBe(60);
    expect(bounded.replacedIds.size).toBe(30);
    expect([...bounded.replacedIds].sort()).toEqual(await wholeLedgerReplaced(households.cost));
    // Generous: a regression to reading and pairing the whole ledger shows up
    // in rowsRead above long before it shows up here.
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe("findSupersededPending — household scope (review N3)", () => {
  it("the same external account id in two households never pairs; in one household it does", async () => {
    const shared = `acct-shared-${RUN}`;
    const pending: Row = { occurredOn: "2026-05-04", amount: "-45.00", description: "BLUE BOTTLE COFFEE", plaidAccountId: shared, pending: true, createdAt: at("2026-05-04") };
    const posted: Row = { occurredOn: "2026-05-05", amount: "-47.40", description: "BLUE BOTTLE COFFEE", plaidAccountId: shared, pending: false, createdAt: at("2026-05-05") };
    await insertRows("houseA", [pending]);
    await insertRows("houseB", [posted]);
    await insertRows("houseC", [pending, posted]); // the control

    const a = await findSupersededPending(households.houseA);
    const b = await findSupersededPending(households.houseB);
    const c = await findSupersededPending(households.houseC);
    expect(a).toMatchObject({ candidatePairs: 0, rowsRead: 0 });
    expect(a.replacedIds.size).toBe(0);
    expect(b).toMatchObject({ candidatePairs: 0, rowsRead: 0 });
    expect(b.replacedIds.size).toBe(0);
    expect(c.replacedIds.size).toBe(1);

    const week = ["2026-05-03", "2026-05-09"] as const;
    const fa = await buildSpendingFacts(households.houseA, ...week);
    const fb = await buildSpendingFacts(households.houseB, ...week);
    const fc = await buildSpendingFacts(households.houseC, ...week);
    expect(fa.householdSpend.total).toBe(45);
    expect(fa.excluded.replacedPending).toBe(0);
    expect(fb.householdSpend.total).toBe(47.4);
    expect(fb.excluded.replacedPending).toBe(0);
    expect(fc.householdSpend.total).toBe(47.4);
    expect(fc.excluded.replacedPending).toBe(45);
  });
});

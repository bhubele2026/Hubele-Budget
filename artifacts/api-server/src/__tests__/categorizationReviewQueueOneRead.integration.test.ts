// (P3) The review queue in one history read, and the badge's count endpoint.
//
// `listReviewQueue` used to look up each listed item's merchant history with
// its own whole-history ILIKE read, one after another (20 for the nav badge,
// on every page). It now reads every item's history at once
// (`rowsWithSignatures`) and groups it in memory. The answer must not move:
// the old loop is kept below, verbatim, as the reference, and the two are
// compared deep-equal on a fixture built to catch the ways a grouped read can
// go wrong (a shared signature, a token another merchant also contains, the
// same day with an earlier/later creation, another household, a future row,
// an empty signature, novel and anomalous amounts). Synthetic data only.
//
// GET /categorization/review/count answers the list's `total` alone.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const OWNER = `p3-rq-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `p3-rq-other-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";
let HH_OTHER = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import { db, pool, categoryDecisionsTable, transactionsTable } from "@workspace/db";
import { GetCategorizationReviewCountResponse, ListCategorizationReviewResponse } from "@workspace/api-zod";
import categorizationRouter from "../routes/categorization";
import { amountAnomaly, listReviewQueue, openReviewCount, type ReviewItem } from "../lib/categorizer/review";
import { rowsWithSignature, rowsWithSignatures } from "../lib/categorizer/memory";
import { merchantSignature } from "../lib/merchantNameExtract";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { daysAgo } from "./_helpers/aiCategorize";

const { request } = createTestApp(categorizationRouter);

/** ⚠️ THE REFERENCE: `listReviewQueue` before P3, verbatim but for the name. */
async function legacyListReviewQueue(householdId: string, limit: number): Promise<{ items: ReviewItem[]; total: number }> {
  const { and, asc, inArray: inArr, isNull } = await import("drizzle-orm");
  const OPEN = and(
    inArr(categoryDecisionsTable.band, ["provisional", "queue"]),
    isNull(categoryDecisionsTable.resolvedAt),
    isNull(categoryDecisionsTable.undoneAt),
  );
  const rows = await db
    .select({
      decisionId: categoryDecisionsTable.id,
      transactionId: categoryDecisionsTable.transactionId,
      suggestedCategoryId: categoryDecisionsTable.categoryId,
      confidence: categoryDecisionsTable.confidence,
      band: categoryDecisionsTable.band,
      source: categoryDecisionsTable.source,
      explanation: categoryDecisionsTable.explanation,
      createdAt: categoryDecisionsTable.createdAt,
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      account: transactionsTable.account,
      currentCategoryId: transactionsTable.categoryId,
      splitsInvalid: transactionsTable.splitsInvalid,
      txnCreatedAt: transactionsTable.createdAt,
    })
    .from(categoryDecisionsTable)
    .innerJoin(transactionsTable, eq(transactionsTable.id, categoryDecisionsTable.transactionId))
    .where(and(eq(categoryDecisionsTable.householdId, householdId), OPEN))
    .orderBy(asc(categoryDecisionsTable.createdAt), asc(categoryDecisionsTable.id))
    .limit(limit);
  const total = await openReviewCount(householdId);
  const items: ReviewItem[] = [];
  for (const r of rows) {
    const sig = merchantSignature(r.description);
    const priors = sig
      ? (await rowsWithSignature(db, householdId, sig)).filter(
          (p) =>
            p.id !== r.transactionId &&
            (p.occurredOn < r.occurredOn ||
              (p.occurredOn === r.occurredOn && p.createdAt.getTime() < r.txnCreatedAt.getTime())),
        )
      : [];
    items.push({
      decisionId: r.decisionId,
      transactionId: r.transactionId,
      occurredOn: r.occurredOn,
      description: r.description,
      amount: r.amount,
      account: r.account,
      currentCategoryId: r.currentCategoryId,
      suggestedCategoryId: r.suggestedCategoryId,
      confidence: Number(r.confidence),
      band: r.band,
      source: r.source,
      explanation: r.explanation,
      createdAt: r.createdAt.toISOString(),
      flags: {
        novelMerchant: priors.length === 0,
        amountAnomaly: amountAnomaly(Number(r.amount), priors.map((p) => Number(p.amount))),
        splitNeedsRebalance: r.splitsInvalid,
      },
    });
  }
  return { items, total };
}

const T0 = Date.parse("2026-10-01T12:00:00Z");
let seq = 0;
async function txn(
  householdId: string,
  owner: string,
  description: string,
  amount: string,
  on: string,
  o: Partial<typeof transactionsTable.$inferInsert> = {},
): Promise<string> {
  seq += 1;
  const [r] = await db
    .insert(transactionsTable)
    .values({
      userId: owner,
      householdId,
      occurredOn: on,
      description,
      amount,
      source: "plaid:bank",
      plaidAccountId: "acct-p3-rq",
      account: "Checking",
      createdAt: new Date(T0 + seq * 60_000),
      ...o,
    })
    .returning({ id: transactionsTable.id });
  return r!.id;
}

let dseq = 0;
async function decide(
  transactionId: string,
  o: Partial<typeof categoryDecisionsTable.$inferInsert> = {},
): Promise<string> {
  dseq += 1;
  const [d] = await db
    .insert(categoryDecisionsTable)
    .values({
      householdId: HH,
      transactionId,
      source: "model",
      confidence: "0.700",
      band: "provisional",
      explanation: "Synthetic.",
      inputHash: `p3-rq-${dseq}-${randomUUID().slice(0, 6)}`,
      createdAt: new Date(T0 + dseq * 1000),
      ...o,
    })
    .returning({ id: categoryDecisionsTable.id });
  return d!.id;
}

const ids: Record<string, string> = {};

async function wipe(): Promise<void> {
  const hhs = [HH, HH_OTHER].filter(Boolean);
  if (hhs.length === 0) return;
  await db.delete(categoryDecisionsTable).where(inArray(categoryDecisionsTable.householdId, hhs));
  await db.delete(transactionsTable).where(inArray(transactionsTable.householdId, hhs));
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  await wipe();
  // Moss Cafe: four earlier rows under three spellings of ONE signature, then a $25 charge (> 3× the median).
  await txn(HH, OWNER, "MOSS CAFE", "-4.50", daysAgo(40));
  await txn(HH, OWNER, "MOSS CAFE #1234", "-5.25", daysAgo(30));
  await txn(HH, OWNER, "Moss-Cafe", "-6.00", daysAgo(20));
  await txn(HH, OWNER, "MOSS CAFE", "-5.00", daysAgo(10));
  ids.mossBig = await txn(HH, OWNER, "MOSS CAFE", "-25.00", daysAgo(5));
  ids.mossSmall = await txn(HH, OWNER, "MOSS CAFE 03/30", "-5.10", daysAgo(4));
  // A different merchant whose description also holds "moss" (the cafe's token): never its history.
  for (const [n, d] of [[1, 50], [2, 45], [3, 35], [4, 25]] as const) {
    await txn(HH, OWNER, "MOSSY ROCK GARDEN", `-${n * 3}.00`, daysAgo(d));
  }
  ids.mossy = await txn(HH, OWNER, "MOSSY ROCK GARDEN", "-90.00", daysAgo(3));
  // Same day: one row created before the queued row (a prior), one after (not a prior).
  await txn(HH, OWNER, "LANTERN BAKERY", "-8.00", daysAgo(6));
  ids.lantern = await txn(HH, OWNER, "LANTERN BAKERY", "-40.00", daysAgo(6));
  await txn(HH, OWNER, "LANTERN BAKERY", "-9.00", daysAgo(6));
  // ⚠️ A row whose signature is "lantern bakeries" but whose description the SQL
  // ILIKE '%bakeries%' does not match (a "C" Postgres keeps the Kelvin sign K; JS
  // lowercases it to a plain k). The single read never saw it
  // as that merchant's history; it IS in the grouped read (the bakery's token
  // "lantern" matches it), and must still be left out.
  await txn(HH, OWNER, "LANTERN BA\u212AERIES", "-30.00", daysAgo(14));
  ids.bakeries = await txn(HH, OWNER, "LANTERN BAKERIES", "-20.00", daysAgo(2));
  // Novel: only another household and a later row know this merchant.
  await txn(HH_OTHER, OTHER, "ZEPHYR KITES", "-12.00", daysAgo(30));
  ids.zephyr = await txn(HH, OWNER, "ZEPHYR KITES", "-12.00", daysAgo(8));
  await txn(HH, OWNER, "zephyr kites", "-11.00", daysAgo(2));
  // Novel and over $500.
  ids.orbit = await txn(HH, OWNER, "ORBIT FURNITURE", "-650.00", daysAgo(7));
  // No signature at all (a bare reference number).
  ids.bare = await txn(HH, OWNER, "#12345", "-70.00", daysAgo(9));
  // LIKE metacharacters in the description; the signature drops them.
  await txn(HH, OWNER, "100% PURE_JUICE", "-6.00", daysAgo(15));
  ids.juice = await txn(HH, OWNER, "100% PURE_JUICE", "-7.00", daysAgo(5), { splitsInvalid: true });
  // An apostrophe stays in the signature.
  await txn(HH, OWNER, "TRADER JOE'S #552", "-60.00", daysAgo(12));
  await txn(HH, OWNER, "TRADER JOE'S", "-55.00", daysAgo(11));
  ids.trader = await txn(HH, OWNER, "TRADER JOE'S", "-58.00", daysAgo(1));

  // Open decisions, oldest first, in this order.
  for (const k of ["mossBig", "mossy", "lantern", "zephyr", "orbit", "bare", "juice", "trader", "mossSmall", "bakeries"]) {
    await decide(ids[k]!, k === "orbit" || k === "bare" ? { band: "queue", source: "rule", categoryId: null } : {});
  }
  // Not open: resolved, undone, and an auto-band decision. None is listed or counted.
  const closed = await txn(HH, OWNER, "QUILL PAPER", "-3.00", daysAgo(3));
  await decide(closed, { resolvedAt: new Date(), resolution: "accepted", resolvedVia: "user" });
  await decide(ids.trader!, { undoneAt: new Date() });
  await decide(ids.trader!, { band: "auto" });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await wipe();
});

const byTxn = (q: { items: ReviewItem[] }) => new Map(q.items.map((i) => [i.transactionId, i.flags]));

describe("(P3) the review queue reads its history once", () => {
  it("⭐ old loop and one read answer the same, deep-equal, at every limit", async () => {
    for (const limit of [1, 2, 5, 9, 10, 20, 100]) {
      const [legacy, now] = [await legacyListReviewQueue(HH, limit), await listReviewQueue(HH, limit)];
      expect(now, `limit ${limit}`).toEqual(legacy);
    }
  });

  it("the fixture is not trivial: each flag, both ways, as worked by hand", async () => {
    const q = await listReviewQueue(HH, 20);
    expect(q.total).toBe(10);
    expect(q.items.map((i) => i.transactionId)).toEqual(
      ["mossBig", "mossy", "lantern", "zephyr", "orbit", "bare", "juice", "trader", "mossSmall", "bakeries"].map((k) => ids[k]),
    );
    const f = byTxn(q);
    // Four earlier Moss Cafe rows (three spellings); $25 > 3 × the $5.13 median.
    expect(f.get(ids.mossBig!)).toEqual({ novelMerchant: false, amountAnomaly: true, splitNeedsRebalance: false });
    // Five earlier rows now (the $25 one included): $5.10 is ordinary.
    expect(f.get(ids.mossSmall!)).toEqual({ novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false });
    // Its own four earlier rows only, never the cafe's: $90 > 3 × $7.50.
    expect(f.get(ids.mossy!)).toEqual({ novelMerchant: false, amountAnomaly: true, splitNeedsRebalance: false });
    // One prior (the same-day row created before it): too few to judge an amount.
    expect(f.get(ids.lantern!)).toEqual({ novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false });
    // Another household's row and a later row are not history.
    expect(f.get(ids.zephyr!)).toEqual({ novelMerchant: true, amountAnomaly: false, splitNeedsRebalance: false });
    expect(f.get(ids.orbit!)).toEqual({ novelMerchant: true, amountAnomaly: true, splitNeedsRebalance: false });
    expect(f.get(ids.bare!)).toEqual({ novelMerchant: true, amountAnomaly: false, splitNeedsRebalance: false });
    expect(f.get(ids.juice!)).toEqual({ novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: true });
    expect(f.get(ids.trader!)).toEqual({ novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false });
    // The Kelvin-K row carries this signature. Whether it is history is the single
    // read's ILIKE's call, which depends on the database's ctype (a "C" database,
    // as the test one, keeps the Kelvin sign: no match, so the bakery is novel).
    expect(merchantSignature("LANTERN BA\u212AERIES")).toBe(merchantSignature("LANTERN BAKERIES"));
    const folded = (await pool.query<{ m: boolean }>(`SELECT $1::text ILIKE '%bakeries%' AS m`, ["LANTERN BA\u212AERIES"])).rows[0]!.m;
    expect(f.get(ids.bakeries!)).toEqual({ novelMerchant: !folded, amountAnomaly: false, splitNeedsRebalance: false });
  });

  it("rowsWithSignatures = rowsWithSignature for each signature: the same rows, in the same order", async () => {
    const sigs = ["MOSS CAFE", "MOSSY ROCK GARDEN", "LANTERN BAKERY", "LANTERN BAKERIES", "ZEPHYR KITES", "#12345", "100% PURE_JUICE", "TRADER JOE'S", "NOBODY HERE"].map(
      merchantSignature,
    );
    expect(sigs).toContain("");
    const grouped = await rowsWithSignatures(db, HH, sigs);
    expect([...grouped.keys()].sort()).toEqual([...new Set(sigs.filter(Boolean))].sort());
    for (const s of sigs.filter(Boolean)) {
      expect(grouped.get(s), s).toEqual(await rowsWithSignature(db, HH, s));
    }
    expect(grouped.get(merchantSignature("MOSS CAFE"))).toHaveLength(6);
    expect(grouped.get(merchantSignature("NOBODY HERE"))).toEqual([]);
    expect((await rowsWithSignatures(db, HH, ["", ""])).size).toBe(0);
  });

  it("one page = three queries (list, count, history), whatever the number of items", async () => {
    const spy = vi.spyOn(pool, "query");
    try {
      for (const limit of [1, 20]) {
        spy.mockClear();
        await listReviewQueue(HH, limit);
        expect(spy.mock.calls.length, `limit ${limit}`).toBe(3);
      }
      spy.mockClear();
      await legacyListReviewQueue(HH, 20);
      // Before: the list, the count, then one read per listed item with a signature (9 of 10).
      expect(spy.mock.calls.length).toBe(2 + 9);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("(P3) GET /categorization/review/count — the badge's number", () => {
  it("is the list's total, in its own schema, and follows a resolution", async () => {
    const list = await request("GET", "/categorization/review?limit=20");
    const count = await request("GET", "/categorization/review/count");
    expect(list.status).toBe(200);
    expect(count.status).toBe(200);
    expect(ListCategorizationReviewResponse.safeParse(list.json).success).toBe(true);
    expect(GetCategorizationReviewCountResponse.safeParse(count.json).success).toBe(true);
    expect(count.json).toEqual({ total: (list.json as { total: number }).total });
    expect(count.json).toEqual({ total: 10 });

    const first = (list.json as { items: Array<{ decisionId: string }> }).items[0]!;
    const skip = await request("POST", `/categorization/review/${first.decisionId}/skip`);
    expect(skip.status).toBe(200);
    expect((await request("GET", "/categorization/review/count")).json).toEqual({ total: 9 });
    expect(((await request("GET", "/categorization/review?limit=20")).json as { total: number }).total).toBe(9);
  });
});

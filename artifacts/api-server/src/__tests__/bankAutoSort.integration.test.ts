// ⭐ (BANK-AUTO) New bank rows arrive already matched and categorized when H2
// is sure; whatever is left is ONE list with ONE count.
//
// Invented data only: "Cedar Hollow Bank" checking ••1234 is the forecast's
// account, "Card A" ••9001 a card. Today is Wed 2026-10-14 12:00
// America/Chicago; the snapshot is $3,000.00 at Thu 10/1 08:00.
//
//   row                         amount   plan                          → expected
//   HOLLOW WATER UTILITY 10/10  −50.00   Hollow Water Utility −50 10/10  matched (ledger: tier 2, its category + full name)
//   PAYMENT 7731 10/12          −42.00   Lantern Storage −42 10/8        matched (one obvious: exact, 4 days, nobody else wants it)
//   ACH DEBIT 5521 10/9         −30.00   Garden Club Dues −30 10/4 and   left alone (two high candidates)
//                                        Library Fund −30 10/5
//   TEA CLUB 10/13 (pending)    −15.00   Tea Club −15 10/13              left alone (pending)
//   RIVER GYM 10/3              −25.00   River Gym −25 10/3              untouched (answered "not in the plan" by hand)
//   MAPLE INSURANCE 10/20       −80.00   Maple Insurance −80 10/20       left alone (future-dated, flagged for the forecast)
//
//   Card A: WILLOW BAKERY filed Groceries by hand twice; a third WILLOW BAKERY
//   charge is provisional Groceries → filed. PINE HARDWARE filed Groceries once
//   and Home once by hand; a third is provisional Home → stays in the queue.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const OWNER = `bank-auto-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

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

import {
  db,
  bankAutoMatchDeclinesTable,
  budgetCategoriesTable,
  categoryDecisionsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { GetBankingAutoDoneResponse, GetBankingNeedsYouResponse, RunBankingAutoSortResponse } from "@workspace/api-zod";
import bankingRouter from "../routes/banking";
import forecastRouter from "../routes/forecast";
import spineRouter from "../routes/spine";
import categorizationRouter from "../routes/categorization";
import { computeReviewCount } from "../lib/reviewCount";
import { openReviewCount } from "../lib/categorizer/review";
import { pickOneObvious, suggestPlansForRow, type PickPlan } from "../lib/bankAutoSort";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-14T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
for (const r of [bankingRouter, forecastRouter, spineRouter, categorizationRouter]) app.use(r);

let server: Server;
let baseUrl = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
async function ok(method: string, path: string, body?: unknown): Promise<Json> {
  const r = await call(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const needsYou = async (): Promise<Json> => {
  const body = await ok("GET", "/banking/needs-you");
  expect(() => GetBankingNeedsYouResponse.parse(body)).not.toThrow();
  return body;
};
const autoSort = async (dryRun = false): Promise<Json> => {
  const body = await ok("POST", `/banking/auto-sort${dryRun ? "?dryRun=1" : ""}`);
  expect(() => RunBankingAutoSortResponse.parse(body)).not.toThrow();
  return body;
};

const row: Record<string, string> = {};
const plan: Record<string, string> = {};
const cat: Record<string, string> = {};
const decision: Record<string, string> = {};
let checkingExt = "";
let cardExt = "";

const PLANS = {
  water: { name: "Hollow Water Utility", amount: "50", day: 10, category: "utilities" },
  storage: { name: "Lantern Storage", amount: "42", day: 8 },
  garden: { name: "Garden Club Dues", amount: "30", day: 4 },
  library: { name: "Library Fund", amount: "30", day: 5 },
  tea: { name: "Tea Club", amount: "15", day: 13 },
  gym: { name: "River Gym", amount: "25", day: 3 },
  maple: { name: "Maple Insurance", amount: "80", day: 20 },
} as const;

const BANK_ROWS = {
  water: { on: "2026-10-10", desc: "HOLLOW WATER UTILITY", amount: "-50.00", category: "utilities" },
  storage: { on: "2026-10-12", desc: "PAYMENT 7731", amount: "-42.00" },
  twoWays: { on: "2026-10-09", desc: "ACH DEBIT 5521", amount: "-30.00" },
  tea: { on: "2026-10-13", desc: "TEA CLUB", amount: "-15.00", pending: true },
  gym: { on: "2026-10-03", desc: "RIVER GYM", amount: "-25.00" },
  maple: { on: "2026-10-20", desc: "MAPLE INSURANCE", amount: "-80.00", forecast: true },
} as const;

async function cleanup(): Promise<void> {
  if (!HH) return;
  await db.delete(bankAutoMatchDeclinesTable).where(eq(bankAutoMatchDeclinesTable.householdId, HH));
  await db.delete(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, HH));
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, HH));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, HH));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, HH));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  const owned = { userId: OWNER, householdId: HH };

  const account = async (key: string, institution: string, name: string, mask: string, type: string, subtype: string) => {
    const [item] = await db
      .insert(plaidItemsTable)
      .values({ ...owned, itemId: `ba-item-${key}-${randomUUID()}`, accessToken: "t", institutionName: institution, institutionSlug: key, lastSyncedAt: NOW })
      .returning();
    const ext = `ba-${key}-${randomUUID().slice(0, 8)}`;
    const [r] = await db
      .insert(plaidAccountsTable)
      .values({ ...owned, itemId: item!.id, accountId: ext, name, mask, type, subtype })
      .returning();
    return { rowId: r!.id, ext };
  };
  const checking = await account("cedar", "Cedar Hollow Bank", "Everyday Checking", "1234", "depository", "checking");
  const card = await account("carda", "Card A", "Card A", "9001", "credit", "credit card");
  checkingExt = checking.ext;
  cardExt = card.ext;

  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-01T08:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: checking.rowId,
    bankSnapshotMask: "1234",
  });

  for (const [key, name] of Object.entries({ utilities: "Utilities", groceries: "Groceries", home: "Home" })) {
    const [r] = await db.insert(budgetCategoriesTable).values({ ...owned, name, kind: "expense", groupName: "Auto" }).returning();
    cat[key] = r!.id;
  }

  for (const [key, p] of Object.entries(PLANS)) {
    const day = String(p.day).padStart(2, "0");
    const [r] = await db
      .insert(recurringItemsTable)
      .values({
        ...owned,
        name: p.name,
        kind: "bill",
        amount: p.amount,
        frequency: "monthly",
        dayOfMonth: p.day,
        anchorDate: `2026-10-${day}`,
        active: "true",
        categoryId: "category" in p ? cat[p.category]! : null,
      })
      .returning();
    plan[key] = r!.id;
  }

  for (const [key, s] of Object.entries(BANK_ROWS) as Array<[string, { on: string; desc: string; amount: string; category?: string; pending?: boolean; forecast?: boolean }]>) {
    const [r] = await db
      .insert(transactionsTable)
      .values({
        ...owned,
        occurredOn: s.on,
        createdAt: createdAtStartOfHouseholdDay(s.on > "2026-10-14" ? "2026-10-14" : s.on),
        description: s.desc,
        amount: s.amount,
        plaidAccountId: checking.ext,
        plaidTransactionId: `ba-${key}-${randomUUID().slice(0, 8)}`,
        source: "plaid:cedar",
        categoryId: s.category ? cat[s.category]! : null,
        pending: s.pending ?? false,
        forecastFlag: true,
      })
      .returning({ id: transactionsTable.id });
    row[key] = r!.id;
  }
  // River Gym was answered by hand: not in the plan.
  await db.insert(forecastResolutionsTable).values({ ...owned, status: "ignored_unforecasted", matchedTxnId: row.gym! });

  // Card A: hand-filed history and two provisional suggestions.
  const cardRow = async (key: string, on: string, desc: string, amount: string, categoryId: string | null, extra: Record<string, unknown> = {}) => {
    const [r] = await db
      .insert(transactionsTable)
      .values({
        ...owned,
        occurredOn: on,
        createdAt: createdAtStartOfHouseholdDay(on),
        description: desc,
        amount,
        plaidAccountId: card.ext,
        plaidTransactionId: `ba-${key}-${randomUUID().slice(0, 8)}`,
        source: "plaid:carda",
        categoryId,
        ...extra,
      })
      .returning({ id: transactionsTable.id });
    row[key] = r!.id;
  };
  await cardRow("bakery1", "2026-09-02", "WILLOW BAKERY", "-12.00", cat.groceries!, { categoryLockedByUser: true });
  await cardRow("bakery2", "2026-09-16", "WILLOW BAKERY", "-14.50", cat.groceries!, { categoryLockedByUser: true });
  await cardRow("bakery3", "2026-10-11", "WILLOW BAKERY", "-13.25", cat.groceries!, { categoryProvisional: true });
  await cardRow("pine1", "2026-09-05", "PINE HARDWARE", "-20.00", cat.groceries!, { categoryLockedByUser: true });
  await cardRow("pine2", "2026-09-19", "PINE HARDWARE", "-22.00", cat.home!, { categoryLockedByUser: true });
  await cardRow("pine3", "2026-10-12", "PINE HARDWARE", "-21.00", cat.home!, { categoryProvisional: true });
  for (const [key, categoryId] of [
    ["bakery3", cat.groceries!],
    ["pine3", cat.home!],
  ] as const) {
    const [d] = await db
      .insert(categoryDecisionsTable)
      .values({
        householdId: HH,
        transactionId: row[key]!,
        source: "memory",
        categoryId,
        previousCategoryId: null,
        confidence: "0.750",
        band: "provisional",
        explanation: "You filed this merchant here before.",
        inputHash: `test-${key}`,
        createdAt: new Date("2026-10-13T09:00:00-05:00"),
      })
      .returning({ id: categoryDecisionsTable.id });
    decision[key] = d!.id;
  }

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  if (server) await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

const answersOn = (txnId: string) =>
  db.select().from(forecastResolutionsTable).where(and(eq(forecastResolutionsTable.householdId, HH), eq(forecastResolutionsTable.matchedTxnId, txnId)));

/** The badge every surface shows, read from each of them. */
async function everyBadge(): Promise<{ needsYou: number; spine: number; reviewCount: number; bankingBadge: number; lib: number }> {
  const [n, spine, rc, review, lib] = await Promise.all([
    needsYou(),
    ok("GET", "/spine"),
    ok("GET", "/forecast/review-count"),
    ok("GET", "/banking/review?from=2026-10-01&to=2026-10-14"),
    computeReviewCount(HH, OWNER),
  ]);
  return { needsYou: n.count, spine: spine.reviewCount, reviewCount: rc.count, bankingBadge: review.reviewInbox.badgeCount, lib };
}

describe("the one-click rule, ported", () => {
  const plans: PickPlan[] = [
    { key: "a|2026-10-04", date: "2026-10-04", amount: -30, label: "Garden Club Dues" },
    { key: "b|2026-10-05", date: "2026-10-05", amount: -30, label: "Library Fund" },
    { key: "c|2026-10-08", date: "2026-10-08", amount: -42, label: "Lantern Storage" },
  ];
  it("high = exact amount within 5 days (or with a label word within 14); a tie or a contest is left alone", () => {
    const one = suggestPlansForRow({ id: "r1", date: "2026-10-12", amount: -42, description: "PAYMENT 7731" }, plans);
    expect(one.filter((s) => s.confidence === "high").map((s) => s.plan.key)).toEqual(["c|2026-10-08"]);
    expect(one[0]!.plan.key).toBe("c|2026-10-08");
    const two = suggestPlansForRow({ id: "r2", date: "2026-10-09", amount: -30, description: "ACH DEBIT 5521" }, plans);
    expect(two.filter((s) => s.confidence === "high")).toHaveLength(2);
    const picked = pickOneObvious(new Map([["r1", one], ["r2", two]]));
    expect([...picked.keys()]).toEqual(["r1"]);
    // A second row that wants the same plan contests it: neither is picked.
    const rival = suggestPlansForRow({ id: "r3", date: "2026-10-09", amount: -42, description: "TRANSFER" }, plans);
    expect(pickOneObvious(new Map([["r1", one], ["r3", rival]])).size).toBe(0);
    // Money in never pairs with money out.
    expect(suggestPlansForRow({ id: "r4", date: "2026-10-08", amount: 42, description: "x" }, plans)).toEqual([]);
  });
});

describe("before the auto-sort", () => {
  it("lists every waiting charge once, and every badge is its count", async () => {
    const n = await needsYou();
    const kinds = new Map<string, string>(n.items.map((i: Json) => [i.txId, i.kind]));
    // Bank rows this month still waiting (River Gym is answered; Maple is future but flagged, so it waits too).
    for (const k of ["water", "storage", "twoWays", "tea", "maple"]) expect(kinds.get(row[k]!), k).toBe("match");
    expect(kinds.has(row.gym!)).toBe(false);
    // The queue: one item per charge.
    expect(kinds.get(row.bakery3!)).toBe("category");
    expect(kinds.get(row.pine3!)).toBe("category");
    expect(n.count).toBe(7);
    expect(n.truncated).toBe(false);
    expect(n.count).toBe(n.items.length);
    expect(n.throughDate).toBe("2026-10-14");
    const water = n.items.find((i: Json) => i.txId === row.water);
    expect(water).toMatchObject({ accountName: "Everyday Checking", mask: "1234", amount: "-50.00", pending: false, categoryName: "Utilities" });
    // The label reads after "Looks like ".
    expect(water.suggestion).toMatchObject({
      label: "the Hollow Water Utility payment, planned $50.00 on Oct 10",
      planOccurrenceId: `${plan.water}|2026-10-10`,
      confidence: "high",
    });
    expect(water.reason).toBe("Looks like the Hollow Water Utility payment, planned $50.00 on Oct 10. Confirm the match or pick another.");
    expect(n.items.find((i: Json) => i.txId === row.storage)).toMatchObject({
      categoryName: null,
      suggestion: { label: "the Lantern Storage payment, planned $42.00 on Oct 8", planOccurrenceId: `${plan.storage}|2026-10-08` },
    });
    const bakery = n.items.find((i: Json) => i.txId === row.bakery3);
    expect(bakery.suggestion).toMatchObject({ label: "Groceries", categoryId: cat.groceries, reviewItemId: decision.bakery3, confidence: "medium" });
    expect(bakery).toMatchObject({ accountName: "Card A", mask: "9001", categoryName: "Groceries" });
    const b = await everyBadge();
    expect(b).toEqual({ needsYou: 7, spine: 7, reviewCount: 7, bankingBadge: 7, lib: 7 });
  });

  it("a dry run reports what it would do and writes nothing", async () => {
    const dry = await autoSort(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.matched.map((m: Json) => [m.txnId, m.why, m.resolutionId]).sort()).toEqual(
      [
        [row.water, "ledger", null],
        [row.storage, "one_obvious", null],
      ].sort(),
    );
    expect(dry.categorized.map((c: Json) => c.txnId)).toEqual([row.bakery3]);
    expect(await answersOn(row.water!)).toHaveLength(0);
    expect((await needsYou()).count).toBe(7);
  });
});

describe("the auto-sort", () => {
  let first: Json;
  beforeAll(async () => {
    first = await autoSort();
  });

  it("matches the ledger's unambiguous pair and the one obvious candidate, marked automatic", async () => {
    expect(first.dryRun).toBe(false);
    const byTxn = new Map<string, Json>(first.matched.map((m: Json) => [m.txnId, m]));
    expect(byTxn.get(row.water!)).toMatchObject({ why: "ledger", recurringItemId: plan.water, occurrenceDate: "2026-10-10", label: "Hollow Water Utility" });
    expect(byTxn.get(row.storage!)).toMatchObject({ why: "one_obvious", recurringItemId: plan.storage, occurrenceDate: "2026-10-08" });
    expect(byTxn.size).toBe(2);
    for (const k of ["water", "storage"]) {
      const a = await answersOn(row[k]!);
      expect(a.map((x) => [x.status, x.source])).toEqual([["matched", "auto"]]);
    }
  });

  it("leaves two candidates, a pending row and a future row alone, and never touches an answered row", async () => {
    expect(await answersOn(row.twoWays!)).toHaveLength(0);
    expect(await answersOn(row.tea!)).toHaveLength(0);
    expect(await answersOn(row.maple!)).toHaveLength(0);
    const gym = await answersOn(row.gym!);
    expect(gym.map((x) => [x.status, x.source])).toEqual([["ignored_unforecasted", "user"]]);
  });

  it("files a provisional category the household's own filings agree with; conflicting history stays queued", async () => {
    expect(first.categorized.map((c: Json) => [c.txnId, c.categoryId, c.confirmed])).toEqual([[row.bakery3, cat.groceries, 2]]);
    const [t] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, row.bakery3!));
    expect(t).toMatchObject({ categoryId: cat.groceries, categoryProvisional: false, categoryLockedByUser: false });
    const ds = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, row.bakery3!));
    const promo = ds.find((d) => d.inputHash.startsWith("promote:"))!;
    expect(promo).toMatchObject({ source: "memory", band: "auto", categoryId: cat.groceries, undoneAt: null });
    expect(ds.find((d) => d.id === decision.bakery3)).toMatchObject({ resolution: "skipped" });
    const [pine] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, decision.pine3!));
    expect(pine).toMatchObject({ resolvedAt: null, band: "provisional" });
  });

  it("is idempotent: a second run writes nothing", async () => {
    const again = await autoSort();
    expect(again).toEqual({ dryRun: false, matched: [], categorized: [] });
  });

  it("what is left is one list, and every badge is its count", async () => {
    const n = await needsYou();
    expect(n.items.map((i: Json) => i.txId).sort()).toEqual([row.twoWays, row.tea, row.maple, row.pine3].sort());
    expect(n.count).toBe(4);
    expect(n.autoDone).toEqual({ matched: 2, categorized: 1, since: "2026-10-07" });
    expect(await everyBadge()).toEqual({ needsYou: 4, spine: 4, reviewCount: 4, bankingBadge: 4, lib: 4 });
    // The pill's two sources: the match rows and the queue, a charge on both counted once.
    const matchItems = n.items.filter((i: Json) => i.kind === "match").length;
    const categoryItems = n.items.filter((i: Json) => i.kind === "category").length;
    expect(matchItems + categoryItems).toBe(n.count);
    expect(await openReviewCount(HH)).toBe(1);
  });

  it("lists what it did, each with its undo id", async () => {
    const done = await ok("GET", "/banking/auto-done?since=2026-10-14");
    expect(() => GetBankingAutoDoneResponse.parse(done)).not.toThrow();
    expect(done).toMatchObject({ since: "2026-10-14", matched: 2, categorized: 1, truncated: false });
    expect(done.items.map((i: Json) => [i.kind, i.txnId]).sort()).toEqual(
      [
        ["category", row.bakery3],
        ["match", row.storage],
        ["match", row.water],
      ].sort(),
    );
    const water = done.items.find((i: Json) => i.txnId === row.water);
    expect(water).toMatchObject({ planKey: `${plan.water}|2026-10-10`, label: "Hollow Water Utility" });
    expect(water.undoId).toBe(first.matched.find((m: Json) => m.txnId === row.water).resolutionId);
  });
});

describe("undo", () => {
  it("an undone automatic match is back in the list, and the auto-sort never matches it again", async () => {
    const id = (await answersOn(row.water!))[0]!.id;
    expect(await ok("POST", `/forecast/resolutions/${id}/undo`, { restore: [] })).toEqual({ undone: id, restored: 0 });
    let n = await needsYou();
    expect(n.items.find((i: Json) => i.txId === row.water)?.kind).toBe("match");
    expect(n.count).toBe(5);
    expect((await autoSort()).matched).toEqual([]);
    expect(await answersOn(row.water!)).toHaveLength(0);
    n = await needsYou();
    expect(n.count).toBe(5);
    expect(await everyBadge()).toEqual({ needsYou: 5, spine: 5, reviewCount: 5, bankingBadge: 5, lib: 5 });
  });

  it("deleting an automatic match hands the row back too", async () => {
    const id = (await answersOn(row.storage!))[0]!.id;
    expect((await call("DELETE", `/forecast/resolutions/${id}`)).status).toBe(204);
    expect((await autoSort()).matched).toEqual([]);
    const declined = await db.select().from(bankAutoMatchDeclinesTable).where(eq(bankAutoMatchDeclinesTable.householdId, HH));
    expect(declined.map((d) => d.txnId).sort()).toEqual([row.water, row.storage].sort());
  });

  it("an undone automatic category goes back to the queue as it was, and is not filed again", async () => {
    const promo = (await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, row.bakery3!))).find((d) =>
      d.inputHash.startsWith("promote:"),
    )!;
    const out = await ok("POST", `/category-decisions/${promo.id}/undo`);
    expect(out).toMatchObject({ decisionId: promo.id, categoryId: cat.groceries });
    const [t] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, row.bakery3!));
    expect(t).toMatchObject({ categoryId: cat.groceries, categoryProvisional: true });
    const [d] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, decision.bakery3!));
    expect(d).toMatchObject({ resolvedAt: null, resolution: null });
    const n = await needsYou();
    expect(n.items.find((i: Json) => i.txId === row.bakery3)).toMatchObject({ kind: "category", suggestion: { reviewItemId: decision.bakery3 } });
    expect((await autoSort()).categorized).toEqual([]);
    expect((await autoSort(true)).categorized).toEqual([]);
  });
});

describe("the endpoints refuse", () => {
  it("a bad limit, since or dryRun", async () => {
    expect((await call("GET", "/banking/needs-you?limit=0")).status).toBe(400);
    expect((await call("GET", "/banking/needs-you?limit=501")).status).toBe(400);
    expect((await call("GET", "/banking/needs-you?since=2026-13-40")).status).toBe(400);
    expect((await call("GET", "/banking/auto-done?since=2026-10-15")).status).toBe(400);
    expect((await call("POST", "/banking/auto-sort?dryRun=yes")).status).toBe(400);
  });
  it("caps the list and says so", async () => {
    const n = await ok("GET", "/banking/needs-you?limit=2");
    expect(n.items).toHaveLength(2);
    expect(n.truncated).toBe(true);
    expect(n.count).toBeGreaterThan(2);
  });
});

void cardExt;
void checkingExt;

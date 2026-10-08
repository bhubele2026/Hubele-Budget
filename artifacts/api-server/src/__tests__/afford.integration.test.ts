// ⭐ (PR-F1) POST /money/afford, the wish-list evaluation and the agent's
// evaluate_scenario tool — on PR-B1's hand-worked household A
// (moneyPosition.integration.test.ts), with a $300 Dining plan this month.
//
// Pinned now: Wed 2026-10-07 12:00 Central. All figures are synthetic.
//
// Household A (as moneyPosition.integration.test.ts works it)
//   Curve: 10/7 2,814.50 · 10/8 2,624.50 · 10/9 4,624.50 (paycheck) ·
//          10/12 3,424.50 (rent) · then paychecks every two weeks: it climbs.
//   Payday 10/9 · lowest through payday 2,624.50 (10/8) → available 2,124.50
//   Week: cap 250, 105.50 counted → 144.50 left · safe now 144.50
//   Dining: planned $300.00 for October, spent $25.50 (Taco Shop) → 274.50
//   No debts, no planned extra.
//
// "$300 on Saturday 10/10" — Saturday is after payday, inside this week:
//   remaining this week 144.50 − 300 = −155.50 → safe now 0.00
//   available until payday unchanged 2,124.50 (the purchase is after payday)
//   the curve: 10/10 4,324.50, 10/12 3,124.50 — its lowest stays 2,624.50 (10/8)
//   Dining 274.50 → −25.50 · verdict: tight (the week goes over its cap)
//
// Household B — another owner and a member of B, nothing set up.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const A_OWNER = `afford-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const A_MEMBER = `afford-am-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_OWNER = `afford-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_MEMBER = `afford-bm-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      headers: Record<string, string | string[] | undefined>;
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? A_OWNER);
    const hh = HH[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  agentConversationsTable,
  agentRunsTable,
  allowancePlansTable,
  budgetCategoriesTable,
  budgetLinesTable,
  forecastSettingsTable,
  householdMembersTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
  wishlistItemsTable,
} from "@workspace/db";
import { AFFORD_ASSUMPTIONS, computePosition } from "@workspace/avalanche-core";
import moneyRouter from "../routes/money";
import budgetRouter from "../routes/budget";
import { buildAffordBaseline, evaluateAffordForHousehold } from "../lib/afford";
import { evaluateWishlist, handleWishlistEvaluateJobs } from "../jobs/handlers/wishlistEvaluate";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";
import { makeTools } from "../ai/tools";
import { runAgent } from "../ai/agent/runAgent";
import { queueFakeChat, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { pinEnv } from "./_helpers/aiEnv";

pinEnv({ AI_PROVIDER: "fake", AI_ENABLED: "true", AI_PAUSED: undefined, AI_MODEL_CHAT: undefined, JOBS_MODE: "off" });

const NOW = new Date("2026-10-07T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(budgetRouter);

let server: Server;
let baseUrl: string;
let diningId = "";
let bDiningId = "";
const wish: Record<string, string> = {};

async function call(method: "GET" | "POST", path: string, body?: unknown, as: string = A_OWNER): Promise<{ status: number; text: string; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-test-user": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, text, json };
}

async function cleanup(): Promise<void> {
  for (const u of [A_OWNER, B_OWNER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
    await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, u));
    await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
  for (const h of Object.values(HH)) {
    await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, h.householdId));
    await db.delete(budgetLinesTable).where(eq(budgetLinesTable.householdId, h.householdId));
    await db.delete(wishlistItemsTable).where(eq(wishlistItemsTable.householdId, h.householdId));
    await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, h.householdId));
  }
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH[A_OWNER] = await createTestHousehold(A_OWNER);
  HH[B_OWNER] = await createTestHousehold(B_OWNER);
  await db
    .insert(householdMembersTable)
    .values([
      { userId: A_MEMBER, householdId: HH[A_OWNER]!.householdId, role: "member" },
      { userId: B_MEMBER, householdId: HH[B_OWNER]!.householdId, role: "member" },
    ])
    .onConflictDoNothing();
  HH[A_MEMBER] = { householdId: HH[A_OWNER]!.householdId, ownerUserId: A_OWNER };
  HH[B_MEMBER] = { householdId: HH[B_OWNER]!.householdId, ownerUserId: B_OWNER };
  await cleanup();
  const A = HH[A_OWNER]!.householdId;
  const B = HH[B_OWNER]!.householdId;
  const base = { userId: A_OWNER, householdId: A };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const chase = `acct-chase-${randomUUID()}`;
  const amex = `acct-amex-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: chase, name: "Chase Checking", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: acct!.id,
  });
  const [dining] = await db
    .insert(budgetCategoriesTable)
    .values({ ...base, name: `Dining ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Food" })
    .returning();
  diningId = dining!.id;
  const [bDining] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: B_OWNER, householdId: B, name: `Dining ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Food" })
    .returning();
  bDiningId = bDining!.id;
  await db.insert(budgetLinesTable).values({ householdId: A, userId: A_OWNER, monthStart: "2026-10-01", categoryId: diningId, plannedAmount: "300.00" });

  const row = (r: { occurredOn: string; description: string; amount: string; account: string; source: string; categoryId?: string | null; isTransfer?: boolean; weeklyAllowance?: boolean; monthlyAllowance?: boolean; unplannedAllowance?: boolean }) => ({
    ...base,
    occurredOn: r.occurredOn,
    createdAt: createdAtStartOfHouseholdDay(r.occurredOn),
    description: r.description,
    amount: r.amount,
    plaidAccountId: r.account,
    source: r.source,
    categoryId: r.categoryId ?? null,
    isTransfer: r.isTransfer ?? false,
    weeklyAllowance: r.weeklyAllowance ?? false,
    monthlyAllowance: r.monthlyAllowance ?? false,
    unplannedAllowance: r.unplannedAllowance ?? false,
  });
  await db.insert(transactionsTable).values([
    row({ occurredOn: "2026-10-05", description: "Online Transfer to SAV ...8801", amount: "-100.00", account: chase, source: "plaid", isTransfer: true }),
    row({ occurredOn: "2026-10-06", description: "TACO SHOP 22", amount: "-25.50", account: chase, source: "plaid", categoryId: diningId }),
    row({ occurredOn: "2026-10-06", description: "CITY WATER UTILITY", amount: "-60.00", account: chase, source: "plaid" }),
    row({ occurredOn: "2026-10-05", description: "HEB GROCERY", amount: "-80.00", account: amex, source: "plaid:amex", weeklyAllowance: true }),
    row({ occurredOn: "2026-10-06", description: "HOME DEPOT", amount: "-40.00", account: amex, source: "plaid:amex", unplannedAllowance: true }),
    row({ occurredOn: "2026-10-07", description: "SHOE STORE", amount: "-30.00", account: amex, source: "plaid:amex", monthlyAllowance: true }),
  ]);
  const plan = (p: { name: string; kind: string; amount: string; frequency: string; anchorDate: string; amountKind?: string }) => ({
    ...base,
    name: p.name,
    kind: p.kind,
    amount: p.amount,
    frequency: p.frequency,
    dayOfMonth: Number(p.anchorDate.slice(8, 10)),
    anchorDate: p.anchorDate,
    active: "true",
    amountKind: p.amountKind ?? "fixed",
  });
  await db.insert(recurringItemsTable).values([
    plan({ name: "Paycheck", kind: "income", amount: "2000", frequency: "biweekly", anchorDate: "2026-10-09" }),
    plan({ name: "Reimbursement", kind: "income", amount: "150", frequency: "monthly", anchorDate: "2026-10-08" }),
    plan({ name: "Electric", kind: "bill", amount: "340", frequency: "monthly", anchorDate: "2026-10-08", amountKind: "estimate" }),
    plan({ name: "City Water", kind: "bill", amount: "60", frequency: "monthly", anchorDate: "2026-10-06" }),
    plan({ name: "Rent", kind: "bill", amount: "1200", frequency: "monthly", anchorDate: "2026-10-12" }),
  ]);
  await db.insert(allowancePlansTable).values({ householdId: A, memberUserId: null, period: "weekly", amount: "250.00", effectiveFrom: "2026-05-01", source: "owner" });

  const w = (householdId: string, title: string, amount: string | null, decision = "pending", categoryId: string | null = null) => ({
    householdId,
    title,
    amount,
    categoryId,
    decision,
    requestedBy: A_OWNER,
    waitingUntil: "2026-10-14",
  });
  const rows = await db
    .insert(wishlistItemsTable)
    .values([
      w(A, "Bike", "300.00", "pending", diningId),
      w(A, "Lamp", null),
      w(A, "Old chair", "50.00", "declined"),
      w(B, "B thing", "20.00"),
    ])
    .returning({ id: wishlistItemsTable.id, title: wishlistItemsTable.title });
  for (const r of rows) wish[r.title] = r.id;

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await db.delete(agentRunsTable).where(eq(agentRunsTable.householdId, HH[A_OWNER]!.householdId));
  await db.delete(agentConversationsTable).where(eq(agentConversationsTable.householdId, HH[A_OWNER]!.householdId));
  await cleanup();
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, A_MEMBER));
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, B_MEMBER));
});

const SATURDAY_300 = {
  amount: "300.00",
  dateISO: "2026-10-10",
  baseline: {
    safeToSpendNow: "144.50",
    remainingWeek: "144.50",
    availableUntilPayday: "2124.50",
    lowest: "2624.50",
    lowestDate: "2026-10-08",
    debtFreeEarliest: null,
    debtFreeLatest: null,
    totalInterestLow: "0.00",
  },
  proposed: {
    safeToSpendNow: "0.00",
    remainingWeek: "-155.50",
    availableUntilPayday: "2124.50",
    lowest: "2624.50",
    lowestDate: "2026-10-08",
    debtFreeEarliest: null,
    debtFreeLatest: null,
    totalInterestLow: "0.00",
  },
  delta: {
    safeToSpendNow: "-144.50",
    remainingWeek: "-300.00",
    availableUntilPayday: "0.00",
    lowest: "0.00",
    lowestDate: null,
    debtFreeEarliest: null,
    debtFreeLatest: null,
    totalInterestLow: "0.00",
  },
  debt: { affected: false, cut: "0.00", cutMonth: null, debtFreeMonthShift: 0, interestDelta: "0.00" },
  verdict: "tight",
};

describe("POST /money/afford — household A, worked by hand", () => {
  it("$300 on Saturday: every figure before and after", async () => {
    const r = await call("POST", "/money/afford", { amount: 300, date: "2026-10-10", categoryId: diningId });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ...SATURDAY_300,
      category: { categoryId: diningId, remainingBefore: "274.50", remainingAfter: "-25.50" },
      assumptions: [
        "available credit is not counted",
        "bank data from 2026-10-04",
        "bills due on payday are counted before the paycheck",
        "spending not yet filed counts against the weekly cap",
        AFFORD_ASSUMPTIONS.countedOn("2026-10-10"),
        AFFORD_ASSUMPTIONS.countsThisWeek,
      ],
    });
  });

  it("the Dining figures are the Budget month's own: planned 300.00, spent 25.50", async () => {
    const month = await call("GET", "/budget/months/2026-10-01");
    expect(month.status).toBe(200);
    const lines = month.json.lines as Array<{ categoryId: string; plannedAmount: string; actualAmount: string }>;
    const line = lines.find((l) => l.categoryId === diningId)!;
    expect([Number(line.plannedAmount).toFixed(2), Number(line.actualAmount).toFixed(2)]).toEqual(["300.00", "25.50"]);
    const baseline = await buildAffordBaseline(HH[A_OWNER]!.householdId, A_OWNER);
    expect(baseline.categoryPlans).toContainEqual({ categoryId: diningId, planned: "300.00", spentMtd: "25.50" });
    // Every category the evaluator measures reads the Budget month's own planned and actual.
    for (const p of baseline.categoryPlans) {
      const l = lines.find((x) => x.categoryId === p.categoryId)!;
      expect([Number(p.planned).toFixed(2), p.spentMtd], p.categoryId).toEqual([Number(l.plannedAmount).toFixed(2), Number(l.actualAmount).toFixed(2)]);
    }
  });

  it("GET /money/position is byte-identical to computePosition on the baseline's inputs", async () => {
    const pos = await call("GET", "/money/position");
    const baseline = await buildAffordBaseline(HH[A_OWNER]!.householdId, A_OWNER);
    expect(pos.text).toBe(JSON.stringify(computePosition(baseline.positionInputs)));
    expect(JSON.parse(pos.text).safeToSpendNow).toBe("144.50");
  });

  it("a $0 purchase reproduces the baseline to the cent; the baseline is the position", async () => {
    const r = await evaluateAffordForHousehold(HH[A_OWNER]!.householdId, A_OWNER, { amount: 0 });
    expect(r.proposed).toEqual(r.baseline);
    expect(r.baseline).toEqual(SATURDAY_300.baseline);
  });

  it("refuses what it cannot read", async () => {
    for (const body of [
      { amount: 0 },
      { amount: -5 },
      { amount: 100000.01 },
      { amount: "300" },
      {},
      { amount: 10, date: "2026-02-30" },
      { amount: 10, date: "10/10/2026" },
      { amount: 10, extra: 1 },
    ]) {
      expect((await call("POST", "/money/afford", body)).status, JSON.stringify(body)).toBe(400);
    }
    const past = await call("POST", "/money/afford", { amount: 10, date: "2027-01-06" });
    expect(past.status).toBe(400);
    expect(past.json).toEqual({ error: "date_past_window" });
    expect((await call("POST", "/money/afford", { amount: 100000, date: "2027-01-05" })).status).toBe(200);
  });

  it("a member of the household is noted; a stranger's id is Not found", async () => {
    const ok = await call("POST", "/money/afford", { amount: 20, member: A_MEMBER });
    expect(ok.status).toBe(200);
    expect(ok.json.assumptions).toContain(AFFORD_ASSUMPTIONS.sharedCap);
    expect((await call("POST", "/money/afford", { amount: 20, member: A_OWNER })).status).toBe(200);
    expect((await call("POST", "/money/afford", { amount: 20, member: B_MEMBER })).status).toBe(404);
    expect((await call("POST", "/money/afford", { amount: 20, member: B_OWNER })).status).toBe(404);
  });
});

describe("POST /money/afford — household scoping", () => {
  it("another household's category is Not found, and a guessed id too", async () => {
    expect((await call("POST", "/money/afford", { amount: 20, categoryId: bDiningId })).status).toBe(404);
    expect((await call("POST", "/money/afford", { amount: 20, categoryId: "not-a-uuid" })).status).toBe(404);
    expect((await call("POST", "/money/afford", { amount: 20, categoryId: randomUUID() })).status).toBe(404);
  });

  it("B's owner and member each get B's household: nothing of A's", async () => {
    for (const who of [B_OWNER, B_MEMBER]) {
      const r = await call("POST", "/money/afford", { amount: 300, date: "2026-10-10" }, who);
      expect(r.status).toBe(200);
      expect(r.json.baseline.safeToSpendNow).toBeNull();
      expect(r.json.baseline.availableUntilPayday).toBeNull();
      expect(r.json.proposed.safeToSpendNow).toBeNull();
      expect(r.text).not.toMatch(/2624\.50|2124\.50|144\.50|Electric|Paycheck/);
      expect((await call("POST", "/money/afford", { amount: 20, categoryId: diningId }, who)).status).toBe(404);
    }
  });
});

describe("the wish list, evaluated", () => {
  const lastOf = async (id: string) =>
    (await db.select({ v: wishlistItemsTable.lastEvaluation }).from(wishlistItemsTable).where(eq(wishlistItemsTable.id, id)))[0]!.v as Record<string, unknown> | null;

  it("each pending item with an amount, as if bought today; idempotent for the day", async () => {
    const A = HH[A_OWNER]!.householdId;
    const first = await evaluateWishlist(A, A_OWNER);
    expect(first.evaluated).toBe(1);
    // $300 today: the week goes over its cap (144.50 − 300); until payday 2,124.50 − 300.
    const bike = await lastOf(wish.Bike!);
    expect(bike).toEqual({
      evaluatedAt: NOW.toISOString(),
      verdict: "tight",
      safeToSpendNowAfter: "0.00",
      availableUntilPaydayAfter: "1824.50",
    });
    const direct = await evaluateAffordForHousehold(A, A_OWNER, { amount: 300, categoryId: diningId });
    expect([direct.verdict, direct.proposed.safeToSpendNow, direct.proposed.availableUntilPayday]).toEqual(["tight", "0.00", "1824.50"]);
    expect(await lastOf(wish.Lamp!)).toBeNull(); // no amount
    expect(await lastOf(wish["Old chair"]!)).toBeNull(); // decided
    expect(await lastOf(wish["B thing"]!)).toBeNull(); // another household

    const again = await evaluateWishlist(A, A_OWNER, { now: new Date("2026-10-07T23:30:00-05:00") });
    expect(again.evaluated).toBe(0);
    expect(await lastOf(wish.Bike!)).toEqual(bike);

    // The job: the fan-out names A (and B, which has a pending item), each household's run is the same pass.
    _emittedForTests.length = 0;
    const fan = await handleWishlistEvaluateJobs([{ id: "j-fan", data: { fanout: true } } as never]);
    expect(fan.fannedOut).toBeGreaterThanOrEqual(2);
    expect(_emittedForTests).toContainEqual(
      expect.objectContaining({ queue: QUEUES.wishlistEvaluate, data: { householdId: A, ownerUserId: A_OWNER } }),
    );
    const one = await handleWishlistEvaluateJobs([{ id: "j-a", data: { householdId: A, ownerUserId: A_OWNER } } as never]);
    expect(one).toEqual({ households: 1, evaluated: 0, fannedOut: 0 });

    // Yesterday's answer is stale: re-read.
    await db
      .update(wishlistItemsTable)
      .set({ lastEvaluation: { ...bike, evaluatedAt: "2026-10-06T17:00:00.000Z" } })
      .where(eq(wishlistItemsTable.id, wish.Bike!));
    expect((await evaluateWishlist(A, A_OWNER)).evaluated).toBe(1);
    expect(await lastOf(wish.Bike!)).toEqual(bike);
  });

  it("POST /wishlist/:id/evaluate runs one item now; scoped; no amount is a 400", async () => {
    const r = await call("POST", `/wishlist/${wish.Bike}/evaluate`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      itemId: wish.Bike,
      lastEvaluation: { evaluatedAt: NOW.toISOString(), verdict: "tight", safeToSpendNowAfter: "0.00", availableUntilPaydayAfter: "1824.50" },
    });
    expect((await call("POST", `/wishlist/${wish.Lamp}/evaluate`)).status).toBe(400);
    expect((await call("POST", `/wishlist/${wish["B thing"]}/evaluate`)).status).toBe(404);
    expect((await call("POST", `/wishlist/not-a-uuid/evaluate`)).status).toBe(404);
    expect((await call("POST", `/wishlist/${wish.Bike}/evaluate`, undefined, B_OWNER)).status).toBe(404);
    const [b] = await db
      .select({ v: wishlistItemsTable.lastEvaluation })
      .from(wishlistItemsTable)
      .where(and(eq(wishlistItemsTable.id, wish["B thing"]!), eq(wishlistItemsTable.householdId, HH[B_OWNER]!.householdId)));
    expect(b!.v).toBeNull();
  });
});

describe("the agent's evaluate_scenario tool is this code", () => {
  const ctx = () => ({ householdId: HH[A_OWNER]!.householdId, ownerUserId: A_OWNER, actorUserId: A_OWNER, runId: randomUUID() });
  const tool = () => makeTools(ctx()).find((t) => t.name === "evaluate_scenario")!;

  it("returns evaluateAfford's figures; refuses another household's category", async () => {
    const t = tool();
    const out = JSON.parse(await t.run(t.inputSchema.parse({ extraSpend: { amount: 300, date: "2026-10-10" } })));
    expect(out.verdict).toBe("tight");
    expect(out.before).toEqual(SATURDAY_300.baseline);
    expect(out.after).toEqual(SATURDAY_300.proposed);
    expect(out.debt).toEqual(SATURDAY_300.debt);
    expect(JSON.parse(await t.run({ extraSpend: { amount: 20, categoryId: bDiningId } }))).toEqual({ error: "not_found" });
    expect(JSON.parse(await t.run({ extraSpend: { amount: 20, date: "2027-01-06" } }))).toEqual({ error: "date_past_window" });
    expect(JSON.parse(await t.run({ extraSpend: { amount: 20, date: "2026-02-30" } }))).toEqual({ error: "bad_date" });
  });

  it("'Can I spend $300 this weekend?' — the fake model calls it and answers with its figures", async () => {
    resetFake();
    invalidateTaskConfigCache();
    queueFakeChat({
      calls: [{ name: "evaluate_scenario", input: { extraSpend: { amount: 300, date: "2026-10-10" } } }],
      text: (results) => {
        const r = JSON.parse(results[0]!);
        return `That reads ${r.verdict}: this week's limit would be at ${r.after.remainingWeek} and safe to spend now ${r.after.safeToSpendNow}.`;
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const [conv] = await db
      .insert(agentConversationsTable)
      .values({ householdId: HH[A_OWNER]!.householdId, userId: A_OWNER })
      .returning({ id: agentConversationsTable.id });
    const { status, text, grounded } = await runAgent({
      ctx: { householdId: HH[A_OWNER]!.householdId, ownerUserId: A_OWNER, actorUserId: A_OWNER },
      conversationId: conv!.id,
      userText: "Can I spend $300 this weekend?",
      onEvent: () => {},
    });
    expect(status).toBe("succeeded");
    expect(text).toContain("tight");
    expect(text).toContain("-155.50");
    expect(grounded).toBe(true);
  });
});

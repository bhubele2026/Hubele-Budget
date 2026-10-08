// (V1) GET/PUT /categorization/settings: scoping, the owner-only write, the
// settings row, the shape against the spec, and "the screen and the job agree".
// Synthetic data only; the model is the fake provider.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router } from "express";

const OWNER = `v1-rt-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER = `v1-rt-m-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `v1-rt-o-${process.pid}-${randomUUID().slice(0, 8)}`;
const WHO: Record<string, { householdId: string; ownerUserId: string; actual: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { headers: Record<string, string | string[] | undefined>; userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const w = WHO[String(req.headers["x-test-user"] ?? OWNER)]!;
    // A member's userId is remapped to the owner; actualUserId stays theirs.
    req.userId = w.ownerUserId;
    req.actualUserId = w.actual;
    req.householdId = w.householdId;
    req.householdOwnerId = w.ownerUserId;
    next();
  },
}));

import {
  db,
  categoryDecisionsTable,
  mappingRulesTable,
  merchantMemoryTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { GetCategorizationSettingsResponse } from "@workspace/api-zod";
import { registerFakeFixture, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import categorizationSettingsRouter, { RECENT_DECISIONS_MAX } from "../routes/categorizationSettings";
import settingsRouter from "../routes/settings";
import { runCategorizeJob } from "../jobs/handlers/categorize";
import { loadModelGate } from "../lib/categorizer/modelGate";
import { pinEnv } from "./_helpers/aiEnv";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { addTxn, fixtureBy, seedCategories, wipeHousehold, type Cats } from "./_helpers/aiCategorize";

pinEnv({ AI_ENABLED: "true", AI_PROVIDER: "fake" });

const api = Router();
api.use(categorizationSettingsRouter);
api.use(settingsRouter);
const { baseUrl } = createTestApp(api);
async function call(method: string, path: string, who = OWNER, body?: unknown) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": who },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

let HH = "";
let HH_OTHER = "";
let C: Cats;
let C_OTHER: Cats;

const prefsOf = async (owner: string) =>
  (await db.select({ p: settingsTable.preferences }).from(settingsTable).where(eq(settingsTable.userId, owner)))[0]?.p as
    | Record<string, unknown>
    | null
    | undefined;

async function decide(householdId: string, txn: string, o: Partial<typeof categoryDecisionsTable.$inferInsert> = {}) {
  const [d] = await db
    .insert(categoryDecisionsTable)
    .values({ householdId, transactionId: txn, source: "model", categoryId: null, confidence: "0.850", band: "provisional", explanation: "x", inputHash: randomUUID(), ...o })
    .returning();
  return d!;
}

let seeded = 0;
async function seedAccepted(n: number) {
  for (let i = 0; i < n; i++) {
    seeded += 1;
    const t = await addTxn(HH, OWNER, { categoryId: C.Groceries, description: `V1 OLD ${seeded}` });
    await decide(HH, t, { categoryId: C.Groceries, resolution: "accepted", resolvedBy: OWNER, resolvedVia: "user", resolvedAt: new Date(Date.now() - 3_600_000 + seeded), createdAt: new Date(Date.now() - 86_400_000) });
  }
}

beforeAll(async () => {
  const own = await createTestHousehold(OWNER);
  HH = own.householdId;
  WHO[OWNER] = { householdId: HH, ownerUserId: OWNER, actual: OWNER };
  WHO[MEMBER] = { householdId: HH, ownerUserId: OWNER, actual: MEMBER };
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  WHO[OTHER] = { householdId: HH_OTHER, ownerUserId: OTHER, actual: OTHER };
  C = await seedCategories(HH, OWNER);
  C_OTHER = await seedCategories(HH_OTHER, OTHER);
});
beforeEach(async () => {
  resetFake();
  invalidateTaskConfigCache();
  for (const h of [HH, HH_OTHER]) {
    await wipeHousehold(h);
    await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, h));
  }
  await db.delete(settingsTable).where(eq(settingsTable.userId, OWNER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, OTHER));
});

describe("GET /categorization/settings", () => {
  it("any member reads the household's view; it matches the spec; defaults when no settings row exists", async () => {
    const res = await call("GET", "/categorization/settings", MEMBER);
    expect(res.status).toBe(200);
    expect(() => GetCategorizationSettingsResponse.parse(res.json)).not.toThrow();
    expect(res.json).toMatchObject({
      autoCategorize: true,
      modelAutoCategorize: false,
      ai: { configured: true, enabled: true },
      engine: { rules: 0, learned: 0, memories: 0, recurring: 0 },
      model: { mode: "suggest", eligible: false, judged: 0, accuracy: { last50: { right: 0, judged: 0 }, last20: { right: 0, judged: 0 } } },
      recent: [],
      reviewCount: 0,
    });
    expect(res.json.model.requirements.map((r: { key: string }) => r.key)).toEqual(["ai", "owner_switch", "judged", "accuracy"]);
    // Reading never creates the owner's settings row.
    expect(await prefsOf(OWNER)).toBeUndefined();
  });

  it("counts the engine's sources for this household only", async () => {
    await db.insert(mappingRulesTable).values([
      { userId: OWNER, householdId: HH, pattern: "V1 RULE A", matchType: "contains", categoryId: C.Groceries, priority: 0 },
      { userId: OWNER, householdId: HH, pattern: "V1 RULE B", matchType: "contains", categoryId: C.Dining, priority: 1 },
      { userId: OTHER, householdId: HH_OTHER, pattern: "V1 RULE C", matchType: "contains", categoryId: C_OTHER.Dining, priority: 0 },
    ]);
    await db.insert(merchantMemoryTable).values([
      { householdId: HH, signature: "v1 sig a", scope: "merchant", categoryId: C.Groceries },
      { householdId: HH, signature: "v1 sig b", scope: "merchant", categoryId: C.Dining, disabledAt: new Date() },
      { householdId: HH_OTHER, signature: "v1 sig c", scope: "merchant", categoryId: C_OTHER.Dining },
    ]);
    await db.insert(recurringItemsTable).values([
      { userId: OWNER, householdId: HH, name: "V1 Rent", amount: "100.00", active: "true" },
      { userId: OWNER, householdId: HH, name: "V1 Gone", amount: "10.00", active: "false" },
    ]);
    const res = await call("GET", "/categorization/settings");
    expect(res.json.engine).toEqual({ rules: 2, learned: 2, memories: 1, recurring: 1 });
  });

  it("recent: newest first, at most 20, any source, never another household's; undoable and resolvedBy as the rows say", async () => {
    const theirs = await addTxn(HH_OTHER, OTHER, { description: "V1 THEIRS" });
    await decide(HH_OTHER, theirs, { createdAt: new Date(Date.now() + 60_000) });
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 22; i++) {
      const t = await addTxn(HH, OWNER, { description: `V1 OLD ${i}`, categoryId: C.Groceries });
      await decide(HH, t, { source: "rule", band: "auto", categoryId: C.Groceries, confidence: "0.950", createdAt: new Date(base + i) });
    }
    const silent = await addTxn(HH, OWNER, { description: "V1 SILENT", categoryId: C.Groceries, categoryProvisional: true });
    const dSilent = await decide(HH, silent, { categoryId: C.Groceries, resolution: "accepted", resolvedVia: "silent", resolvedAt: new Date(), createdAt: new Date(base + 100) });
    const locked = await addTxn(HH, OWNER, { description: "V1 LOCKED", categoryId: C.Groceries, categoryLockedByUser: true });
    const dLocked = await decide(HH, locked, { categoryId: C.Groceries, createdAt: new Date(base + 101) });
    const moved = await addTxn(HH, OWNER, { description: "V1 MOVED", categoryId: C.Dining });
    const dMoved = await decide(HH, moved, { categoryId: C.Groceries, createdAt: new Date(base + 102) });
    const undone = await addTxn(HH, OWNER, { description: "V1 UNDONE" });
    const dUndone = await decide(HH, undone, { categoryId: C.Groceries, undoneAt: new Date(), createdAt: new Date(base + 103) });
    const queued = await addTxn(HH, OWNER, { description: "V1 QUEUED" });
    const dQueued = await decide(HH, queued, { band: "queue", categoryId: C.Dining, confidence: "0.500", createdAt: new Date(base + 104) });

    const res = await call("GET", "/categorization/settings", MEMBER);
    expect(() => GetCategorizationSettingsResponse.parse(res.json)).not.toThrow();
    const recent = res.json.recent as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(RECENT_DECISIONS_MAX);
    expect(recent.some((r) => r.description === "V1 THEIRS")).toBe(false);
    expect(recent.slice(0, 5).map((r) => r.id)).toEqual([dQueued.id, dUndone.id, dMoved.id, dLocked.id, dSilent.id]);
    const byId = new Map(recent.map((r) => [r.id, r]));
    expect(byId.get(dQueued.id)).toMatchObject({ band: "queue", undoable: true, resolvedBy: null, categoryName: expect.stringContaining("Dining") });
    expect(byId.get(dUndone.id)).toMatchObject({ undoable: false });
    expect(byId.get(dMoved.id)).toMatchObject({ undoable: false });
    expect(byId.get(dLocked.id)).toMatchObject({ undoable: false });
    expect(byId.get(dSilent.id)).toMatchObject({ resolution: "accepted", resolvedBy: "silent", undoable: true, description: "V1 SILENT", amount: "-10.00", source: "model" });
    // Open queue: queued + locked + moved are open (provisional|queue, unresolved, not undone).
    expect(res.json.reviewCount).toBe(3);
    // The other household sees only its own.
    const theirView = await call("GET", "/categorization/settings", OTHER);
    expect(theirView.json.recent.map((r: { description: string }) => r.description)).toEqual(["V1 THEIRS"]);
  });
});

describe("PUT /categorization/settings", () => {
  it("a member gets 403 owner_only and nothing is written", async () => {
    const res = await call("PUT", "/categorization/settings", MEMBER, { modelAutoCategorize: true });
    expect(res).toEqual({ status: 403, json: { error: "owner_only" } });
    expect(await prefsOf(OWNER)).toBeUndefined();
  });

  it("rejects an empty body, an unknown key, and a non-boolean", async () => {
    for (const body of [{}, { modelAutoCategorize: true, extra: 1 }, { autoCategorize: "yes" }]) {
      expect((await call("PUT", "/categorization/settings", OWNER, body)).status).toBe(400);
    }
    expect(await prefsOf(OWNER)).toBeUndefined();
  });

  it("creates the owner's settings row on the first PUT, then merges — never dropping another key", async () => {
    const first = await call("PUT", "/categorization/settings", OWNER, { modelAutoCategorize: true });
    expect(first.status).toBe(200);
    expect(() => GetCategorizationSettingsResponse.parse(first.json)).not.toThrow();
    expect(first.json).toMatchObject({ autoCategorize: true, modelAutoCategorize: true, model: { mode: "suggest" } });
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.userId, OWNER));
    expect(row).toMatchObject({ householdId: HH, preferences: { modelAutoCategorize: true } });

    await db.update(settingsTable).set({ preferences: { modelAutoCategorize: true, weeklyBucketLabels: { groceries: "Food" }, amexAnchor: { lastAutoBalance: "1.00" } } }).where(eq(settingsTable.userId, OWNER));
    const second = await call("PUT", "/categorization/settings", OWNER, { autoCategorize: false });
    expect(second.json).toMatchObject({ autoCategorize: false, modelAutoCategorize: true, model: { mode: "off" } });
    expect(await prefsOf(OWNER)).toEqual({ autoCategorize: false, modelAutoCategorize: true, weeklyBucketLabels: { groceries: "Food" }, amexAnchor: { lastAutoBalance: "1.00" } });
    // The job reads exactly what the route wrote.
    expect(await loadModelGate(HH, OWNER)).toMatchObject({ autoCategorize: false, modelAutoCategorize: true });
  });

  it("a classic PUT /settings does not drop the two switches", async () => {
    await call("PUT", "/categorization/settings", OWNER, { autoCategorize: false, modelAutoCategorize: true });
    const res = await call("PUT", "/settings", OWNER, { preferences: { weeklyBucketLabels: { groceries: "Food" } } });
    expect(res.status).toBe(200);
    expect(await prefsOf(OWNER)).toMatchObject({ autoCategorize: false, modelAutoCategorize: true, weeklyBucketLabels: { groceries: "Food" } });
  });
});

describe("the screen and the job agree (one function)", () => {
  const modelBand = async (t: string) =>
    (await db.select().from(categoryDecisionsTable).where(and(eq(categoryDecisionsTable.transactionId, t), eq(categoryDecisionsTable.source, "model"))))[0];

  it("suggest on the screen → the job keeps a sure answer provisional; auto on the screen → it files outright", async () => {
    registerFakeFixture("categorize", fixtureBy([["GREEN GROCER", { cat: C.Groceries, confidence: "high" }]]));
    // The owner's switch is on, but the record is one judgment short.
    await seedAccepted(29);
    expect((await call("PUT", "/categorization/settings", OWNER, { modelAutoCategorize: true })).json.model).toMatchObject({ mode: "suggest", eligible: false, judged: 29 });
    const a = await addTxn(HH, OWNER, { description: "GREEN GROCER 1" });
    await runCategorizeJob({ householdId: HH, ownerUserId: OWNER, txnIds: [a] });
    expect(await modelBand(a)).toMatchObject({ band: "provisional", categoryId: C.Groceries });

    // One more judged: the screen says auto, and the job files outright.
    await seedAccepted(1);
    expect((await call("GET", "/categorization/settings", MEMBER)).json.model).toMatchObject({ mode: "auto", eligible: true, judged: 30 });
    const b = await addTxn(HH, OWNER, { description: "GREEN GROCER 2" });
    await runCategorizeJob({ householdId: HH, ownerUserId: OWNER, txnIds: [b] });
    expect(await modelBand(b)).toMatchObject({ band: "auto", categoryId: C.Groceries });
    expect((await db.select().from(transactionsTable).where(eq(transactionsTable.id, b)))[0]).toMatchObject({ categoryId: C.Groceries, categoryProvisional: false });

    // The owner turns it off: suggest again, provisional again.
    expect((await call("PUT", "/categorization/settings", OWNER, { modelAutoCategorize: false })).json.model).toMatchObject({ mode: "suggest", eligible: true });
    const c = await addTxn(HH, OWNER, { description: "GREEN GROCER 3" });
    await runCategorizeJob({ householdId: HH, ownerUserId: OWNER, txnIds: [c] });
    expect(await modelBand(c)).toMatchObject({ band: "provisional" });
  });
});

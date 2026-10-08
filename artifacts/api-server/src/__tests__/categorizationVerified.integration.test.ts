// (V7) Verified ≠ left unchanged; file everything up to today.
//
//   * migration 0116: the resolution check gains 'unreviewed' (only when it
//     lacks it) and every accepted + silent row becomes unreviewed;
//   * settleSilentAcceptances → 'unreviewed', the row stays provisional, it
//     leaves the queue, and neither the gate record nor the priors count it;
//   * POST /categorization/run { scope: "all" }: the whole backlog in slices,
//     never a locked row or a person's filing, idempotent, owner only;
//   * GET /categorization/settings: verified / unreviewed, backlog, banks.
// Synthetic data only; the model is the fake provider.
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";

const OWNER = `v7-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER = `v7-m-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `v7-o-${process.pid}-${randomUUID().slice(0, 8)}`;
const WHO: Record<string, { householdId: string; ownerUserId: string; actual: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { headers: Record<string, string | string[] | undefined>; userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const w = WHO[String(req.headers["x-test-user"] ?? OWNER)]!;
    req.userId = w.ownerUserId;
    req.actualUserId = w.actual;
    req.householdId = w.householdId;
    req.householdOwnerId = w.ownerUserId;
    next();
  },
}));

import { db, pool, categoryDecisionsTable, mappingRulesTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import { GetCategorizationSettingsResponse, RunCategorizationResponse } from "@workspace/api-zod";
import { resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import categorizationRouter from "../routes/categorization";
import categorizationSettingsRouter from "../routes/categorizationSettings";
import { BACKLOG_SLICE, runCategorizationBacklog } from "../lib/categorizer";
import { evaluateModelGate, MODEL_AUTO_MIN_JUDGED } from "../lib/categorizer/modelGate";
import { loadPriors } from "../lib/categorizer/modelPriors";
import { SILENT_ACCEPT_DAYS, openReviewCount, settleSilentAcceptances } from "../lib/categorizer/review";
import { MAX_JOB_IDS, enqueueCategorizeChunks } from "../jobs/handlers/categorize";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";
import { pinEnv } from "./_helpers/aiEnv";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { addTxn, daysAgo, seedCategories, wipeHousehold, type Cats } from "./_helpers/aiCategorize";

const WEBHOOK = "https://h2.example.test/api/plaid/webhook";
pinEnv({ AI_ENABLED: "true", AI_PROVIDER: "fake", PLAID_WEBHOOK_URL: WEBHOOK });

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../lib/db/migrations/0116_category_decisions_unreviewed.sql",
);

const api = Router();
api.use(categorizationRouter);
api.use(categorizationSettingsRouter);
const { baseUrl } = createTestApp(api);
async function call(method: string, p: string, who = OWNER, body?: unknown) {
  const res = await fetch(`${baseUrl()}${p}`, {
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
const DAY = 86_400_000;

const decisionsOf = async (txn: string) =>
  db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, txn));
const decisionCount = async () =>
  (await db.select({ id: categoryDecisionsTable.id }).from(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, HH))).length;
const txnRow = async (id: string) => (await db.select().from(transactionsTable).where(eq(transactionsTable.id, id)))[0]!;

/** Model decisions on fresh rows, resolved one second apart in the past. */
async function seedResolved(n: number, resolution: "accepted" | "corrected" | "unreviewed") {
  if (n === 0) return;
  const via = resolution === "unreviewed" ? "silent" : "user";
  const txns = await db
    .insert(transactionsTable)
    .values(Array.from({ length: n }, (_, i) => ({ userId: OWNER, householdId: HH, occurredOn: daysAgo(30), description: `V7 SEEN ${resolution} ${i}`, amount: "-5.00", source: "plaid:bank", categoryId: C.Groceries, categoryProvisional: resolution === "unreviewed" })))
    .returning({ id: transactionsTable.id });
  const start = Date.now() - 3_600_000;
  await db.insert(categoryDecisionsTable).values(
    txns.map((t, i) => ({
      householdId: HH, transactionId: t.id, source: "model", categoryId: C.Groceries, confidence: "0.850", band: "provisional",
      explanation: "x", inputHash: randomUUID(), resolution, resolvedVia: via, resolvedBy: via === "user" ? OWNER : null,
      resolvedAt: new Date(start + i * 1000), createdAt: new Date(start + i * 1000 - 20 * DAY),
    })),
  );
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  WHO[OWNER] = { householdId: HH, ownerUserId: OWNER, actual: OWNER };
  WHO[MEMBER] = { householdId: HH, ownerUserId: OWNER, actual: MEMBER };
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  WHO[OTHER] = { householdId: HH_OTHER, ownerUserId: OTHER, actual: OTHER };
  C = await seedCategories(HH, OWNER);
});
const wipe = async () => {
  for (const h of [HH, HH_OTHER]) {
    await wipeHousehold(h);
    // Plaid items are swept database-wide by other files (the webhook boot sweep): never leave one behind.
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, h));
  }
};
beforeEach(async () => {
  resetFake();
  invalidateTaskConfigCache();
  _emittedForTests.length = 0;
  await wipe();
});
afterAll(wipe);

describe("migration 0116", () => {
  it("widens the check only while it lacks 'unreviewed' (to drizzle's own), backfills accepted + silent, keeps a person's acceptance; a second run changes nothing", async () => {
    const sqlText = await readFile(MIGRATION, "utf8");
    const t1 = await addTxn(HH, OWNER, { categoryId: C.Groceries });
    const t2 = await addTxn(HH, OWNER, { categoryId: C.Dining });
    const DEF = `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
                  WHERE conname = 'category_decisions_resolution_ck' AND conrelid = 'category_decisions'::regclass`;
    // What drizzle-kit pushed from lib/db/src/schema/categorization.ts.
    const drizzleDef = (await pool.query<{ d: string }>(DEF)).rows[0]!.d;
    expect(drizzleDef).toContain("unreviewed");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The shape production has before this file: the 0020 check.
      await client.query("ALTER TABLE category_decisions DROP CONSTRAINT category_decisions_resolution_ck");
      await client.query(
        // NOT VALID: other files' rows in this shared database may already say 'unreviewed'; new writes are still checked.
        "ALTER TABLE category_decisions ADD CONSTRAINT category_decisions_resolution_ck CHECK (resolution IS NULL OR resolution IN ('accepted','corrected','skipped')) NOT VALID",
      );
      const ins = async (txn: string, cat: string, via: string) =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO category_decisions (household_id, transaction_id, source, category_id, confidence, band, explanation, input_hash, resolution, resolved_via, resolved_at)
             VALUES ($1, $2, 'model', $3, '0.850', 'provisional', 'x', $4, 'accepted', $5, now()) RETURNING id`,
            [HH, txn, cat, randomUUID(), via],
          )
        ).rows[0]!.id;
      const silent = await ins(t1, C.Groceries, "silent");
      const person = await ins(t2, C.Dining, "user");
      await client.query("SAVEPOINT before");
      await expect(client.query("UPDATE category_decisions SET resolution = 'unreviewed' WHERE id = $1", [silent])).rejects.toThrow(
        /category_decisions_resolution_ck/,
      );
      await client.query("ROLLBACK TO SAVEPOINT before");
      const state = async () =>
        Object.fromEntries(
          (await client.query<{ id: string; resolution: string; resolved_via: string }>(
            "SELECT id, resolution, resolved_via FROM category_decisions WHERE id = ANY($1)",
            [[silent, person]],
          )).rows.map((r) => [r.id, `${r.resolution}/${r.resolved_via}`]),
        );
      await client.query(sqlText);
      expect(await state()).toEqual({ [silent]: "unreviewed/silent", [person]: "accepted/user" });
      expect((await client.query<{ d: string }>(DEF)).rows[0]!.d).toBe(drizzleDef);
      await client.query(sqlText);
      expect(await state()).toEqual({ [silent]: "unreviewed/silent", [person]: "accepted/user" });
      expect((await client.query<{ d: string }>(DEF)).rows[0]!.d).toBe(drizzleDef);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("left unchanged is not verified", () => {
  it("settle: resolution 'unreviewed', resolved_via 'silent'; the row stays provisional; it leaves the queue", async () => {
    const now = new Date();
    const txn = await addTxn(HH, OWNER, { categoryId: C.Coffee, categoryProvisional: true, description: "KESTREL CAFE #1", occurredOn: daysAgo(20) });
    const [d] = await db
      .insert(categoryDecisionsTable)
      .values({ householdId: HH, transactionId: txn, source: "model", categoryId: C.Coffee, confidence: "0.850", band: "provisional", explanation: "x", inputHash: randomUUID(), createdAt: new Date(now.getTime() - SILENT_ACCEPT_DAYS * DAY) })
      .returning();
    expect(await openReviewCount(HH)).toBe(1);
    expect(await settleSilentAcceptances(HH, now)).toBe(1);
    expect((await decisionsOf(txn))[0]).toMatchObject({ id: d!.id, resolution: "unreviewed", resolvedVia: "silent", resolvedAt: now, undoneAt: null });
    expect(await txnRow(txn)).toMatchObject({ categoryId: C.Coffee, categoryProvisional: true, categoryLockedByUser: false });
    expect(await openReviewCount(HH)).toBe(0);
    expect((await evaluateModelGate(HH, OWNER, now)).judged).toBe(0);
    // A second pass settles nothing.
    expect(await settleSilentAcceptances(HH, new Date(now.getTime() + DAY))).toBe(0);
  });

  it("the gate: 29 verified + 5 unreviewed leaves the judged row unmet; the 30th verified meets it", async () => {
    await seedResolved(MODEL_AUTO_MIN_JUDGED - 1, "accepted");
    await seedResolved(5, "unreviewed");
    const g = await evaluateModelGate(HH, OWNER);
    expect(g.judged).toBe(29);
    expect(g.requirements.find((r) => r.key === "judged")).toEqual({
      key: "judged", label: "At least 30 suggestions you verified in Review.", met: false, current: 29, target: 30,
    });
    expect(g.requirements.find((r) => r.key === "accuracy")!.label).toBe("9 in 10 right among the last 50 you verified.");
    const view = (await call("GET", "/categorization/settings")).json;
    expect(view.model).toMatchObject({ judged: 29, verified: 29, unreviewed: 5 });
    await seedResolved(1, "accepted");
    const g2 = await evaluateModelGate(HH, OWNER);
    expect(g2.requirements.find((r) => r.key === "judged")).toMatchObject({ met: true, current: 30 });
    expect((await call("GET", "/categorization/settings")).json.model).toMatchObject({ verified: 30, unreviewed: 5 });
  });

  it("the priors: an unreviewed suggestion is never a prior; a person's acceptance is", async () => {
    const add = async (description: string, cat: string, resolution: "accepted" | "unreviewed") => {
      const t = await addTxn(HH, OWNER, { description, categoryId: cat, occurredOn: daysAgo(5), amount: "-7.00", categoryProvisional: resolution === "unreviewed" });
      await db.insert(categoryDecisionsTable).values({
        householdId: HH, transactionId: t, source: "model", categoryId: cat, confidence: "0.850", band: "provisional", explanation: "x",
        inputHash: randomUUID(), resolution, resolvedAt: new Date(), resolvedVia: resolution === "unreviewed" ? "silent" : "user",
      });
    };
    await add("KESTREL CAFE #1", C.Coffee, "accepted");
    await add("KESTREL CAFE #2", C.Income, "unreviewed");
    const ask = await addTxn(HH, OWNER, { description: "KESTREL CAFE #3", amount: "-7.10" });
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.id, ask));
    const names = (await loadPriors(HH, rows as never)).get(ask)!.map((p) => p.categoryName);
    expect(names.some((n) => n.startsWith("Coffee"))).toBe(true);
    expect(names.some((n) => n.startsWith("Income"))).toBe(false);
  });
});

describe("POST /categorization/run { scope: 'all' }", () => {
  it("files a 200-day-old unfiled row the default run skips; never a locked row or a person's filing; a second run adds nothing", async () => {
    await db.insert(mappingRulesTable).values({ userId: OWNER, householdId: HH, pattern: "ACME GROCER", matchType: "contains", categoryId: C.Groceries, priority: 1 });
    const old = await addTxn(HH, OWNER, { description: "ACME GROCER 0412", occurredOn: daysAgo(200) });
    const locked = await addTxn(HH, OWNER, { description: "ACME GROCER 0413", occurredOn: daysAgo(300), categoryLockedByUser: true });
    const handFiled = await addTxn(HH, OWNER, { description: "ACME GROCER 0414", occurredOn: daysAgo(250), categoryId: C.Dining });
    const unknown = await addTxn(HH, OWNER, { description: "ZZQX NOWHERE 1", occurredOn: daysAgo(400) });
    // A suggestion left 15 days: the run settles it first and reports it.
    const left = await addTxn(HH, OWNER, { description: "PLOVER 9", occurredOn: daysAgo(16), categoryId: C.Coffee, categoryProvisional: true });
    await db.insert(categoryDecisionsTable).values({ householdId: HH, transactionId: left, source: "model", categoryId: C.Coffee, confidence: "0.850", band: "provisional", explanation: "x", inputHash: randomUUID(), createdAt: new Date(Date.now() - 15 * DAY) });

    const plain = await call("POST", "/categorization/run", OWNER, {});
    expect(plain.status).toBe(200);
    expect(() => RunCategorizationResponse.parse(plain.json)).not.toThrow();
    expect(await txnRow(old)).toMatchObject({ categoryId: null });
    expect(plain.json).toMatchObject({ filed: 0, suggested: 0, queued: 0, unreviewed: 1, remaining: 2 });
    _emittedForTests.length = 0;

    const before = await decisionCount();
    const res = await call("POST", "/categorization/run", OWNER, { scope: "all" });
    expect(res.status).toBe(200);
    expect(() => RunCategorizationResponse.parse(res.json)).not.toThrow();
    expect(res.json).toMatchObject({ filed: 1, suggested: 0, queued: 0, unreviewed: 1, remaining: 1, decided: 1 });
    expect(await txnRow(old)).toMatchObject({ categoryId: C.Groceries, categoryProvisional: false, categoryLockedByUser: false });
    expect((await decisionsOf(old)).map((d) => [d.source, d.band])).toEqual([["rule", "auto"]]);
    expect(await txnRow(locked)).toMatchObject({ categoryId: null, categoryLockedByUser: true });
    expect(await decisionsOf(locked)).toHaveLength(0);
    expect(await txnRow(handFiled)).toMatchObject({ categoryId: C.Dining });
    expect(await decisionsOf(handFiled)).toHaveLength(0);
    expect(await txnRow(left)).toMatchObject({ categoryId: C.Coffee, categoryProvisional: true });
    expect(await decisionCount()).toBe(before + 1);
    // The model pass: the row nothing could decide, in its own backlog job.
    const jobs = _emittedForTests.filter((e) => e.queue === QUEUES.categorizeBatch);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ householdId: HH, ownerUserId: OWNER, txnIds: [unknown], trigger: "user" });
    expect(jobs[0]!.opts).toMatchObject({ singletonKey: `cat:${HH}:all:0` });
    expect(res.json.modelQueued).toBe(1);

    const again = await call("POST", "/categorization/run", OWNER, { scope: "all" });
    expect(again.json).toMatchObject({ filed: 0, suggested: 0, queued: 0, remaining: 1 });
    expect(await decisionCount()).toBe(before + 1);
  });

  it("owner only: a member is refused and nothing is written", async () => {
    await db.insert(mappingRulesTable).values({ userId: OWNER, householdId: HH, pattern: "ACME GROCER", matchType: "contains", categoryId: C.Groceries, priority: 1 });
    const old = await addTxn(HH, OWNER, { description: "ACME GROCER 0415", occurredOn: daysAgo(200) });
    const res = await call("POST", "/categorization/run", MEMBER, { scope: "all" });
    expect(res.status).toBe(403);
    expect(await txnRow(old)).toMatchObject({ categoryId: null });
    expect(await decisionCount()).toBe(0);
    expect((await call("POST", "/categorization/run", OWNER, { scope: "everything" })).status).toBe(400);
  });

  it("runs every row oldest first, across slices of 500", async () => {
    expect(BACKLOG_SLICE).toBe(500);
    const n = BACKLOG_SLICE + 1;
    const ids = (
      await db
        .insert(transactionsTable)
        .values(Array.from({ length: n }, (_, i) => ({ userId: OWNER, householdId: HH, occurredOn: daysAgo(1000 - i), description: `ZZQX SLICE ${i}`, amount: "-10.00", source: "plaid:bank" })))
        .returning({ id: transactionsTable.id })
    ).map((r) => r.id);
    const out = await runCategorizationBacklog(HH);
    expect(out.since).toBe(daysAgo(1000));
    expect(out.ambiguous).toEqual(ids);
  });

  it("hands the model pass over in jobs of at most MAX_JOB_IDS, each with its own key", async () => {
    const ids = Array.from({ length: 2 * MAX_JOB_IDS + 1 }, () => randomUUID());
    expect(await enqueueCategorizeChunks(HH, OWNER, ids, "user")).toBe(ids.length);
    const jobs = _emittedForTests.filter((e) => e.queue === QUEUES.categorizeBatch);
    expect(jobs.map((j) => (j.data as { txnIds: string[] }).txnIds.length)).toEqual([MAX_JOB_IDS, MAX_JOB_IDS, 1]);
    expect(jobs.map((j) => j.opts?.singletonKey)).toEqual([`cat:${HH}:all:0`, `cat:${HH}:all:1`, `cat:${HH}:all:2`]);
    expect((jobs[2]!.data as { txnIds: string[] }).txnIds).toEqual([ids[2 * MAX_JOB_IDS]]);
  });
});

describe("GET /categorization/settings — V7 fields", () => {
  it("backlog, banks and an unreviewed decision row, matching the spec", async () => {
    await addTxn(HH, OWNER, { occurredOn: daysAgo(300), description: "V7 UNFILED OLD" });
    await addTxn(HH, OWNER, { occurredOn: daysAgo(10), description: "V7 UNFILED NEW" });
    await addTxn(HH, OWNER, { occurredOn: daysAgo(400), description: "V7 LOCKED", categoryLockedByUser: true });
    await addTxn(HH, OWNER, { occurredOn: daysAgo(500), description: "V7 FILED", categoryId: C.Dining });
    const prov = await addTxn(HH, OWNER, { occurredOn: daysAgo(20), description: "V7 PROVISIONAL", categoryId: C.Coffee, categoryProvisional: true });
    await db.insert(categoryDecisionsTable).values({
      householdId: HH, transactionId: prov, source: "model", categoryId: C.Coffee, confidence: "0.850", band: "provisional", explanation: "x",
      inputHash: randomUUID(), resolution: "unreviewed", resolvedVia: "silent", resolvedAt: new Date(),
    });
    await addTxn(HH_OTHER, OTHER, { occurredOn: daysAgo(900), description: "V7 THEIRS" });
    const u = randomUUID().slice(0, 8);
    const item = (o: Partial<typeof plaidItemsTable.$inferInsert>) => ({ userId: OWNER, householdId: HH, itemId: `v7-item-${randomUUID()}`, accessToken: `access-sandbox-${randomUUID()}`, ...o });
    await db.insert(plaidItemsTable).values([
      // 03:00 UTC on Oct 8 is still Oct 7 in the household's calendar.
      item({ itemId: `v7-zeta-${u}`, institutionName: "Zeta Bank", lastSyncedAt: new Date("2026-10-08T03:00:00Z"), webhookUrl: WEBHOOK }),
      item({ itemId: `v7-alpha-${u}`, institutionName: "Alpha Card", lastSyncedAt: null, webhookUrl: null }),
      item({ itemId: `seed-v7-${u}`, institutionName: "Seed Bank" }),
      { ...item({ itemId: `v7-theirs-${u}`, institutionName: "Their Bank" }), userId: OTHER, householdId: HH_OTHER },
    ]);
    const res = await call("GET", "/categorization/settings", MEMBER);
    expect(res.status).toBe(200);
    expect(() => GetCategorizationSettingsResponse.parse(res.json)).not.toThrow();
    expect(res.json.backlog).toEqual({ unfiled: 2, oldestUnfiledOn: daysAgo(300), provisional: 1 });
    expect(res.json.banks).toEqual([
      { itemId: `v7-alpha-${u}`, name: "Alpha Card", lastDataOn: null, autoUpdates: { on: false, reason: "not_registered" } },
      { itemId: `v7-zeta-${u}`, name: "Zeta Bank", lastDataOn: "2026-10-07", autoUpdates: { on: true, reason: "ok" } },
    ]);
    expect(res.json.model).toMatchObject({ verified: 0, unreviewed: 1 });
    expect(res.json.recent.find((r: { transactionId: string }) => r.transactionId === prov)).toMatchObject({ resolution: "unreviewed", resolvedBy: "silent" });
    // Nothing unfiled: zero, and no date.
    await wipeHousehold(HH);
    expect((await call("GET", "/categorization/settings")).json.backlog).toEqual({ unfiled: 0, oldestUnfiledOn: null, provisional: 0 });
    expect(await db.select().from(plaidItemsTable).where(and(eq(plaidItemsTable.householdId, HH), inArray(plaidItemsTable.itemId, [`v7-zeta-${u}`])))).toHaveLength(1);
  });
});

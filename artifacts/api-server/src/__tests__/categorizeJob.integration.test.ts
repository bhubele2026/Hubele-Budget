// (AI-1) The categorize.batch / txn.arrived jobs, the agent trail they write, and
// undo through /agent/actions/:id/undo — against the real test Postgres and the
// fake provider. Synthetic data only.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import type { Job } from "pg-boss";
import { Router } from "express";

const OWNER = `ai1-job-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `ai1-job-o-${process.pid}-${randomUUID().slice(0, 8)}`;
const HHS: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { headers: Record<string, string | string[] | undefined>; userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? OWNER);
    const hh = HHS[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  agentActionsTable,
  agentRunsTable,
  aiBudgetTable,
  aiUsageTable,
  categoryDecisionsTable,
  mappingRulesTable,
  transactionsTable,
} from "@workspace/db";
import { fakeCalls, queueFakeSteps, registerFakeFixture, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import agentRouter from "../routes/agent";
import categorizationRouter from "../routes/categorization";
import { handleCategorizeJobs, runCategorizeJob } from "../jobs/handlers/categorize";
import { handleTxnArrived } from "../jobs/handlers/txnArrived";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";
import { pinEnv } from "./_helpers/aiEnv";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { addTxn, fixtureBy, seedCategories, setPrefs, wipeHousehold, type Cats } from "./_helpers/aiCategorize";

pinEnv({ AI_ENABLED: "true", AI_PROVIDER: "fake", JOBS_MODE: undefined });

const api = Router();
api.use(agentRouter);
api.use(categorizationRouter);
const { baseUrl } = createTestApp(api);
async function call(method: string, path: string, who = OWNER, body?: unknown) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": who },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

let A = "";
let B = "";
let C: Cats;
const DESCRIPTIONS = ["GREEN GROCER 7741", "MOSS CAFE 0099", "ZZSECRET MERCHANT"];

const runsOf = (h: string) => db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, h));
const actionsOf = (h: string) => db.select().from(agentActionsTable).where(eq(agentActionsTable.householdId, h));
const modelDecisionsOf = (h: string) =>
  db.select().from(categoryDecisionsTable).where(and(eq(categoryDecisionsTable.householdId, h), eq(categoryDecisionsTable.source, "model")));
const txnRow = async (id: string) => (await db.select().from(transactionsTable).where(eq(transactionsTable.id, id)))[0]!;
const job = (data: object, id = randomUUID()) => ({ id, data }) as unknown as Job<any>;

beforeAll(async () => {
  HHS[OWNER] = await createTestHousehold(OWNER);
  HHS[OTHER] = await createTestHousehold(OTHER);
  A = HHS[OWNER]!.householdId;
  B = HHS[OTHER]!.householdId;
  C = await seedCategories(A, OWNER);
  await seedCategories(B, OTHER);
});
beforeEach(async () => {
  resetFake();
  invalidateTaskConfigCache();
  _emittedForTests.length = 0;
  await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, A));
  await wipeHousehold(A);
  await wipeHousehold(B);
  await setPrefs(A, OWNER, null);
});

async function threeCharges() {
  const ids: string[] = [];
  for (const d of DESCRIPTIONS) ids.push(await addTxn(A, OWNER, { description: d }));
  registerFakeFixture(
    "categorize",
    fixtureBy([
      ["GREEN GROCER", { cat: C.Groceries, confidence: "high" }],
      ["MOSS CAFE", { cat: C.Coffee, confidence: "medium" }],
      ["ZZSECRET", { cat: C.Dining, confidence: "low" }],
    ]),
  );
  return ids;
}

describe("categorize.batch", () => {
  it("opens a run, files what it can, writes one reversible set_category action per decision, closes the run with a plain summary", async () => {
    const ids = await threeCharges();
    const r = await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids, trigger: "txn_arrived" });
    expect(r).toMatchObject({ status: "succeeded", filed: 2, waiting: 1, actions: 3 });

    const [run] = await runsOf(A);
    expect(run).toMatchObject({ kind: "categorize", trigger: "txn_arrived", status: "succeeded", summary: "Filed 2 charges, 1 waiting for you." });
    expect(run!.finishedAt).not.toBeNull();

    const actions = await actionsOf(A);
    expect(actions).toHaveLength(3);
    for (const a of actions) {
      expect(a).toMatchObject({ type: "set_category", targetKind: "transaction", reversible: true, runId: run!.id });
      expect(a.outcome).toBe("proposed"); // provisional or queued: nothing auto until the gate opens
      expect((a.after as any).decisionId).toBeTruthy();
      expect((a.before as any).categoryId).toBeNull();
    }
    expect((await txnRow(ids[0]!)).categoryId).toBe(C.Groceries);
    expect((await txnRow(ids[2]!)).categoryId).toBeNull();
  });

  it("tokens and cost come from the usage rows of this run", async () => {
    const t = await addTxn(A, OWNER, { description: "GREEN GROCER 1" });
    queueFakeSteps("categorize", {
      kind: "ok",
      usage: { inputTokens: 1234, outputTokens: 56 },
      value: { results: [{ index: 0, categoryId: C.Groceries, confidence: "medium", isTransfer: false, recurringGuess: null, splitSuggestion: null, rationale: "A grocery." }] },
    });
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: [t] });
    const [run] = await runsOf(A);
    expect(run).toMatchObject({ inputTokens: 1234, outputTokens: 56 });
    const usage = await db.select().from(aiUsageTable).where(eq(aiUsageTable.runId, run!.id));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ task: "categorize", promptVersion: "categorize.v1", status: "ok" });
  });

  it("is idempotent: a second run (same ids, or the sweep) makes no new decision, action, run or model call", async () => {
    const ids = await threeCharges();
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    const before = { d: (await modelDecisionsOf(A)).length, a: (await actionsOf(A)).length, r: (await runsOf(A)).length, calls: fakeCalls.length };
    expect(before).toEqual({ d: 3, a: 3, r: 1, calls: 1 });
    const again = await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    const sweep = await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: [] });
    expect(again.status).toBe("idle");
    expect(sweep.status).toBe("idle");
    expect({ d: (await modelDecisionsOf(A)).length, a: (await actionsOf(A)).length, r: (await runsOf(A)).length, calls: fakeCalls.length }).toEqual(before);
  });

  it("a retry of the same pg-boss job finds its run row and does not file twice", async () => {
    const ids = await threeCharges();
    const id = randomUUID();
    await handleCategorizeJobs([job({ householdId: A, ownerUserId: OWNER, txnIds: ids }, id)]);
    await handleCategorizeJobs([job({ householdId: A, ownerUserId: OWNER, txnIds: ids }, id)]);
    expect(await runsOf(A)).toHaveLength(1);
    expect(await actionsOf(A)).toHaveLength(3);
  });

  it("writes no merchant text anywhere in the trail, and nothing but ids and figures in actions", async () => {
    const ids = await threeCharges();
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    const blob = JSON.stringify([await runsOf(A), await actionsOf(A)]).toUpperCase();
    for (const d of DESCRIPTIONS) expect(blob).not.toContain(d.toUpperCase());
    expect(blob).not.toContain("ZZSECRET");
  });

  it("budget_exceeded ends the run budget_exceeded, files nothing, does not throw (so no retry), and leaves the rows queued", async () => {
    const ids = await threeCharges();
    await db.insert(aiBudgetTable).values({ householdId: A, monthlyCapUsd: "0", hardCapUsd: "0" });
    const r = await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    expect(r).toMatchObject({ status: "budget_exceeded", filed: 0, waiting: 3 });
    const [run] = await runsOf(A);
    expect(run).toMatchObject({ status: "budget_exceeded", error: "budget_exceeded" });
    expect(run!.summary).toMatch(/budget is used up\. 3 charges waiting for you/);
    expect(fakeCalls).toHaveLength(0);
    expect(await modelDecisionsOf(A)).toHaveLength(0);
    for (const id of ids) expect((await txnRow(id)).categoryId).toBeNull();
    expect((await db.select().from(aiUsageTable).where(eq(aiUsageTable.householdId, A)))[0]).toMatchObject({ status: "budget_exceeded" });
    await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, A));
  });

  it("a provider outage ends the run failed and throws so pg-boss retries; the retry reuses the run row", async () => {
    const ids = await threeCharges();
    const id = randomUUID();
    queueFakeSteps("categorize", { kind: "throw", error: new Anthropic.APIConnectionError({ message: "network down" }) });
    await expect(handleCategorizeJobs([job({ householdId: A, ownerUserId: OWNER, txnIds: ids }, id)])).rejects.toThrow(/connection/);
    const [failed] = await runsOf(A);
    expect(failed).toMatchObject({ status: "failed" });
    expect(await modelDecisionsOf(A)).toHaveLength(0);
    // the retry: the provider answers
    const retry = await handleCategorizeJobs([job({ householdId: A, ownerUserId: OWNER, txnIds: ids }, id)]);
    expect(retry[0]).toMatchObject({ status: "succeeded", filed: 2 });
    const runs = await runsOf(A);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", id: failed!.id });
  });

  it("a non-retryable failure (a refusal) ends the run refused without throwing", async () => {
    const ids = await threeCharges();
    queueFakeSteps("categorize", { kind: "refusal" });
    const r = await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    expect(r.status).toBe("refused");
    expect((await runsOf(A))[0]).toMatchObject({ status: "refused" });
    expect(await modelDecisionsOf(A)).toHaveLength(0);
  });

  it("autoCategorize=false skips the model entirely; the deterministic stages still file by a rule", async () => {
    await setPrefs(A, OWNER, { autoCategorize: false });
    const ruled = await addTxn(A, OWNER, { description: "TRADER JOES 12" });
    const other = await addTxn(A, OWNER, { description: "GREEN GROCER 5" });
    await db.insert(mappingRulesTable).values({ userId: OWNER, householdId: A, pattern: "TRADER JOES", matchType: "contains", categoryId: C.Groceries, priority: 0 });
    registerFakeFixture("categorize", fixtureBy([], { cat: C.Dining, confidence: "high" }));
    const r = await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: [ruled, other] });
    expect(r).toMatchObject({ status: "skipped", reason: "autoCategorize is off" });
    expect(fakeCalls).toHaveLength(0);
    expect(await runsOf(A)).toHaveLength(0);
    expect((await txnRow(ruled)).categoryId).toBe(C.Groceries); // rule stage ran
    expect((await txnRow(other)).categoryId).toBeNull(); // model did not
  });

  it("with AI off the model is skipped (and no run is opened)", async () => {
    const t = await addTxn(A, OWNER, { description: "GREEN GROCER 6" });
    process.env.AI_ENABLED = "false";
    try {
      const r = await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: [t] });
      expect(r).toMatchObject({ status: "skipped", reason: "AI is off" });
      expect(await runsOf(A)).toHaveLength(0);
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });

  it("an opened gate (preference + 50 accepted) makes high answers auto: applied, written, not provisional", async () => {
    await setPrefs(A, OWNER, { modelAutoCategorize: true });
    for (let i = 0; i < 50; i++) {
      const old = await addTxn(A, OWNER, { categoryId: C.Groceries, description: `OLD ${i}` });
      await db.insert(categoryDecisionsTable).values({
        householdId: A, transactionId: old, source: "model", categoryId: C.Groceries, confidence: "0.850", band: "provisional",
        explanation: "x", inputHash: randomUUID(), resolution: "accepted", resolvedBy: OWNER, resolvedAt: new Date(),
      });
    }
    const t = await addTxn(A, OWNER, { description: "GREEN GROCER 8" });
    registerFakeFixture("categorize", fixtureBy([["GREEN GROCER", { cat: C.Groceries, confidence: "high" }]]));
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: [t] });
    const [action] = await db.select().from(agentActionsTable).where(eq(agentActionsTable.targetId, t));
    expect(action).toMatchObject({ outcome: "applied", reversible: true });
    expect(await txnRow(t)).toMatchObject({ categoryId: C.Groceries, categoryProvisional: false });
  });

  it("household isolation: household B's job never touches household A's rows, and a payload cannot name another owner", async () => {
    const mine = await addTxn(A, OWNER, { description: "GREEN GROCER 9" });
    const theirs = await addTxn(B, OTHER, { description: "GREEN GROCER 9" });
    registerFakeFixture("categorize", fixtureBy([], { cat: C.Groceries, confidence: "medium" })); // A's category id: not B's
    await runCategorizeJob({ householdId: B, ownerUserId: OWNER, txnIds: [mine, theirs] });
    expect((await txnRow(mine)).categoryId).toBeNull();
    expect(await modelDecisionsOf(A)).toHaveLength(0);
    expect(await runsOf(A)).toHaveLength(0);
    // B's own category set differs from A's, so A's id is not in B's enum: nothing is written for B either
    expect((await txnRow(theirs)).categoryId).toBeNull();
    expect(await runCategorizeJob({ householdId: randomUUID(), ownerUserId: OWNER, txnIds: [mine] })).toMatchObject({ status: "skipped" });
  });
});

describe("txn.arrived", () => {
  it("fans out to categorize.batch (only with ambiguous ids, throttled per household) and monitor.household", async () => {
    const out = await handleTxnArrived([
      job({ householdId: A, ownerUserId: OWNER, txnIds: ["t1", "t2"], arrived: 9 }),
      job({ householdId: B, ownerUserId: OTHER, txnIds: [], arrived: 3 }),
      job({ ownerUserId: OWNER }),
    ]);
    expect(out).toEqual({ categorize: 1, monitor: 2 });
    const cat = _emittedForTests.filter((e) => e.queue === QUEUES.categorizeBatch);
    expect(cat).toHaveLength(1);
    expect(cat[0]).toMatchObject({
      data: { householdId: A, ownerUserId: OWNER, txnIds: ["t1", "t2"], trigger: "txn_arrived" },
      opts: { singletonKey: `cat:${A}`, singletonSeconds: 60, retryLimit: 3 },
    });
    const mon = _emittedForTests.filter((e) => e.queue === QUEUES.monitorHousehold);
    expect(mon.map((m) => (m.data as any).householdId).sort()).toEqual([A, B].sort());
    expect(mon[0]!.data).toMatchObject({ trigger: "txn_arrived" });
  });
});

describe("POST /categorization/run", () => {
  it("also enqueues the model pass for every unresolved row (trigger user), and reports how many", async () => {
    const t = await addTxn(A, OWNER, { description: "NOBODY KNOWS THIS SHOP" });
    const res = await call("POST", "/categorization/run", OWNER, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ambiguous: 1, modelQueued: 1 });
    const e = _emittedForTests.find((x) => x.queue === QUEUES.categorizeBatch)!;
    expect(e.data).toMatchObject({ householdId: A, ownerUserId: OWNER, txnIds: [t], trigger: "user" });
    expect(e.opts).toMatchObject({ singletonKey: `cat:${A}` });
  });

  it("queues nothing when AI is off", async () => {
    await addTxn(A, OWNER, { description: "NOBODY KNOWS THIS SHOP 2" });
    process.env.AI_ENABLED = "false";
    try {
      const res = await call("POST", "/categorization/run", OWNER, {});
      expect(res.json.modelQueued).toBe(0);
      expect(_emittedForTests.filter((x) => x.queue === QUEUES.categorizeBatch)).toHaveLength(0);
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });
});

describe("POST /agent/actions/:id/undo for set_category", () => {
  it("round trip: the category returns, the decision is undone, the action is stamped; a second try is 409; another household is 404", async () => {
    const ids = await threeCharges();
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    const [action] = await db.select().from(agentActionsTable).where(eq(agentActionsTable.targetId, ids[0]!));
    expect(await txnRow(ids[0]!)).toMatchObject({ categoryId: C.Groceries, categoryProvisional: true });

    expect((await call("POST", `/agent/actions/${action!.id}/undo`, OTHER)).status).toBe(404);
    const ok = await call("POST", `/agent/actions/${action!.id}/undo`);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: action!.id, type: "set_category" });
    expect(ok.json.undoneAt).toBeTruthy();

    expect(await txnRow(ids[0]!)).toMatchObject({ categoryId: null, categoryProvisional: false });
    const [dec] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, (action!.after as any).decisionId));
    expect(dec!.undoneAt).not.toBeNull();
    const [stamped] = await db.select().from(agentActionsTable).where(eq(agentActionsTable.id, action!.id));
    expect(stamped).toMatchObject({ undoneBy: OWNER });
    expect(stamped!.undoneAt).not.toBeNull();
    expect((await call("POST", `/agent/actions/${action!.id}/undo`)).status).toBe(409);

    // the engine does not redo it: the undone decision is history, the model is not asked again
    const callsBefore = fakeCalls.length;
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: [ids[0]!] });
    expect(fakeCalls.length).toBe(callsBefore);
  });

  it("409 when the charge was changed by a person since; the action is not stamped", async () => {
    const ids = await threeCharges();
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    const [action] = await db.select().from(agentActionsTable).where(eq(agentActionsTable.targetId, ids[0]!));
    await db.update(transactionsTable).set({ categoryId: C.Dining }).where(eq(transactionsTable.id, ids[0]!));
    const res = await call("POST", `/agent/actions/${action!.id}/undo`);
    expect(res.status).toBe(409);
    expect((await db.select().from(agentActionsTable).where(eq(agentActionsTable.id, action!.id)))[0]!.undoneAt).toBeNull();
    expect((await txnRow(ids[0]!)).categoryId).toBe(C.Dining);
  });

  it("undoing a queued suggestion (nothing was written) stamps it and leaves the row alone", async () => {
    const ids = await threeCharges();
    await runCategorizeJob({ householdId: A, ownerUserId: OWNER, txnIds: ids });
    const [action] = await db.select().from(agentActionsTable).where(eq(agentActionsTable.targetId, ids[2]!));
    expect((await call("POST", `/agent/actions/${action!.id}/undo`)).status).toBe(200);
    expect((await txnRow(ids[2]!)).categoryId).toBeNull();
  });
});

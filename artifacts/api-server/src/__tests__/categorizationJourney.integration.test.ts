// (V1) ⭐ The categorization journey, end to end, with counts at every step:
//
//   a sync brings charges → the deterministic stages decide what they can →
//   `txn.arrived` → `categorize.batch` → the job asks the (fake) model about
//   the rest → provisional decisions wait in the review queue → a person
//   corrects them → merchant memory learns → the next charge from that
//   merchant files by memory (auto) → re-sending the same rows changes nothing
//   a person or the engine filed → a pending row that posts keeps its filing →
//   re-running the batch adds no second decision → undo restores the category.
//
// Real Postgres, the real sync with a stubbed Plaid client, JOBS_MODE=off
// (handlers called directly), the fake model provider. Synthetic data only.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Job } from "pg-boss";

type PlaidTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
  pending_transaction_id?: string | null;
};
let nextSync: { added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string }[] } = { added: [], modified: [], removed: [] };

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: { added: nextSync.added, modified: nextSync.modified, removed: nextSync.removed, next_cursor: `c-${randomUUID()}`, has_more: false },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({ data: { item: { item_id: "item-default", consent_expiration_time: null } } }),
    }),
  };
});

import {
  db,
  categoryDecisionsTable,
  mappingRulesTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, householdToday } from "@workspace/avalanche-core";
import { registerFakeFixture, resetFake, fakeCalls } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import { syncPlaidItem } from "../lib/plaidSync";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";
import { handleTxnArrived } from "../jobs/handlers/txnArrived";
import { runCategorizeJob, type CategorizeJobData } from "../jobs/handlers/categorize";
import { runCategorizationBatch } from "../lib/categorizer";
import { evaluateModelGate } from "../lib/categorizer/modelGate";
import { listReviewQueue, resolveDecision, undoDecision } from "../lib/categorizer/review";
import { pinEnv } from "./_helpers/aiEnv";
import { createTestHousehold } from "./_helpers/testHousehold";
import { fixtureBy, seedCategories, wipeHousehold, type Cats } from "./_helpers/aiCategorize";

pinEnv({ AI_ENABLED: "true", AI_PROVIDER: "fake" });

const OWNER = `v1-jr-${process.pid}-${randomUUID().slice(0, 8)}`;
// Plaid transaction ids are unique across the table: suffix them per run.
const RUN = randomUUID().slice(0, 8);
const pid = (id: string) => `${id}-${RUN}`;
let HH = "";
let C: Cats;
let ITEM = "";
let ACCT = "";
const day = (n: number) => addDaysISO(householdToday(new Date()), -n);

const rowsByPtid = async () => {
  const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.householdId, HH));
  return new Map(rows.map((r) => [r.plaidTransactionId!.replace(`-${RUN}`, ""), r]));
};
const decisions = () => db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, HH));
const bySource = async () => {
  const out: Record<string, number> = {};
  for (const d of await decisions()) out[d.source] = (out[d.source] ?? 0) + 1;
  return out;
};
const memories = () => db.select().from(merchantMemoryTable).where(and(eq(merchantMemoryTable.householdId, HH), isNull(merchantMemoryTable.disabledAt)));
const filing = (r: { categoryId: string | null; categoryLockedByUser: boolean; categoryProvisional: boolean }) => ({
  categoryId: r.categoryId,
  categoryLockedByUser: r.categoryLockedByUser,
  categoryProvisional: r.categoryProvisional,
});
const txn = (id: string, name: string, amount: number, daysAgo: number, o: Partial<PlaidTxn> = {}): PlaidTxn => ({
  transaction_id: pid(id),
  account_id: ACCT,
  date: day(daysAgo),
  amount,
  name,
  pending: false,
  ...o,
  ...(o.pending_transaction_id ? { pending_transaction_id: pid(o.pending_transaction_id) } : {}),
});
async function sync(next: typeof nextSync) {
  nextSync = next;
  _emittedForTests.length = 0;
  await syncPlaidItem(OWNER, ITEM);
  return _emittedForTests.filter((e) => e.queue === QUEUES.txnArrived).map((e) => e.data as { householdId: string; ownerUserId: string; txnIds: string[]; arrived: number });
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  await wipeHousehold(HH);
  C = await seedCategories(HH, OWNER);
  await db.insert(mappingRulesTable).values({ userId: OWNER, householdId: HH, pattern: "FLINT TOOLS", matchType: "contains", categoryId: C.Dining, priority: 0 });
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: OWNER, householdId: HH, itemId: `item-${randomUUID()}`, accessToken: `access-sandbox-${randomUUID()}`, institutionName: "Chase", institutionSlug: "chase" })
    .returning();
  ITEM = item!.id;
  ACCT = `acct-${randomUUID()}`;
  await db.insert(plaidAccountsTable).values({
    userId: OWNER, householdId: HH, itemId: ITEM, accountId: ACCT, name: "Checking", type: "depository", subtype: "checking",
    firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
  });
  resetFake();
  invalidateTaskConfigCache();
});
afterAll(async () => {
  await wipeHousehold(HH);
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
});

describe("the categorization journey", () => {
  it("sync → engine → model → queue → correction → memory → stable re-syncs → no duplicates → undo", async () => {
    // ── 1. A sync brings four charges: one a rule knows, three nobody knows (one pending).
    const arrived = await sync({
      added: [
        txn("FLINT-1", "FLINT TOOLS 12", 31, 5),
        txn("MOSS-1", "MOSS CAFE", 4.5, 6),
        txn("MOSS-2", "MOSS CAFE", 5.25, 4),
        txn("MOSS-P", "MOSS CAFE", 6, 1, { pending: true }),
      ],
      modified: [],
      removed: [],
    });
    let rows = await rowsByPtid();
    expect(rows.size).toBe(4);
    expect(await bySource()).toEqual({ rule: 1 });
    expect(rows.get("FLINT-1")).toMatchObject({ categoryId: C.Dining, categoryProvisional: false, categoryLockedByUser: false });
    const moss = ["MOSS-1", "MOSS-2", "MOSS-P"].map((p) => rows.get(p)!.id);
    expect(arrived).toHaveLength(1);
    expect(arrived[0]).toMatchObject({ householdId: HH, ownerUserId: OWNER, arrived: 4 });
    expect([...arrived[0]!.txnIds].sort()).toEqual([...moss].sort());

    // ── 2. txn.arrived → categorize.batch → the job asks the model about the three.
    _emittedForTests.length = 0;
    await handleTxnArrived([{ id: randomUUID(), data: arrived[0] } as unknown as Job<object>]);
    const batch = _emittedForTests.filter((e) => e.queue === QUEUES.categorizeBatch);
    expect(batch).toHaveLength(1);
    registerFakeFixture("categorize", fixtureBy([["MOSS CAFE", { cat: C.Groceries, confidence: "medium", rationale: "Looks like groceries." }]]));
    const out = await runCategorizeJob(batch[0]!.data as CategorizeJobData, { jobId: randomUUID() });
    expect(out).toMatchObject({ status: "succeeded", filed: 3, actions: 3 });
    expect(fakeCalls).toHaveLength(1);
    expect(await bySource()).toEqual({ rule: 1, model: 3 });
    rows = await rowsByPtid();
    for (const id of moss) {
      const r = [...rows.values()].find((x) => x.id === id)!;
      expect(filing(r)).toEqual({ categoryId: C.Groceries, categoryLockedByUser: false, categoryProvisional: true });
    }

    // ── 3. The uncertain ones wait in the review queue.
    let queue = await listReviewQueue(HH, 20);
    expect(queue.total).toBe(3);
    expect(queue.items.map((i) => i.transactionId).sort()).toEqual([...moss].sort());
    expect((await evaluateModelGate(HH, OWNER)).judged).toBe(0);

    // ── 4. A person corrects each one to Coffee; memory learns, one confirmation at a time.
    for (const [n, item] of queue.items.entries()) {
      const res = await resolveDecision(HH, OWNER, item.decisionId, "correct", C.Coffee);
      expect(res.status).toBe(200);
      const mem = await memories();
      expect(mem).toHaveLength(1);
      expect(mem[0]).toMatchObject({ categoryId: C.Coffee, count: n + 1 });
    }
    queue = await listReviewQueue(HH, 20);
    expect(queue.total).toBe(0);
    expect(await bySource()).toEqual({ rule: 1, model: 3, user: 3 });
    const resolved = (await decisions()).filter((d) => d.source === "model");
    expect(resolved.every((d) => d.resolution === "corrected" && d.resolvedVia === "user")).toBe(true);
    expect(await evaluateModelGate(HH, OWNER)).toMatchObject({ judged: 3, accurateOfLast50: 0, eligible: false });
    rows = await rowsByPtid();
    for (const p of ["MOSS-1", "MOSS-2", "MOSS-P"]) {
      expect(filing(rows.get(p)!)).toEqual({ categoryId: C.Coffee, categoryLockedByUser: true, categoryProvisional: false });
    }

    // ── 5. The next charge from that merchant files by memory, outright (auto band).
    const arrived2 = await sync({ added: [txn("MOSS-3", "MOSS CAFE", 4.75, 0)], modified: [], removed: [] });
    rows = await rowsByPtid();
    expect(rows.size).toBe(5);
    const moss3 = rows.get("MOSS-3")!;
    expect(filing(moss3)).toEqual({ categoryId: C.Coffee, categoryLockedByUser: false, categoryProvisional: false });
    const memDecision = (await decisions()).find((d) => d.transactionId === moss3.id)!;
    expect(memDecision).toMatchObject({ source: "memory", band: "auto", categoryId: C.Coffee });
    expect(await bySource()).toEqual({ rule: 1, model: 3, user: 3, memory: 1 });
    expect(arrived2.flatMap((a) => a.txnIds)).toEqual([]);

    // ── 6. Plaid re-sends the same rows: no filing moves, no decision is added.
    const before = new Map([...rows].map(([k, r]) => [k, filing(r)]));
    const decisionsBefore = (await decisions()).length;
    await sync({
      added: [],
      modified: [
        txn("FLINT-1", "FLINT TOOLS 12", 31, 5),
        txn("MOSS-1", "MOSS CAFE", 4.5, 6),
        txn("MOSS-2", "MOSS CAFE", 5.25, 4),
        txn("MOSS-P", "MOSS CAFE", 6, 1, { pending: true }),
        txn("MOSS-3", "MOSS CAFE", 4.75, 0),
      ],
      removed: [],
    });
    rows = await rowsByPtid();
    expect(rows.size).toBe(5);
    for (const [k, r] of rows) expect(filing(r)).toEqual(before.get(k));
    expect((await decisions()).length).toBe(decisionsBefore);

    // ── 7. The pending charge posts under a new id with a new amount: it keeps the person's filing.
    const pendingRowId = rows.get("MOSS-P")!.id;
    await sync({
      added: [txn("MOSS-POSTED", "MOSS CAFE", 7.1, 0, { pending_transaction_id: "MOSS-P" })],
      modified: [],
      removed: [{ transaction_id: pid("MOSS-P") }],
    });
    rows = await rowsByPtid();
    expect(rows.size).toBe(5);
    expect(rows.has("MOSS-P")).toBe(false);
    const posted = rows.get("MOSS-POSTED")!;
    expect(posted.id).toBe(pendingRowId);
    expect(posted).toMatchObject({ pending: false, amount: "-7.10" });
    expect(filing(posted)).toEqual({ categoryId: C.Coffee, categoryLockedByUser: true, categoryProvisional: false });
    expect((await decisions()).length).toBe(decisionsBefore);

    // ── 8. Running the batch again — engine and job — adds no second decision.
    const allIds = [...rows.values()].map((r) => r.id);
    await runCategorizationBatch(HH, { txnIds: allIds, trigger: "job" });
    await runCategorizeJob({ householdId: HH, ownerUserId: OWNER, txnIds: allIds, trigger: "user" }, { jobId: randomUUID() });
    const after = await decisions();
    expect(after.length).toBe(decisionsBefore);
    expect(new Set(after.map((d) => `${d.transactionId}|${d.inputHash}`)).size).toBe(after.length);
    expect(fakeCalls).toHaveLength(1);

    // ── 9. Undo restores the previous category: the memory filing goes back to none…
    const undoMem = await undoDecision(HH, memDecision.id);
    expect(undoMem).toMatchObject({ status: 200, body: { categoryId: null } });
    expect(filing((await rowsByPtid()).get("MOSS-3")!)).toEqual({ categoryId: null, categoryLockedByUser: false, categoryProvisional: false });
    // …and undoing a person's correction puts back the suggestion it replaced, unlocked.
    const moss2 = rows.get("MOSS-2")!.id;
    const [correction] = await db
      .select()
      .from(categoryDecisionsTable)
      .where(and(eq(categoryDecisionsTable.transactionId, moss2), eq(categoryDecisionsTable.source, "user")));
    const undoUser = await undoDecision(HH, correction!.id);
    expect(undoUser).toMatchObject({ status: 200, body: { categoryId: C.Groceries } });
    expect(filing((await rowsByPtid()).get("MOSS-2")!)).toEqual({ categoryId: C.Groceries, categoryLockedByUser: false, categoryProvisional: false });
    const undone = await db.select().from(categoryDecisionsTable).where(and(eq(categoryDecisionsTable.householdId, HH), inArray(categoryDecisionsTable.id, [memDecision.id, correction!.id])));
    expect(undone.every((d) => d.undoneAt != null)).toBe(true);
    expect(await bySource()).toEqual({ rule: 1, model: 3, user: 3, memory: 1 });
  });
});

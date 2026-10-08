// (V1) Eligibility v2 and silent acceptance, against the real test Postgres.
// Every rule in modelGate.ts / settleSilentAcceptances has a case here.
// Synthetic data only; no model calls (AI_PROVIDER=fake, and the job cases
// below never reach the model stage).
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";

vi.mock("../monitor/run", () => ({ runMonitor: vi.fn(async () => ({})) }));

import { db, categoryDecisionsTable, merchantMemoryTable, transactionsTable } from "@workspace/db";
import {
  MODEL_AUTO_ACCURACY_WINDOW,
  MODEL_AUTO_FLOOR_RATE,
  MODEL_AUTO_FLOOR_WINDOW,
  MODEL_AUTO_MIN_ACCEPT_RATE,
  MODEL_AUTO_MIN_JUDGED,
  evaluateModelGate,
  loadModelGate,
  modeFor,
  neededRight,
  replayGate,
} from "../lib/categorizer/modelGate";
import { SILENT_ACCEPT_DAYS, openReviewCount, settleSilentAcceptances } from "../lib/categorizer/review";
import { runCategorizeJob } from "../jobs/handlers/categorize";
import { handleMonitorJobs } from "../jobs/handlers/monitor";
import { runMonitor } from "../monitor/run";
import { pinEnv } from "./_helpers/aiEnv";
import { createTestHousehold } from "./_helpers/testHousehold";
import { addTxn, seedCategories, setPrefs, wipeHousehold, type Cats } from "./_helpers/aiCategorize";

pinEnv({ AI_ENABLED: "true", AI_PROVIDER: "fake" });

const OWNER = `v1-el-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `v1-el-o-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";
let HH_OTHER = "";
let C: Cats;

const T = true;
const F = false;
const rep = (v: boolean, n: number) => Array<boolean>(n).fill(v);
const cycle = (pattern: boolean[], times: number) => Array.from({ length: times }, () => pattern).flat();
const DAY = 86_400_000;
const NOW = new Date("2026-10-08T12:00:00Z");

/** Judged model decisions, oldest first, one minute apart, ending an hour before NOW. */
async function seedJudged(
  householdId: string,
  owner: string,
  record: boolean[],
  o: { source?: string; undone?: boolean; resolution?: "skipped"; resolvedAt?: Date } = {},
) {
  if (record.length === 0) return;
  const cat = C.Groceries;
  const txns = await db
    .insert(transactionsTable)
    .values(record.map((_, i) => ({ userId: owner, householdId, occurredOn: "2026-09-01", description: `V1 JUDGED ${i}`, amount: "-5.00", source: "plaid:bank", categoryId: cat })))
    .returning({ id: transactionsTable.id });
  const start = NOW.getTime() - 3_600_000 - record.length * 60_000;
  await db.insert(categoryDecisionsTable).values(
    record.map((ok, i) => ({
      householdId,
      transactionId: txns[i]!.id,
      source: o.source ?? "model",
      categoryId: cat,
      confidence: "0.850",
      band: "provisional",
      explanation: "x",
      inputHash: randomUUID(),
      resolution: o.resolution ?? (ok ? "accepted" : "corrected"),
      resolvedBy: owner,
      resolvedVia: "user",
      resolvedAt: o.resolvedAt ?? new Date(start + i * 60_000),
      createdAt: new Date(start + i * 60_000 - DAY),
      ...(o.undone ? { undoneAt: NOW } : {}),
    })),
  );
}

/** One open provisional model suggestion on a row that carries it. */
async function openSuggestion(o: { ageMs: number; locked?: boolean; rowCategory?: string | null; band?: string; source?: string; householdId?: string; owner?: string }) {
  const hh = o.householdId ?? HH;
  const owner = o.owner ?? OWNER;
  const txn = await addTxn(hh, owner, {
    categoryId: o.rowCategory === undefined ? C.Groceries : o.rowCategory,
    categoryProvisional: true,
    categoryLockedByUser: !!o.locked,
  });
  const [d] = await db
    .insert(categoryDecisionsTable)
    .values({
      householdId: hh,
      transactionId: txn,
      source: o.source ?? "model",
      categoryId: C.Groceries,
      confidence: "0.850",
      band: o.band ?? "provisional",
      explanation: "Suggested.",
      inputHash: randomUUID(),
      createdAt: new Date(NOW.getTime() - o.ageMs),
    })
    .returning();
  return { txn, decisionId: d!.id };
}
const decision = async (id: string) => (await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, id)))[0]!;
const txnRow = async (id: string) => (await db.select().from(transactionsTable).where(eq(transactionsTable.id, id)))[0]!;

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  C = await seedCategories(HH, OWNER);
});
beforeEach(async () => {
  await wipeHousehold(HH);
  await wipeHousehold(HH_OTHER);
  await setPrefs(HH, OWNER, null);
  vi.mocked(runMonitor).mockClear();
});

describe("the constants", () => {
  it("are the owner's numbers", () => {
    expect(MODEL_AUTO_MIN_JUDGED).toBe(30);
    expect(MODEL_AUTO_MIN_ACCEPT_RATE).toBe(0.9);
    expect(MODEL_AUTO_FLOOR_RATE).toBe(0.8);
    expect(MODEL_AUTO_ACCURACY_WINDOW).toBe(50);
    expect(MODEL_AUTO_FLOOR_WINDOW).toBe(20);
    expect(SILENT_ACCEPT_DAYS).toBe(14);
    expect([neededRight(50, 0.9), neededRight(20, 0.9), neededRight(20, 0.8), neededRight(30, 0.9)]).toEqual([45, 18, 16, 27]);
  });
});

describe("replayGate: the eligibility table", () => {
  it("warm-up: 29 judged (all right) is not eligible; 30 is", () => {
    expect(replayGate(rep(T, 29))).toMatchObject({ judged: 29, eligible: false });
    expect(replayGate(rep(T, 30))).toMatchObject({ judged: 30, eligible: true, accurateOfLast50: 30, last50: 30 });
  });

  it("accuracy: 44 right of the last 50 never opens; 45 of 50 opens", () => {
    const at44 = replayGate([...rep(F, 6), ...rep(T, 44)]);
    expect(at44).toMatchObject({ judged: 50, accurateOfLast50: 44, last50: 50, eligible: false });
    const at45 = replayGate([...rep(F, 5), ...rep(T, 45)]);
    expect(at45).toMatchObject({ judged: 50, accurateOfLast50: 45, last50: 50, eligible: true });
  });

  it("the window is the LAST 50: old mistakes age out", () => {
    // 10 early mistakes, then 50 right: the last 50 are all right.
    expect(replayGate([...rep(F, 10), ...rep(T, 50)])).toMatchObject({ judged: 60, accurateOfLast50: 50, eligible: true });
  });

  it("floor: once open, 16 of the last 20 holds; 15 of 20 closes", () => {
    expect(replayGate([...rep(T, 50), ...rep(F, 4)])).toMatchObject({ accurateOfLast20: 16, eligible: true, heldByFloor: false });
    expect(replayGate([...rep(T, 50), ...rep(F, 5)])).toMatchObject({ accurateOfLast20: 15, eligible: false, heldByFloor: true });
  });

  it("closed by the floor it reopens only at 18 of 20 (17 of 20 stays closed)", () => {
    const slip = [...rep(T, 50), ...rep(F, 5)];
    expect(replayGate([...slip, ...rep(T, 16)])).toMatchObject({ accurateOfLast20: 16, eligible: false, heldByFloor: true });
    expect(replayGate([...slip, ...rep(T, 17)])).toMatchObject({ accurateOfLast20: 17, eligible: false, heldByFloor: true });
    expect(replayGate([...slip, ...rep(T, 18)])).toMatchObject({ accurateOfLast20: 18, accurateOfLast50: 45, eligible: true, heldByFloor: false });
  });

  it("hysteresis: an open record holds at 8 in 10 even when the last 50 fall below 9 in 10; a closed one never opens there", () => {
    const oneInFive = [F, T, T, T, T];
    const opened = replayGate([...rep(T, 30), ...cycle(oneInFive, 10)]);
    expect(opened).toMatchObject({ judged: 80, accurateOfLast50: 40, accurateOfLast20: 16, eligible: true });
    const never = replayGate(cycle(oneInFive, 16));
    expect(never).toMatchObject({ judged: 80, accurateOfLast50: 40, accurateOfLast20: 16, eligible: false, heldByFloor: false });
  });

  it("modes: off without AI or with autoCategorize false; suggest until both the owner's switch and the record; auto with both", () => {
    const base = { autoCategorize: true, modelAutoCategorize: true, aiEnabled: true, eligible: true };
    expect(modeFor(base)).toBe("auto");
    expect(modeFor({ ...base, aiEnabled: false })).toBe("off");
    expect(modeFor({ ...base, autoCategorize: false })).toBe("off");
    expect(modeFor({ ...base, modelAutoCategorize: false })).toBe("suggest");
    expect(modeFor({ ...base, eligible: false })).toBe("suggest");
  });
});

describe("evaluateModelGate (the rows)", () => {
  it("counts only this household's live model decisions accepted or corrected by `now`", async () => {
    await seedJudged(HH, OWNER, rep(T, 29));
    await seedJudged(HH, OWNER, rep(T, 5), { undone: true });
    await seedJudged(HH, OWNER, rep(T, 5), { resolution: "skipped" });
    await seedJudged(HH, OWNER, rep(T, 5), { source: "memory" });
    await seedJudged(HH, OWNER, rep(T, 5), { resolvedAt: new Date(NOW.getTime() + DAY) });
    {
      // Another household's judgment never counts here.
      const other = await seedCategories(HH_OTHER, OTHER);
      const t = await addTxn(HH_OTHER, OTHER, { categoryId: other.Groceries });
      await db.insert(categoryDecisionsTable).values({
        householdId: HH_OTHER, transactionId: t, source: "model", categoryId: other.Groceries, confidence: "0.850", band: "provisional",
        explanation: "x", inputHash: randomUUID(), resolution: "accepted", resolvedBy: OTHER, resolvedVia: "user", resolvedAt: new Date(NOW.getTime() - DAY),
      });
    }
    await setPrefs(HH, OWNER, { modelAutoCategorize: true });
    const g = await evaluateModelGate(HH, OWNER, NOW);
    expect(g).toMatchObject({ judged: 29, eligible: false, mode: "suggest", autoCategorize: true, modelAutoCategorize: true, aiEnabled: true, aiConfigured: true });
    await seedJudged(HH, OWNER, rep(T, 1));
    expect(await evaluateModelGate(HH, OWNER, NOW)).toMatchObject({ judged: 30, eligible: true, mode: "auto" });
  });

  it("lists the four requirements in order, plain sentences with counts, and a fifth only while the floor holds it closed", async () => {
    await seedJudged(HH, OWNER, rep(T, 12));
    const g = await evaluateModelGate(HH, OWNER, NOW);
    expect(g.requirements).toEqual([
      { key: "ai", label: "AI is turned on for this app.", met: true, current: 1, target: 1 },
      { key: "owner_switch", label: "The owner lets sure answers file on their own.", met: false, current: 0, target: 1 },
      { key: "judged", label: "At least 30 suggestions you verified in Review.", met: false, current: 12, target: 30 },
      { key: "accuracy", label: "9 in 10 right among the last 50 you verified.", met: true, current: 12, target: 11 },
    ]);
    await wipeHousehold(HH);
    await seedJudged(HH, OWNER, [...rep(T, 50), ...rep(F, 5), ...rep(T, 17)]);
    const held = await evaluateModelGate(HH, OWNER, NOW);
    expect(held.eligible).toBe(false);
    expect(held.requirements.map((r) => r.key)).toEqual(["ai", "owner_switch", "judged", "accuracy", "floor"]);
    expect(held.requirements[4]).toMatchObject({ met: false, current: 17, target: 18 });
    await seedJudged(HH, OWNER, rep(T, 1));
    const reopened = await evaluateModelGate(HH, OWNER, NOW);
    expect(reopened.eligible).toBe(true);
    expect(reopened.requirements).toHaveLength(4);
  });

  it("while hysteresis holds it open with the last 50 below 9 in 10, a 'holding' row explains it", async () => {
    await seedJudged(HH, OWNER, [...rep(T, 30), ...cycle([F, T, T, T, T], 10)]);
    const g = await evaluateModelGate(HH, OWNER, NOW);
    expect(g.eligible).toBe(true);
    expect(g.requirements.map((r) => r.key)).toEqual(["ai", "owner_switch", "judged", "accuracy", "holding"]);
    expect(g.requirements[3]).toMatchObject({ met: false, current: 40, target: 45 });
    expect(g.requirements[4]).toEqual({ key: "holding", label: "Holding: the last 20 are at least 8 in 10.", met: true, current: 16, target: 16 });
    // Not shown when the last 50 meet the bar on their own.
    await wipeHousehold(HH);
    await seedJudged(HH, OWNER, rep(T, 30));
    expect((await evaluateModelGate(HH, OWNER, NOW)).requirements.map((r) => r.key)).toEqual(["ai", "owner_switch", "judged", "accuracy"]);
  });

  it("mode follows the AI switch and the owner's preferences; loadModelGate is its projection", async () => {
    await seedJudged(HH, OWNER, rep(T, 30));
    expect((await evaluateModelGate(HH, OWNER, NOW)).mode).toBe("suggest");
    await setPrefs(HH, OWNER, { modelAutoCategorize: true });
    expect((await evaluateModelGate(HH, OWNER, NOW)).mode).toBe("auto");
    expect(await loadModelGate(HH, OWNER, NOW)).toEqual({ autoCategorize: true, modelAutoCategorize: true, accepted: 30, corrected: 0, autoAllowed: true });
    await setPrefs(HH, OWNER, { modelAutoCategorize: true, autoCategorize: false });
    expect((await evaluateModelGate(HH, OWNER, NOW)).mode).toBe("off");
    expect((await loadModelGate(HH, OWNER, NOW)).autoAllowed).toBe(false);
    await setPrefs(HH, OWNER, { modelAutoCategorize: true });
    process.env.AI_ENABLED = "false";
    try {
      const g = await evaluateModelGate(HH, OWNER, NOW);
      expect(g).toMatchObject({ mode: "off", aiEnabled: false, eligible: true });
      expect(g.requirements[0]).toMatchObject({ key: "ai", met: false, current: 0 });
      expect((await loadModelGate(HH, OWNER, NOW)).autoAllowed).toBe(false);
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });
});

describe("left unchanged 14 days (silent → unreviewed, V7)", () => {
  it("settles a provisional model suggestion standing for 14 days — not one a minute younger", async () => {
    const due = await openSuggestion({ ageMs: SILENT_ACCEPT_DAYS * DAY });
    const young = await openSuggestion({ ageMs: SILENT_ACCEPT_DAYS * DAY - 60_000 });
    expect(await openReviewCount(HH)).toBe(2);
    expect(await settleSilentAcceptances(HH, NOW)).toBe(1);
    expect(await decision(due.decisionId)).toMatchObject({ resolution: "unreviewed", resolvedVia: "silent", resolvedAt: NOW, undoneAt: null });
    expect(await decision(young.decisionId)).toMatchObject({ resolution: null, resolvedAt: null, resolvedVia: null });
    expect(await openReviewCount(HH)).toBe(1);
    // (V7) The settled row STAYS provisional (nobody verified it); it keeps its category and stays unlocked; no memory is learned.
    expect(await txnRow(due.txn)).toMatchObject({ categoryId: C.Groceries, categoryProvisional: true, categoryLockedByUser: false });
    expect(await txnRow(young.txn)).toMatchObject({ categoryId: C.Groceries, categoryProvisional: true });
    expect(await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, HH))).toHaveLength(0);
    // (V7) And it is not verified: the record does not count it.
    expect((await evaluateModelGate(HH, OWNER, NOW)).judged).toBe(0);
  });

  it("never settles a locked row, a changed category, a queue-band answer, a non-model decision, or another household's", async () => {
    const old = SILENT_ACCEPT_DAYS * DAY * 2;
    const locked = await openSuggestion({ ageMs: old, locked: true });
    const changed = await openSuggestion({ ageMs: old, rowCategory: C.Dining });
    const cleared = await openSuggestion({ ageMs: old, rowCategory: null });
    const queued = await openSuggestion({ ageMs: old, band: "queue" });
    const memory = await openSuggestion({ ageMs: old, source: "memory" });
    const otherCats = await seedCategories(HH_OTHER, OTHER);
    const theirs = await addTxn(HH_OTHER, OTHER, { categoryId: otherCats.Groceries, categoryProvisional: true });
    const [td] = await db
      .insert(categoryDecisionsTable)
      .values({ householdId: HH_OTHER, transactionId: theirs, source: "model", categoryId: otherCats.Groceries, confidence: "0.850", band: "provisional", explanation: "x", inputHash: randomUUID(), createdAt: new Date(NOW.getTime() - old) })
      .returning();
    expect(await settleSilentAcceptances(HH, NOW)).toBe(0);
    for (const s of [locked, changed, cleared, queued, memory]) {
      expect(await decision(s.decisionId)).toMatchObject({ resolution: null, resolvedVia: null });
    }
    expect(await decision(td!.id)).toMatchObject({ resolution: null });
    // Their rows keep the provisional flag.
    for (const s of [locked, changed, cleared, queued, memory]) expect((await txnRow(s.txn)).categoryProvisional).toBe(true);
  });

  it("is idempotent: a second pass settles nothing and leaves the first stamp", async () => {
    const s = await openSuggestion({ ageMs: SILENT_ACCEPT_DAYS * DAY + 1 });
    expect(await settleSilentAcceptances(HH, NOW)).toBe(1);
    const later = new Date(NOW.getTime() + DAY);
    expect(await settleSilentAcceptances(HH, later)).toBe(0);
    expect((await decision(s.decisionId)).resolvedAt).toEqual(NOW);
  });

  it("runs at the start of the categorize job (even when the model is off)", async () => {
    const s = await openSuggestion({ ageMs: SILENT_ACCEPT_DAYS * DAY });
    process.env.AI_ENABLED = "false";
    try {
      const out = await runCategorizeJob({ householdId: HH, ownerUserId: OWNER, txnIds: [] }, { now: NOW });
      expect(out.status).toBe("skipped");
    } finally {
      process.env.AI_ENABLED = "true";
    }
    expect(await decision(s.decisionId)).toMatchObject({ resolution: "unreviewed", resolvedVia: "silent" });
    // A second job run changes nothing.
    await runCategorizeJob({ householdId: HH, ownerUserId: OWNER, txnIds: [] }, { now: new Date(NOW.getTime() + DAY) });
    expect((await decision(s.decisionId)).resolvedAt).toEqual(NOW);
  });

  it("runs in the nightly monitor.household pass, before the monitor", async () => {
    const s = await openSuggestion({ ageMs: SILENT_ACCEPT_DAYS * DAY + DAY + (Date.now() - NOW.getTime()) });
    const job = { id: randomUUID(), data: { householdId: HH, ownerUserId: OWNER, trigger: "schedule" } } as unknown as Job<object>;
    await expect(handleMonitorJobs([job])).resolves.toEqual({ households: 1, fannedOut: 0 });
    expect(vi.mocked(runMonitor)).toHaveBeenCalledTimes(1);
    const d = await decision(s.decisionId);
    expect(d).toMatchObject({ resolution: "unreviewed", resolvedVia: "silent" });
    const first = d.resolvedAt;
    await handleMonitorJobs([job]);
    expect((await decision(s.decisionId)).resolvedAt).toEqual(first);
    expect(await db.select().from(categoryDecisionsTable).where(and(eq(categoryDecisionsTable.householdId, HH), eq(categoryDecisionsTable.resolvedVia, "silent")))).toHaveLength(1);
  });
});

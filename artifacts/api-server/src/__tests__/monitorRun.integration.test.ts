// (AI-3) runMonitor + the monitor.household job against the real test Postgres:
// runs / actions / findings written, idempotent, cooldown and auto-resolve,
// household isolation, retry by job id, the daily fan-out, and "no raw
// merchant string anywhere". Facts are injected (the loader has its own test);
// all data is synthetic.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

vi.mock("../monitor/facts", () => ({ loadMonitorFacts: vi.fn() }));

import {
  db,
  agentActionsTable,
  agentFindingsTable,
  agentRunsTable,
  plaidItemsTable,
  householdsTable,
} from "@workspace/db";
import { loadMonitorFacts } from "../monitor/facts";
import { runMonitor } from "../monitor/run";
import { REFIRE_AFTER_MS } from "../monitor/store";
import { handleMonitorJobs, monitorSendOptions } from "../jobs/handlers/monitor";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";
import { createTestHousehold } from "./_helpers/testHousehold";
import { calmFacts, calmPosition } from "./_helpers/monitorFacts";
import type { MonitorFacts } from "../monitor/types";

const A_OWNER = `mon-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_OWNER = `mon-b-${process.pid}-${randomUUID().slice(0, 8)}`;
let A: string;
let B: string;

const SECRET_MERCHANT = "zzsecretmerchant";
const ITEM = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();

/** Facts with four findings: shortfall (high), limit_near, bank_stale, duplicate_charge (+ a bill increase). */
function noisyFacts(): MonitorFacts {
  const when = Date.parse("2026-10-06T15:00:00Z");
  return calmFacts({
    position: calmPosition({
      availableUntilPayday: "0.00",
      lowestUntilPayday: "100.00",
      remainingWeek: "20.00",
    }),
    freshness: { stale: true, staleReason: "old", quietHours: 100 },
    recentRows: [
      { id: T1, date: "2026-10-06", whenMs: when, amount: -42, signature: SECRET_MERCHANT },
      { id: T2, date: "2026-10-06", whenMs: when + 3600_000, amount: -42, signature: SECRET_MERCHANT },
    ],
    bills: [
      {
        itemId: ITEM,
        active: true,
        debtLinked: false,
        payments: [
          { date: "2026-10-01", amount: 100, source: "matched", txnId: randomUUID() },
          { date: "2026-09-01", amount: 50, source: "matched", txnId: randomUUID() },
          { date: "2026-08-01", amount: 50, source: "matched", txnId: randomUUID() },
          { date: "2026-07-01", amount: 50, source: "matched", txnId: randomUUID() },
        ],
      },
    ],
  });
}

const counts = async (h: string) => ({
  findings: (await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, h))).length,
  actions: (await db.select().from(agentActionsTable).where(eq(agentActionsTable.householdId, h))).length,
  runs: (await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, h))).length,
});

async function wipe(h: string) {
  await db.delete(agentRunsTable).where(eq(agentRunsTable.householdId, h)); // actions cascade
  await db.delete(agentFindingsTable).where(eq(agentFindingsTable.householdId, h));
}

beforeAll(async () => {
  A = (await createTestHousehold(A_OWNER)).householdId;
  B = (await createTestHousehold(B_OWNER)).householdId;
});

beforeEach(async () => {
  await wipe(A);
  await wipe(B);
  _emittedForTests.length = 0;
  vi.mocked(loadMonitorFacts).mockReset();
  vi.mocked(loadMonitorFacts).mockImplementation(async () => noisyFacts());
});

describe("runMonitor", () => {
  it("writes a run, the findings and one action per new finding", async () => {
    const r = await runMonitor(A, { trigger: "schedule" });
    expect(r).toMatchObject({ status: "succeeded", detected: 5, created: 5, autoResolved: 0, summary: "5 findings, 5 new" });

    const [run] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A));
    expect(run).toMatchObject({ kind: "monitor", trigger: "schedule", status: "succeeded", summary: "5 findings, 5 new" });
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.inputTokens + run!.outputTokens).toBe(0);

    const findings = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, A));
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "bank_stale",
      "bill_increase",
      "duplicate_charge",
      "limit_near",
      "shortfall_before_income",
    ]);

    const actions = await db.select().from(agentActionsTable).where(eq(agentActionsTable.householdId, A));
    expect(actions).toHaveLength(5);
    for (const a of actions) {
      expect(a).toMatchObject({ type: "finding", targetKind: "finding", reversible: false, undoneAt: null, runId: run!.id });
      const f = findings.find((x) => x.id === a.targetId)!;
      expect(a.outcome).toBe(f.severity === "high" ? "needs_attention" : "applied");
    }
    expect(actions.filter((a) => a.outcome === "needs_attention")).toHaveLength(1);
  });

  it("is idempotent: a second run changes no finding and adds no action", async () => {
    await runMonitor(A);
    const before = await counts(A);
    const firstSeen = (await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, A))).map((f) => f.firstSeen.getTime()).sort();
    const r2 = await runMonitor(A, { now: new Date(Date.now() + 60_000) });
    expect(r2).toMatchObject({ detected: 5, created: 0, autoResolved: 0, summary: "5 findings, 0 new" });
    const after = await counts(A);
    expect(after).toEqual({ findings: before.findings, actions: before.actions, runs: before.runs + 1 });
    const rows = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, A));
    expect(rows.map((f) => f.firstSeen.getTime()).sort()).toEqual(firstSeen);
    expect(rows.every((f) => f.lastSeen.getTime() > f.firstSeen.getTime())).toBe(true);
  });

  it("cooldown: a resolved finding stays quiet for 7 days, then re-fires once", async () => {
    await runMonitor(A);
    const [limit] = await db.select().from(agentFindingsTable).where(and(eq(agentFindingsTable.householdId, A), eq(agentFindingsTable.kind, "limit_near")));
    const resolvedAt = new Date();
    await db.update(agentFindingsTable).set({ resolvedAt }).where(eq(agentFindingsTable.id, limit!.id));

    const quiet = await runMonitor(A, { now: new Date(resolvedAt.getTime() + REFIRE_AFTER_MS - 60_000) });
    expect(quiet.created).toBe(0);
    const [still] = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.id, limit!.id));
    expect(still!.resolvedAt).not.toBeNull();

    const late = await runMonitor(A, { now: new Date(resolvedAt.getTime() + REFIRE_AFTER_MS + 60_000) });
    expect(late.created).toBe(1);
    const [again] = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.id, limit!.id));
    expect(again).toMatchObject({ resolvedAt: null, dismissedAt: null });
    expect((await db.select().from(agentActionsTable).where(and(eq(agentActionsTable.householdId, A), eq(agentActionsTable.targetId, limit!.id))))).toHaveLength(2);
  });

  it("a resolved finding re-fires at once when its severity rises", async () => {
    await runMonitor(A);
    const [stale] = await db.select().from(agentFindingsTable).where(and(eq(agentFindingsTable.householdId, A), eq(agentFindingsTable.kind, "bank_stale")));
    // Stored as info + resolved; the detector now says watch.
    await db.update(agentFindingsTable).set({ resolvedAt: new Date(), severity: "info" }).where(eq(agentFindingsTable.id, stale!.id));
    const r = await runMonitor(A);
    expect(r.created).toBe(1);
    const [row] = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.id, stale!.id));
    expect(row).toMatchObject({ severity: "watch", resolvedAt: null });
  });

  it("a dismissed finding is not re-announced while it persists", async () => {
    await runMonitor(A);
    await db.update(agentFindingsTable).set({ dismissedAt: new Date() }).where(eq(agentFindingsTable.householdId, A));
    const r = await runMonitor(A);
    expect(r.created).toBe(0);
    const rows = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, A));
    expect(rows.every((f) => f.dismissedAt !== null && f.resolvedAt === null)).toBe(true);
  });

  it("auto-resolves a finding whose cause cleared, and touches nothing of another household", async () => {
    await runMonitor(A);
    await runMonitor(B);
    vi.mocked(loadMonitorFacts).mockImplementation(async () => calmFacts());
    const r = await runMonitor(A);
    expect(r).toMatchObject({ detected: 0, created: 0, autoResolved: 5, summary: "0 findings, 0 new" });
    const a = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, A));
    expect(a.every((f) => f.resolvedAt !== null)).toBe(true);
    const b = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, B));
    expect(b).toHaveLength(5);
    expect(b.every((f) => f.resolvedAt === null)).toBe(true);
  });

  it("the same facts in two households make two independent sets", async () => {
    await runMonitor(A);
    await runMonitor(B);
    expect((await counts(A)).findings).toBe(5);
    expect((await counts(B)).findings).toBe(5);
    expect((await counts(A)).actions).toBe(5);
  });

  it("a failing read marks the run failed, keeps the error short and rethrows", async () => {
    vi.mocked(loadMonitorFacts).mockRejectedValueOnce(new Error("x".repeat(500)));
    await expect(runMonitor(A)).rejects.toThrow();
    const [run] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A));
    expect(run).toMatchObject({ status: "failed" });
    expect(run!.error!.length).toBeLessThanOrEqual(300);
    expect(await counts(A)).toMatchObject({ findings: 0, actions: 0 });
  });

  it("writes no raw merchant string into a summary, a payload or an action", async () => {
    await runMonitor(A);
    const blob = JSON.stringify([
      await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A)),
      await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, A)),
      await db.select().from(agentActionsTable).where(eq(agentActionsTable.householdId, A)),
    ]);
    expect(blob).not.toContain(SECRET_MERCHANT);
    const [run] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A));
    expect(run!.summary!.length).toBeLessThanOrEqual(300);
  });

  it("an unknown household fails before it writes anything", async () => {
    await expect(runMonitor(randomUUID())).rejects.toThrow(/household not found/);
  });
});

describe("monitor.household job", () => {
  it("runs the household's pass, and a retry of the same job id reuses the finished run", async () => {
    const job = { id: randomUUID(), data: { householdId: A, ownerUserId: A_OWNER, trigger: "txn_arrived" as const } };
    // @ts-expect-error a minimal pg-boss job
    await expect(handleMonitorJobs([job])).resolves.toEqual({ households: 1, fannedOut: 0 });
    const runs = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "txn_arrived", jobId: job.id, status: "succeeded" });

    // @ts-expect-error a minimal pg-boss job
    await handleMonitorJobs([job]);
    expect(await counts(A)).toMatchObject({ runs: 1, findings: 5, actions: 5 });
    expect(vi.mocked(loadMonitorFacts)).toHaveBeenCalledTimes(1);
  });

  it("a retry after a failure picks the same run row back up", async () => {
    const job = { id: randomUUID(), data: { householdId: A, ownerUserId: A_OWNER } };
    vi.mocked(loadMonitorFacts).mockRejectedValueOnce(new Error("boom"));
    // @ts-expect-error a minimal pg-boss job
    await expect(handleMonitorJobs([job])).rejects.toThrow("boom");
    // @ts-expect-error a minimal pg-boss job
    await handleMonitorJobs([job]);
    const runs = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", error: null });
  });

  it("the daily tick enqueues one job per household with a Plaid item, singleton by household", async () => {
    await db.insert(plaidItemsTable).values({ userId: A_OWNER, householdId: A, itemId: `it-${randomUUID()}`, accessToken: "access-sandbox-synthetic" });
    // @ts-expect-error a minimal pg-boss job
    const out = await handleMonitorJobs([{ id: randomUUID(), data: { fanout: true } }]);
    expect(out.fannedOut).toBeGreaterThanOrEqual(1);
    const mine = _emittedForTests.filter((e) => (e.data as { householdId?: string }).householdId === A);
    expect(mine).toEqual([
      {
        queue: QUEUES.monitorHousehold,
        data: { householdId: A, ownerUserId: A_OWNER, trigger: "schedule" },
        opts: monitorSendOptions(A),
      },
    ]);
    expect(monitorSendOptions(A)).toEqual({ singletonKey: `mon:${A}`, singletonSeconds: 600, expireInSeconds: 300, retryLimit: 2 });
    expect(_emittedForTests.some((e) => (e.data as { householdId?: string }).householdId === B)).toBe(false);
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, A));
    void householdsTable;
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import type { Job } from "pg-boss";
import {
  startJobs,
  stopJobs,
  getBoss,
  getJobsHealth,
  getJobsMode,
  _resetJobsHealthCacheForTests,
} from "../jobs/boss";
import { emit } from "../jobs/emit";
import { ALL_QUEUES, QUEUES, dlqName } from "../jobs/queues";
import { PRUNE_SYNC_ATTEMPTS_CRON, handlePruneSyncAttempts } from "../jobs/handlers/maintenance";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-0) pg-boss against the real test Postgres, in a throwaway schema:
// start (all program queues + DLQs + the prune schedule), send/work, singleton
// dedupe, retry → dead-letter queue, health counts, stop. The schema is
// dropped at the end.

const SCHEMA = "pgboss_test";
pinEnv({ JOBS_MODE: "on", PGBOSS_SCHEMA: SCHEMA });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
}, 30_000);

afterAll(async () => {
  await stopJobs({ graceful: false, timeout: 2_000 }).catch(() => {});
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
}, 30_000);

describe("pg-boss lifecycle", () => {
  it("starts, creates every program queue with its DLQ and shared options, and schedules the prune", async () => {
    expect(getJobsMode()).toBe("on");
    await expect(startJobs()).resolves.toEqual({ started: true });
    const boss = getBoss();
    expect(boss).not.toBeNull();

    for (const q of ALL_QUEUES) {
      const queue = await boss!.getQueue(q);
      expect(queue, q).toMatchObject({
        name: q,
        retryLimit: 3,
        retryBackoff: true,
        expireInSeconds: 300,
        deadLetter: dlqName(q),
        policy: "standard",
      });
      expect(await boss!.getQueue(dlqName(q))).not.toBeNull();
    }
    const schedules = await boss!.getSchedules(QUEUES.maintenancePruneSyncAttempts);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ cron: PRUNE_SYNC_ATTEMPTS_CRON, timezone: "UTC" });

    // Starting again is a no-op, not a second instance.
    await expect(startJobs()).resolves.toEqual({ started: true });
    expect(getBoss()).toBe(boss);
  }, 60_000);

  it("send + work: a job emitted on a queue reaches its handler", async () => {
    const boss = getBoss()!;
    await boss.createQueue("test.echo");
    const got = new Promise<object>((resolve) => {
      void boss.work<{ n: number }>("test.echo", { pollingIntervalSeconds: 0.5 }, async ([job]: Job<{ n: number }>[]) => {
        resolve(job!.data);
      });
    });
    const id = await boss.send("test.echo", { n: 42 });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(await got).toEqual({ n: 42 });
  }, 30_000);

  it("emit() in on mode sends to the queue and returns the job id", async () => {
    const id = await emit(QUEUES.metricsSnapshot, { day: "2026-10-07" });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const [job] = await getBoss()!.findJobs(QUEUES.metricsSnapshot, { id: id! });
    expect(job?.data).toEqual({ day: "2026-10-07" });
  });

  it("singleton dedupe: the same singletonKey inside its window is sent once", async () => {
    const opts = { singletonKey: "item:abc", singletonSeconds: 300 };
    const first = await emit(QUEUES.txnArrived, { itemId: "abc" }, opts);
    const second = await emit(QUEUES.txnArrived, { itemId: "abc" }, opts);
    const other = await emit(QUEUES.txnArrived, { itemId: "def" }, { singletonKey: "item:def", singletonSeconds: 300 });
    expect(first).toMatch(/[0-9a-f-]{36}/);
    expect(second).toBeNull();
    expect(other).toMatch(/[0-9a-f-]{36}/);
  });

  it("a handler that keeps failing is retried, then lands in its dead-letter queue", async () => {
    const boss = getBoss()!;
    await boss.createQueue("test.fail.dlq");
    await boss.createQueue("test.fail", { retryLimit: 1, retryDelay: 0, retryBackoff: false, deadLetter: "test.fail.dlq" });
    let attempts = 0;
    await boss.work("test.fail", { pollingIntervalSeconds: 0.5 }, async () => {
      attempts += 1;
      throw new Error("handler exploded");
    });
    const id = await boss.send("test.fail", { why: "dlq" });
    const parked = await waitFor(async () => {
      const jobs = await boss.findJobs<{ why: string }>("test.fail.dlq", { data: { why: "dlq" } });
      return jobs.length > 0 ? jobs : null;
    });
    expect(parked[0]!.data).toEqual({ why: "dlq" });
    expect(attempts).toBe(2); // first try + one retry
    const [original] = await boss.findJobs("test.fail", { id: id! });
    expect(original?.state).toBe("failed");

    _resetJobsHealthCacheForTests();
    const health = await getJobsHealth();
    expect(health).toMatchObject({ mode: "on", started: true });
    expect(health.failedLast24h).toBeGreaterThanOrEqual(1);
    expect(health.dlq).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("the maintenance handler prunes plaid_sync_attempts and reports the count", async () => {
    const r = await handlePruneSyncAttempts([]);
    expect(typeof r.deleted).toBe("number");
  });

  it("stops cleanly; health then reports started=false", async () => {
    await stopJobs({ graceful: true, timeout: 5_000 });
    expect(getBoss()).toBeNull();
    _resetJobsHealthCacheForTests();
    expect((await getJobsHealth()).started).toBe(false);
  }, 30_000);
});

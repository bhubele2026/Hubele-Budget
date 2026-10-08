import { describe, it, expect, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { startJobs, stopJobs, getBoss } from "../jobs/boss";
import { QUEUES } from "../jobs/queues";
import { MONITOR_CRON, MONITOR_TZ, monitorSendOptions } from "../jobs/handlers/monitor";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-3) With jobs on, boot registers the monitor worker and ONE daily
// 02:15 America/Chicago fan-out schedule on monitor.household, and a second
// per-household job inside 10 minutes is dropped by its singleton key.

const SCHEMA = "pgboss_test_ai3";
pinEnv({ JOBS_MODE: "on", PGBOSS_SCHEMA: SCHEMA });

afterAll(async () => {
  await stopJobs({ graceful: false, timeout: 2_000 }).catch(() => {});
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
}, 30_000);

describe("monitor.household registration", () => {
  it("schedules the fan-out daily at 02:15 America/Chicago", async () => {
    await pool.query(`drop schema if exists ${SCHEMA} cascade`);
    await expect(startJobs()).resolves.toEqual({ started: true });
    const boss = getBoss()!;
    expect(MONITOR_CRON).toBe("15 2 * * *");
    expect(MONITOR_TZ).toBe("America/Chicago");
    const schedules = await boss.getSchedules(QUEUES.monitorHousehold);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ cron: "15 2 * * *", timezone: "America/Chicago", data: { fanout: true } });

    const q = await boss.getQueue(QUEUES.monitorHousehold);
    expect(q).toMatchObject({ retryLimit: 3, expireInSeconds: 300 });
  }, 60_000);

  it("one job per household per 10 minutes (singleton), with the brief's options", async () => {
    const boss = getBoss()!;
    const data = { householdId: "00000000-0000-4000-8000-0000000000aa", ownerUserId: "owner-x" };
    const opts = monitorSendOptions(data.householdId);
    const first = await boss.send(QUEUES.monitorHousehold, data, opts);
    const second = await boss.send(QUEUES.monitorHousehold, data, opts);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const job = await boss.getJobById(QUEUES.monitorHousehold, first!);
    expect(job).toMatchObject({ retryLimit: 2, expireInSeconds: 300, singletonKey: `mon:${data.householdId}` });
  }, 30_000);
});

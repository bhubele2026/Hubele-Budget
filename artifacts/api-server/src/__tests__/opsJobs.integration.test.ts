import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, pool, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-0) Owner-only job operations: a non-owner gets 403 on both routes; the
// owner sees counts per queue/state and recent failures, and can put a failed
// job back in its queue.

const OWNER_USER = `owner-ops-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER_USER = `member-ops-${process.pid}-${randomUUID().slice(0, 8)}`;
let currentUserId = OWNER_USER;
let HH: string;
const SCHEMA = "pgboss_ops_test";

pinEnv({ OWNER_EMAIL: "owner@example.com", JOBS_MODE: "on", PGBOSS_SCHEMA: SCHEMA });

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = currentUserId;
    req.actualUserId = currentUserId;
    req.householdId = HH;
    req.householdOwnerId = OWNER_USER;
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: async (userId: string) => ({
        id: userId,
        primaryEmailAddressId: "e1",
        emailAddresses: [
          { id: "e1", emailAddress: userId === OWNER_USER ? "owner@example.com" : "member@example.com" },
        ],
      }),
    },
  },
}));

import opsRouter from "../routes/ops";
import { startJobs, stopJobs, getBoss } from "../jobs/boss";
import { createTestApp } from "./_helpers/createTestApp";

const { request } = createTestApp(opsRouter);

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER_USER)).householdId;
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
}, 30_000);

afterAll(async () => {
  await stopJobs({ graceful: false, timeout: 2_000 }).catch(() => {});
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  for (const u of [OWNER_USER, MEMBER_USER]) await db.delete(profilesTable).where(eq(profilesTable.id, u));
}, 30_000);

describe("ops/jobs auth", () => {
  it("a household member who is not the owner gets 403 on both routes", async () => {
    currentUserId = MEMBER_USER;
    expect((await request("GET", "/ops/jobs")).status).toBe(403);
    expect((await request("POST", `/ops/jobs/${randomUUID()}/retry`)).status).toBe(403);
    currentUserId = OWNER_USER;
  });
});

describe("ops/jobs as the owner", () => {
  it("answers with empty lists before pg-boss has ever run here", async () => {
    const { status, json } = await request("GET", "/ops/jobs");
    expect(status).toBe(200);
    expect(json).toEqual({ mode: "on", started: false, schema: SCHEMA, counts: [], failures: [] });
    expect((await request("POST", "/ops/jobs/not-a-uuid/retry")).status).toBe(400);
    expect((await request("POST", `/ops/jobs/${randomUUID()}/retry`)).status).toBe(404);
  });

  it("lists counts and the failure (message only), and retries a failed job", async () => {
    await startJobs();
    const boss = getBoss()!;
    await boss.createQueue("ops.fail", { retryLimit: 0 });
    await boss.work("ops.fail", { pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error("could not reach the thing");
    });
    const id = (await boss.send("ops.fail", { n: 1 }))!;
    const until = Date.now() + 20_000;
    let failed = false;
    while (!failed && Date.now() < until) {
      const [job] = await boss.findJobs("ops.fail", { id });
      failed = job?.state === "failed";
      if (!failed) await new Promise((r) => setTimeout(r, 200));
    }
    expect(failed).toBe(true);
    await boss.offWork("ops.fail");

    const { status, json } = await request("GET", "/ops/jobs");
    expect(status).toBe(200);
    const report = json as {
      started: boolean;
      counts: { queue: string; state: string; count: number }[];
      failures: { id: string; queue: string; error: string | null; retryCount: number }[];
    };
    expect(report.started).toBe(true);
    expect(report.counts).toContainEqual({ queue: "ops.fail", state: "failed", count: 1 });
    const f = report.failures.find((x) => x.id === id);
    expect(f).toMatchObject({ queue: "ops.fail", error: "could not reach the thing" });
    expect(f!.error).not.toContain("at "); // no stack

    const retry = await request("POST", `/ops/jobs/${id}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({ id, queue: "ops.fail", retried: true });
    const [after] = await boss.findJobs("ops.fail", { id });
    expect(after?.state).toBe("retry");

    // A job that is not failed cannot be retried.
    expect((await request("POST", `/ops/jobs/${id}/retry`)).status).toBe(409);
  }, 60_000);

  it("a retry needs the running instance (503 when jobs are stopped)", async () => {
    const boss = getBoss()!;
    await boss.createQueue("ops.fail2", { retryLimit: 0 });
    const id = (await boss.send("ops.fail2", {}))!;
    const [job] = await boss.fetch("ops.fail2");
    await boss.fail("ops.fail2", job!.id, { message: "x" });
    await stopJobs({ graceful: false, timeout: 2_000 });
    expect((await request("POST", `/ops/jobs/${id}/retry`)).status).toBe(503);
  }, 30_000);
});

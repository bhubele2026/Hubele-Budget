import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import { db, aiUsageTable, recapDeliveriesTable, recapSettingsTable, recapsTable, agentRunsTable } from "@workspace/db";
import { pinEnv } from "./_helpers/aiEnv";
import { makeMembers, dropMembers, seedVerified, type TestMember } from "./_helpers/smsFixtures";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";
import { handleRecapGenerate, handleRecapSend, sendScheduledRecap } from "../jobs/handlers/recapJobs";
import { handleRecapTick, runRecapTick, type RecapJobData } from "../jobs/handlers/recapTick";
import { _failNextFakeSms, _resetFakeSmsForTests, sentSms } from "../lib/sms/fake";
import { _resetSmsProviderForTests } from "../lib/sms";
import { resetFake } from "../ai/fake";

// (AI-4a) The schedule: the 5-minute tick decides, the workers act. Everything
// runs with JOBS_MODE=off, so emit() records what it would have queued and the
// test hands that to the handler itself. Time is passed in; the system clock is
// pinned to the same instant so rows written by the code under test agree.

pinEnv({
  JOBS_MODE: "off",
  AI_ENABLED: "false",
  SMS_PROVIDER: "fake",
  SMS_DAILY_SEND_CAP: "100000",
  SMS_WEBHOOK_BASE_URL: undefined,
  APP_URL: "https://h2.example.test",
  NODE_ENV: "test",
});

const at = (iso: string) => new Date(iso);
function setNow(iso: string): Date {
  const d = at(iso);
  vi.setSystemTime(d);
  return d;
}
const job = (data: RecapJobData, id = `job-${data.userId}-${data.forDate}`): Job<RecapJobData>[] => [{ id, data } as Job<RecapJobData>];
const emittedFor = (m: TestMember, queue?: string) =>
  _emittedForTests.filter((e) => (e.data as RecapJobData).userId === m.userId && (!queue || e.queue === queue));

let members: TestMember[] = [];
async function member(over: Partial<typeof recapSettingsTable.$inferInsert> = {}): Promise<TestMember> {
  const [m] = await makeMembers(1);
  await seedVerified(m!, `+1555555${String(1000 + members.length).padStart(4, "0")}`, over);
  members.push(m!);
  return m!;
}

beforeAll(() => {
  vi.setSystemTime(at("2026-10-07T00:00:00Z"));
});
beforeEach(() => {
  _emittedForTests.length = 0;
  _resetFakeSmsForTests();
  _resetSmsProviderForTests();
  resetFake();
});
afterEach(async () => {
  await dropMembers(members);
  members = [];
});
afterAll(() => {
  vi.useRealTimers();
});

describe("a normal morning (Central, 07:00 = 12:00Z in October)", () => {
  it("generates at send - 30 min, sends at send, and never twice", async () => {
    const m = await member();
    const data: RecapJobData = { householdId: m.householdId, userId: m.userId, forDate: "2026-10-07" };

    // 31 minutes before: nothing for this member.
    await runRecapTick(setNow("2026-10-07T11:29:00Z"));
    expect(emittedFor(m)).toHaveLength(0);

    // 30 minutes before: one generate job, keyed by member and day.
    await runRecapTick(setNow("2026-10-07T11:30:00Z"));
    expect(emittedFor(m)).toEqual([
      { queue: QUEUES.recapGenerate, data, opts: { singletonKey: `recap-gen:${m.userId}:2026-10-07` } },
    ]);
    // Run it: one drafted recap, one agent_runs row.
    expect(await handleRecapGenerate(job(data))).toEqual({ generated: 1 });
    const [recap] = await db.select().from(recapsTable).where(eq(recapsTable.userId, m.userId));
    expect(recap).toMatchObject({ forDate: "2026-10-07", status: "drafted", source: "template" });
    expect(await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, m.householdId))).toHaveLength(1);

    // Between generation and the send time: still nothing more.
    _emittedForTests.length = 0;
    await runRecapTick(setNow("2026-10-07T11:45:00Z"));
    await runRecapTick(setNow("2026-10-07T11:59:00Z"));
    expect(emittedFor(m)).toHaveLength(0);
    expect(sentSms).toHaveLength(0);

    // At the send time: one send job.
    await runRecapTick(setNow("2026-10-07T12:00:00Z"));
    expect(emittedFor(m)).toEqual([
      { queue: QUEUES.recapSend, data, opts: { singletonKey: `recap:${m.userId}:2026-10-07` } },
    ]);
    expect(await handleRecapSend(job(data))).toEqual({ sent: 1 });
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0]!.body).toBe(recap!.text);
    expect(sentSms[0]!.body.endsWith("https://h2.example.test/?d=2026-10-07")).toBe(true);

    // The delivery is linked to the recap, and the recap is marked sent.
    const [delivery] = await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.userId, m.userId));
    expect(delivery).toMatchObject({ kind: "scheduled", forDate: "2026-10-07", recapId: recap!.id, status: "sent" });
    expect((await db.select().from(recapsTable).where(eq(recapsTable.id, recap!.id)))[0]!.status).toBe("sent");

    // Later ticks, and a repeated send job, change nothing.
    _emittedForTests.length = 0;
    await runRecapTick(setNow("2026-10-07T12:05:00Z"));
    await runRecapTick(setNow("2026-10-07T13:00:00Z"));
    expect(emittedFor(m)).toHaveLength(0);
    expect(await sendScheduledRecap(data)).toBe("already_sent");
    expect(await handleRecapSend(job(data))).toEqual({ sent: 0 });
    expect(sentSms).toHaveLength(1);
  });

  it("two send jobs at once text once", async () => {
    const m = await member();
    const data: RecapJobData = { householdId: m.householdId, userId: m.userId, forDate: "2026-10-07" };
    setNow("2026-10-07T11:30:00Z");
    await handleRecapGenerate(job(data));
    setNow("2026-10-07T12:00:00Z");
    const out = await Promise.all([sendScheduledRecap(data), sendScheduledRecap(data), sendScheduledRecap(data)]);
    expect(out.filter((o) => o === "sent")).toHaveLength(1);
    expect(sentSms).toHaveLength(1);
    expect(await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.userId, m.userId))).toHaveLength(1);
  });

  it("the tick handler (the pg-boss entry point) does the same work", async () => {
    const m = await member();
    const r = await handleRecapTick([], setNow("2026-10-07T11:30:00Z"));
    expect(r.generate).toBeGreaterThanOrEqual(1);
    expect(emittedFor(m, QUEUES.recapGenerate)).toHaveLength(1);
  });
});

describe("who is skipped", () => {
  it("weekends, when the member asked to skip them", async () => {
    const skipper = await member({ skipWeekends: true });
    const other = await member({ skipWeekends: false });
    await runRecapTick(setNow("2026-10-10T11:30:00Z")); // Saturday
    expect(emittedFor(skipper)).toHaveLength(0);
    expect(emittedFor(other, QUEUES.recapGenerate)).toHaveLength(1);
    _emittedForTests.length = 0;
    await runRecapTick(setNow("2026-10-11T11:30:00Z")); // Sunday
    expect(emittedFor(skipper)).toHaveLength(0);
    await runRecapTick(setNow("2026-10-12T11:30:00Z")); // Monday
    expect(emittedFor(skipper, QUEUES.recapGenerate)).toHaveLength(1);
  });

  it("a paused member until the pause ends", async () => {
    const m = await member({ pausedUntil: at("2026-10-07T20:00:00Z") });
    await runRecapTick(setNow("2026-10-07T11:30:00Z"));
    expect(emittedFor(m)).toHaveLength(0);
    await runRecapTick(setNow("2026-10-07T20:00:01Z"));
    // Paused ended, but the morning is long past: nothing is sent late.
    expect(emittedFor(m, QUEUES.recapSend)).toHaveLength(0);
    await db.update(recapSettingsTable).set({ pausedUntil: at("2026-10-07T11:00:00Z") }).where(eq(recapSettingsTable.userId, m.userId));
    await runRecapTick(setNow("2026-10-07T11:30:00Z"));
    expect(emittedFor(m, QUEUES.recapGenerate)).toHaveLength(1);
  });

  it("members who are off, unverified or opted out", async () => {
    const off = await member({ enabled: false });
    const unverified = await member({ verifiedAt: null });
    const optedOut = await member({ optedOutAt: at("2026-10-01T00:00:00Z") });
    await runRecapTick(setNow("2026-10-07T11:30:00Z"));
    for (const m of [off, unverified, optedOut]) expect(emittedFor(m)).toHaveLength(0);
  });

  it("a member whose consent was withdrawn after the draft is not texted, and the recap is skipped", async () => {
    const m = await member();
    const data: RecapJobData = { householdId: m.householdId, userId: m.userId, forDate: "2026-10-07" };
    setNow("2026-10-07T11:30:00Z");
    await handleRecapGenerate(job(data));
    await db.update(recapSettingsTable).set({ optedOutAt: at("2026-10-07T11:50:00Z"), enabled: false }).where(eq(recapSettingsTable.userId, m.userId));
    setNow("2026-10-07T12:00:00Z");
    expect(await sendScheduledRecap(data)).toBe("blocked");
    expect(sentSms).toHaveLength(0);
    expect((await db.select().from(recapsTable).where(eq(recapsTable.userId, m.userId)))[0]!.status).toBe("skipped");
  });

  it("a recap more than six hours late is marked skipped, not sent", async () => {
    const m = await member();
    const data: RecapJobData = { householdId: m.householdId, userId: m.userId, forDate: "2026-10-07" };
    setNow("2026-10-07T11:30:00Z");
    await handleRecapGenerate(job(data));
    await runRecapTick(setNow("2026-10-07T18:01:00Z"));
    expect(emittedFor(m)).toHaveLength(0);
    expect((await db.select().from(recapsTable).where(eq(recapsTable.userId, m.userId)))[0]!.status).toBe("skipped");
  });
});

describe("each member's own zone and time", () => {
  it("Eastern at 07:00 is an hour before Central", async () => {
    const east = await member({ timezone: "America/New_York" });
    await runRecapTick(setNow("2026-10-07T10:29:00Z"));
    expect(emittedFor(east)).toHaveLength(0);
    await runRecapTick(setNow("2026-10-07T10:30:00Z")); // 06:30 EDT
    expect(emittedFor(east, QUEUES.recapGenerate)).toHaveLength(1);
  });

  it("a different send time moves the whole schedule", async () => {
    const m = await member({ sendTimeLocal: "18:45" });
    await runRecapTick(setNow("2026-10-07T23:14:00Z"));
    expect(emittedFor(m)).toHaveLength(0);
    await runRecapTick(setNow("2026-10-07T23:15:00Z")); // 18:15 CDT
    expect(emittedFor(m, QUEUES.recapGenerate)).toHaveLength(1);
  });

  it("uses the member's local date near midnight UTC", async () => {
    const m = await member({ sendTimeLocal: "20:00" });
    // 19:30 Central on Oct 7 is 00:30Z on Oct 8: the recap is still for Oct 7.
    await runRecapTick(setNow("2026-10-08T00:30:00Z"));
    const jobs = emittedFor(m, QUEUES.recapGenerate);
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.data as RecapJobData).forDate).toBe("2026-10-07");
  });

  const dst: Array<[string, string, string, string]> = [
    // zone, local date, last UTC minute BEFORE generation, first UTC minute that generates (07:00 local - 30 min)
    ["America/Chicago", "2026-03-08", "2026-03-08T11:29:00Z", "2026-03-08T11:30:00Z"], // CDT after the 02:00 jump
    ["America/Chicago", "2026-11-01", "2026-11-01T12:29:00Z", "2026-11-01T12:30:00Z"], // CST after the 02:00 fall
    ["America/New_York", "2026-03-08", "2026-03-08T10:29:00Z", "2026-03-08T10:30:00Z"],
    ["America/New_York", "2026-11-01", "2026-11-01T11:29:00Z", "2026-11-01T11:30:00Z"],
  ];
  for (const [tz, date, before, first] of dst) {
    it(`07:00 on ${date} in ${tz}: generate at ${first}, send 30 min later`, async () => {
      const m = await member({ timezone: tz });
      await runRecapTick(setNow(before));
      expect(emittedFor(m)).toHaveLength(0);
      await runRecapTick(setNow(first));
      const gen = emittedFor(m, QUEUES.recapGenerate);
      expect(gen).toHaveLength(1);
      expect((gen[0]!.data as RecapJobData).forDate).toBe(date);
      await handleRecapGenerate(job(gen[0]!.data as RecapJobData));
      _emittedForTests.length = 0;
      const sendAt = new Date(new Date(first).getTime() + 30 * 60_000 - 60_000);
      await runRecapTick(setNow(sendAt.toISOString()));
      expect(emittedFor(m)).toHaveLength(0); // one minute short of 07:00
      await runRecapTick(setNow(new Date(sendAt.getTime() + 60_000).toISOString()));
      expect(emittedFor(m, QUEUES.recapSend)).toHaveLength(1);
    });
  }
});

describe("failures and retries", () => {
  it("a failed text is retried after 60 s, at most three attempts, then left alone", async () => {
    const m = await member();
    const data: RecapJobData = { householdId: m.householdId, userId: m.userId, forDate: "2026-10-07" };
    setNow("2026-10-07T11:30:00Z");
    await handleRecapGenerate(job(data));
    _failNextFakeSms(5);

    // Attempt 1 at the send time fails.
    setNow("2026-10-07T12:00:00Z");
    await runRecapTick(at("2026-10-07T12:00:00Z"));
    expect(emittedFor(m, QUEUES.recapSend)).toHaveLength(1);
    expect(await sendScheduledRecap(data, at("2026-10-07T12:00:00Z"))).toBe("failed");
    const row = async () => (await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.userId, m.userId)))[0]!;
    expect(await row()).toMatchObject({ status: "failed", attempts: 1 });
    expect((await db.select().from(recapsTable).where(eq(recapsTable.userId, m.userId)))[0]!.status).toBe("failed");

    // 30 s later: backing off. 61 s later: retry.
    _emittedForTests.length = 0;
    await runRecapTick(setNow("2026-10-07T12:00:30Z"));
    expect(emittedFor(m)).toHaveLength(0);
    await runRecapTick(setNow("2026-10-07T12:01:01Z"));
    expect(emittedFor(m, QUEUES.recapSend)).toHaveLength(1);
    expect(await sendScheduledRecap(data, at("2026-10-07T12:01:01Z"))).toBe("failed");
    expect(await row()).toMatchObject({ status: "failed", attempts: 2 });

    _emittedForTests.length = 0;
    await runRecapTick(setNow("2026-10-07T12:02:30Z"));
    expect(emittedFor(m, QUEUES.recapSend)).toHaveLength(1);
    expect(await sendScheduledRecap(data, at("2026-10-07T12:02:30Z"))).toBe("failed");
    expect(await row()).toMatchObject({ status: "failed", attempts: 3 });

    // Three attempts used: no more, however long we wait (inside the six hours).
    _emittedForTests.length = 0;
    await runRecapTick(setNow("2026-10-07T13:00:00Z"));
    expect(emittedFor(m)).toHaveLength(0);
    expect(sentSms).toHaveLength(0);
  });

  it("a retry that works marks the recap sent, once", async () => {
    const m = await member();
    const data: RecapJobData = { householdId: m.householdId, userId: m.userId, forDate: "2026-10-07" };
    setNow("2026-10-07T11:30:00Z");
    await handleRecapGenerate(job(data));
    _failNextFakeSms(1);
    setNow("2026-10-07T12:00:00Z");
    expect(await sendScheduledRecap(data, at("2026-10-07T12:00:00Z"))).toBe("failed");
    setNow("2026-10-07T12:02:00Z");
    expect(await sendScheduledRecap(data, at("2026-10-07T12:02:00Z"))).toBe("sent");
    expect(sentSms).toHaveLength(1);
    expect((await db.select().from(recapsTable).where(eq(recapsTable.userId, m.userId)))[0]!.status).toBe("sent");
    _emittedForTests.length = 0;
    await runRecapTick(setNow("2026-10-07T12:10:00Z"));
    expect(emittedFor(m)).toHaveLength(0);
  });

  it("a send job with no recap does nothing", async () => {
    const m = await member();
    expect(await sendScheduledRecap({ householdId: m.householdId, userId: m.userId, forDate: "2026-10-07" })).toBe("missing");
    expect(sentSms).toHaveLength(0);
  });

  it("a send job cannot reach another household's recap", async () => {
    const a = await member();
    const b = await member();
    setNow("2026-10-07T11:30:00Z");
    await handleRecapGenerate(job({ householdId: a.householdId, userId: a.userId, forDate: "2026-10-07" }));
    expect(await sendScheduledRecap({ householdId: b.householdId, userId: a.userId, forDate: "2026-10-07" })).toBe("missing");
    expect(sentSms).toHaveLength(0);
  });
});

describe("cleanup", () => {
  it("leaves no usage rows behind for the households it made (AI off)", async () => {
    const m = await member();
    expect(await db.select().from(aiUsageTable).where(eq(aiUsageTable.householdId, m.householdId))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(recapDeliveriesTable)
        .where(and(eq(recapDeliveriesTable.householdId, m.householdId), eq(recapDeliveriesTable.kind, "scheduled"))),
    ).toHaveLength(0);
  });
});

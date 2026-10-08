import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db, recapDeliveriesTable, recapSettingsTable } from "@workspace/db";
import { sendSms } from "../lib/sms/send";
import { sendRecapDelivery } from "../recap/deliver";
import { sentSms, _resetFakeSmsForTests, _failNextFakeSms } from "../lib/sms/fake";
import { _resetSmsProviderForTests } from "../lib/sms";
import { pinEnv } from "./_helpers/aiEnv";
import { makeMembers, dropMembers, seedSettings, seedVerified, type TestMember } from "./_helpers/smsFixtures";

// (AI-4b) sendSms(): the delivery row is the dedupe, the daily cap is global,
// a failure is recorded not thrown, and sendRecapDelivery() refuses anyone who
// has not consented, opted out, or turned the recap off.

pinEnv({ SMS_PROVIDER: "fake", SMS_DAILY_SEND_CAP: "10000", SMS_WEBHOOK_BASE_URL: undefined });

let A: TestMember;
let B: TestMember;
const PHONE = "+15555550101";

beforeAll(async () => {
  [A, B] = await makeMembers(2);
});
afterAll(async () => {
  await dropMembers([A, B]);
});
beforeEach(async () => {
  _resetFakeSmsForTests();
  _resetSmsProviderForTests();
  await db.delete(recapDeliveriesTable).where(eq(recapDeliveriesTable.userId, A.userId));
  await db.delete(recapSettingsTable).where(eq(recapSettingsTable.userId, A.userId));
});

const base = () => ({ householdId: A.householdId, userId: A.userId, kind: "test" as const, to: PHONE, body: "hello" });

async function rows() {
  return db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.userId, A.userId));
}

describe("sendSms", () => {
  it("sends once, records the provider id, and never sends the same idempotency key twice", async () => {
    const first = await sendSms({ ...base(), idempotencyKey: "k-1" });
    const second = await sendSms({ ...base(), idempotencyKey: "k-1" });
    const third = await sendSms({ ...base(), body: "different body, same key", idempotencyKey: "k-1" });
    expect(first.outcome).toBe("sent");
    expect(second).toEqual({ outcome: "duplicate", deliveryId: first.deliveryId });
    expect(third.outcome).toBe("duplicate");
    expect(sentSms).toHaveLength(1);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: "sent", provider: "fake", providerMessageId: "fake_1", attempts: 1, kind: "test" });
  });

  it("concurrent calls with one key send exactly once", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => sendSms({ ...base(), idempotencyKey: "k-race" })));
    expect(results.filter((r) => r.outcome === "sent")).toHaveLength(1);
    expect(sentSms).toHaveLength(1);
  });

  it("records a provider failure on the row (number scrubbed), and a failed row may be claimed again, up to 3 attempts", async () => {
    _failNextFakeSms(3);
    const a = await sendSms({ ...base(), idempotencyKey: "k-fail" });
    expect(a.outcome).toBe("failed");
    const [row] = await rows();
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row!.lastError).toContain("forced failure");

    expect((await sendSms({ ...base(), idempotencyKey: "k-fail" })).outcome).toBe("failed");
    expect((await sendSms({ ...base(), idempotencyKey: "k-fail" })).outcome).toBe("failed");
    // Three attempts used: the key is spent.
    expect((await sendSms({ ...base(), idempotencyKey: "k-fail" })).outcome).toBe("duplicate");
    expect(sentSms).toHaveLength(0);

    // A different failure that recovers: the retry sends.
    _failNextFakeSms(1);
    expect((await sendSms({ ...base(), idempotencyKey: "k-recover" })).outcome).toBe("failed");
    expect((await sendSms({ ...base(), idempotencyKey: "k-recover" })).outcome).toBe("sent");
    expect(sentSms).toHaveLength(1);
  });

  it("holds the global daily cap: the over-cap send is recorded as failed 'daily_cap' and nothing is sent", async () => {
    // Count what already exists today (other rows in this database), then allow exactly 2 more.
    const [{ n: count }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recapDeliveriesTable)
      .where(
        and(
          sql`${recapDeliveriesTable.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
          sql`${recapDeliveriesTable.status} <> 'failed'`,
        ),
      );
    process.env.SMS_DAILY_SEND_CAP = String(count + 2);
    try {
      expect((await sendSms({ ...base(), idempotencyKey: "cap-1" })).outcome).toBe("sent");
      expect((await sendSms({ ...base(), idempotencyKey: "cap-2" })).outcome).toBe("sent");
      const over = await sendSms({ ...base(), idempotencyKey: "cap-3" });
      expect(over).toMatchObject({ outcome: "capped", error: "daily_cap" });
      expect(sentSms).toHaveLength(2);
      const capped = (await rows()).find((r) => r.idempotencyKey === "cap-3");
      expect(capped).toMatchObject({ status: "failed", lastError: "daily_cap", attempts: 0 });
      // Compliance replies (STOP/START/HELP answers) are never capped.
      const reply = await sendSms({ ...base(), kind: "reply", idempotencyKey: "cap-reply" });
      expect(reply.outcome).toBe("sent");
      // Raise the cap and the capped key can go out (it never used an attempt).
      process.env.SMS_DAILY_SEND_CAP = String(count + 10);
      expect((await sendSms({ ...base(), idempotencyKey: "cap-3" })).outcome).toBe("sent");
    } finally {
      process.env.SMS_DAILY_SEND_CAP = "10000";
    }
  });

  it("one scheduled recap per member per day, even under a different key", async () => {
    const day = { ...base(), kind: "scheduled" as const, forDate: "2026-10-07" };
    expect((await sendSms({ ...day, idempotencyKey: "s-1" })).outcome).toBe("sent");
    expect((await sendSms({ ...day, idempotencyKey: "s-2" })).outcome).toBe("duplicate");
    expect((await sendSms({ ...day, forDate: "2026-10-08", idempotencyKey: "s-3" })).outcome).toBe("sent");
    expect(sentSms).toHaveLength(2);
  });

  it("rejects a kind or status the database does not know", async () => {
    await expect(
      db.insert(recapDeliveriesTable).values({
        householdId: A.householdId, userId: A.userId, kind: "spam", toE164: PHONE, provider: "fake", status: "queued", idempotencyKey: "bad-kind",
      }),
    ).rejects.toThrow();
  });
});

describe("sendRecapDelivery gates", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    userId: A.userId, householdId: A.householdId, kind: "scheduled" as const, body: "Recap body", forDate: "2026-10-07", ...over,
  });

  it("blocks with a reason until the member is verified, consented, enabled and not opted out or paused", async () => {
    expect(await sendRecapDelivery(input())).toMatchObject({ outcome: "blocked", blocked: "no_settings" });

    await seedSettings(A, { phoneE164: PHONE });
    expect(await sendRecapDelivery(input())).toMatchObject({ blocked: "not_verified" });

    await db.update(recapSettingsTable).set({ verifiedAt: new Date(), enabled: false }).where(eq(recapSettingsTable.userId, A.userId));
    expect(await sendRecapDelivery(input())).toMatchObject({ blocked: "disabled" });

    await db.update(recapSettingsTable).set({ enabled: true, pausedUntil: new Date(Date.now() + 3600_000) }).where(eq(recapSettingsTable.userId, A.userId));
    expect(await sendRecapDelivery(input())).toMatchObject({ blocked: "paused" });

    await db.update(recapSettingsTable).set({ pausedUntil: null, optedOutAt: new Date() }).where(eq(recapSettingsTable.userId, A.userId));
    expect(await sendRecapDelivery(input())).toMatchObject({ blocked: "opted_out" });
    expect(await sendRecapDelivery(input({ kind: "test" }))).toMatchObject({ blocked: "opted_out" });
    expect(sentSms).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("alerts need extra_alerts; a good scheduled send goes to the verified number and is keyed per day", async () => {
    await seedVerified(A, PHONE);
    expect(await sendRecapDelivery(input({ kind: "alert", body: "Alert" }))).toMatchObject({ blocked: "alerts_off" });

    const one = await sendRecapDelivery(input());
    const again = await sendRecapDelivery(input());
    expect(one.outcome).toBe("sent");
    expect(again.outcome).toBe("duplicate");
    expect(sentSms).toEqual([expect.objectContaining({ to: PHONE, body: "Recap body", idempotencyKey: `recap:${A.userId}:2026-10-07` })]);

    await db.update(recapSettingsTable).set({ extraAlerts: true }).where(eq(recapSettingsTable.userId, A.userId));
    expect((await sendRecapDelivery(input({ kind: "alert", body: "Alert" }))).outcome).toBe("sent");
  });

  it("never reads another member's number", async () => {
    await seedVerified(A, PHONE);
    expect(await sendRecapDelivery({ ...input(), userId: B.userId })).toMatchObject({ blocked: "no_settings" });
    expect(sentSms).toHaveLength(0);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { db, recapDeliveriesTable, recapSettingsTable, smsInboundTable } from "@workspace/db";
// The Twilio provider is replaced by the recording fake (signature helpers stay
// real), so no test here can reach the network even with "valid" credentials.
vi.mock("../lib/sms/twilio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sms/twilio")>();
  const { fakeProvider } = await import("../lib/sms/fake");
  return {
    ...actual,
    createTwilioProvider: () => ({ name: "twilio" as const, send: (m: Parameters<typeof fakeProvider.send>[0]) => fakeProvider.send(m) }),
  };
});

import smsRouter from "../routes/sms";
import { signTwilioRequest } from "../lib/sms/twilio";
import { sentSms, _resetFakeSmsForTests } from "../lib/sms/fake";
import { _resetSmsProviderForTests } from "../lib/sms";
import { _emittedForTests } from "../jobs/emit";
import { handleSmsInbound } from "../jobs/handlers/smsInbound";
import { pinEnv } from "./_helpers/aiEnv";
import { makeMembers, dropMembers, seedVerified, seedSettings, type TestMember } from "./_helpers/smsFixtures";

// (AI-4b) /api/sms/status and /api/sms/inbound: signature vectors (valid,
// invalid, missing -> 403), status callbacks update deliveries, STOP / START /
// HELP handling, unknown senders dropped, everything else queued as
// sms.inbound, replays harmless.

const TOKEN = "test-auth-token";
const BASE = "https://h2.example.test";
pinEnv({
  SMS_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_MESSAGING_SERVICE_SID: "MG00000000000000000000000000000000",
  SMS_WEBHOOK_BASE_URL: BASE,
  SMS_DAILY_SEND_CAP: "10000",
  JOBS_MODE: "off",
});

let server: Server;
let origin = "";
let A: TestMember, B: TestMember;
const PHONE_A = "+15555550111";
const PHONE_B = "+15555550112";
const STRANGER = "+15555550199";
let sidCounter = 0;
const sid = () => `SM${process.pid}${Date.now()}${++sidCounter}`;

beforeAll(async () => {
  [A, B] = await makeMembers(2);
  const app = express();
  app.use("/api/sms/status", express.urlencoded({ extended: false }));
  app.use("/api/sms/inbound", express.urlencoded({ extended: false }));
  app.use("/api", smsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await dropMembers([A, B]);
  await db.delete(smsInboundTable).where(inArray(smsInboundTable.fromE164, [PHONE_A, PHONE_B, STRANGER]));
});
beforeEach(async () => {
  _resetFakeSmsForTests();
  _resetSmsProviderForTests();
  _emittedForTests.length = 0;
  await db.delete(recapSettingsTable).where(inArray(recapSettingsTable.userId, [A.userId, B.userId]));
  await db.delete(recapDeliveriesTable).where(inArray(recapDeliveriesTable.userId, [A.userId, B.userId]));
});

async function post(path: string, params: Record<string, string>, opts: { sign?: boolean | string } = { sign: true }) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (opts.sign === true) headers["x-twilio-signature"] = signTwilioRequest(TOKEN, `${BASE}${path}`, params);
  else if (typeof opts.sign === "string") headers["x-twilio-signature"] = opts.sign;
  const res = await fetch(`${origin}${path}`, { method: "POST", headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text() };
}

const inbound = (from: string, body: string, messageSid = sid()) =>
  post("/api/sms/inbound", { MessageSid: messageSid, From: from, Body: body, To: "+15555550000" });

async function settingsOf(m: TestMember) {
  const [r] = await db.select().from(recapSettingsTable).where(eq(recapSettingsTable.userId, m.userId));
  return r!;
}

describe("signature check", () => {
  const params = () => ({ MessageSid: sid(), From: PHONE_A, Body: "HELP" });

  it("a valid signature passes on both endpoints", async () => {
    expect((await post("/api/sms/status", { MessageSid: sid(), MessageStatus: "delivered" })).status).toBe(204);
    expect((await post("/api/sms/inbound", params())).status).toBe(200);
  });

  it("an invalid signature is 403 and nothing happens", async () => {
    await seedVerified(A, PHONE_A);
    const bad = await post("/api/sms/inbound", params(), { sign: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(bad.status).toBe(403);
    expect(sentSms).toHaveLength(0);
    expect((await post("/api/sms/status", { MessageSid: "x", MessageStatus: "failed" }, { sign: "nope" })).status).toBe(403);
  });

  it("a missing signature is 403", async () => {
    expect((await post("/api/sms/inbound", params(), { sign: false })).status).toBe(403);
    expect((await post("/api/sms/status", { MessageSid: "x", MessageStatus: "sent" }, { sign: false })).status).toBe(403);
  });

  it("a signature made for a different URL or different params is 403", async () => {
    const p = params();
    const forOtherUrl = signTwilioRequest(TOKEN, `${BASE}/api/sms/status`, p);
    expect((await post("/api/sms/inbound", p, { sign: forOtherUrl })).status).toBe(403);
    const forOtherParams = signTwilioRequest(TOKEN, `${BASE}/api/sms/inbound`, { ...p, Body: "STOP" });
    expect((await post("/api/sms/inbound", p, { sign: forOtherParams })).status).toBe(403);
  });

  it("with no auth token or base URL configured, a twilio-signed request is refused (fails closed)", async () => {
    const prev = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_AUTH_TOKEN;
    _resetSmsProviderForTests();
    try {
      // Provider falls back to console (non-production), where the check is skipped...
      expect((await post("/api/sms/inbound", params(), { sign: false })).status).toBe(200);
      // ...but in production the check always runs, and with no token everything is refused.
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        expect((await post("/api/sms/inbound", params(), { sign: false })).status).toBe(403);
        expect((await post("/api/sms/status", { MessageSid: "x", MessageStatus: "sent" }, { sign: false })).status).toBe(403);
      } finally {
        process.env.NODE_ENV = env;
      }
    } finally {
      process.env.TWILIO_AUTH_TOKEN = prev;
      _resetSmsProviderForTests();
    }
  });

  it("console and fake skip the check outside production only", async () => {
    for (const provider of ["console", "fake"]) {
      process.env.SMS_PROVIDER = provider;
      _resetSmsProviderForTests();
      expect((await post("/api/sms/inbound", params(), { sign: false })).status).toBe(200);
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        expect((await post("/api/sms/inbound", params(), { sign: false })).status).toBe(403);
      } finally {
        process.env.NODE_ENV = env;
      }
    }
    process.env.SMS_PROVIDER = "twilio";
    _resetSmsProviderForTests();
  });
});

describe("status callback", () => {
  async function seedDelivery(m: TestMember, providerMessageId: string, status = "sent") {
    await db.insert(recapDeliveriesTable).values({
      householdId: m.householdId, userId: m.userId, kind: "test", toE164: PHONE_A, provider: "twilio",
      providerMessageId, status, idempotencyKey: `k-${providerMessageId}`,
    });
  }
  const statusOf = async (id: string) =>
    (await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.providerMessageId, id)))[0]!;

  it("moves a delivery sent -> delivered, never backwards, and answers 204 every time", async () => {
    const id = sid();
    await seedDelivery(A, id, "queued");
    expect((await post("/api/sms/status", { MessageSid: id, MessageStatus: "sent" })).status).toBe(204);
    expect((await statusOf(id)).status).toBe("sent");
    expect((await post("/api/sms/status", { MessageSid: id, MessageStatus: "delivered" })).status).toBe(204);
    expect((await statusOf(id)).status).toBe("delivered");
    // Late/out-of-order callbacks cannot undo it.
    await post("/api/sms/status", { MessageSid: id, MessageStatus: "sent" });
    await post("/api/sms/status", { MessageSid: id, MessageStatus: "failed" });
    expect((await statusOf(id)).status).toBe("delivered");
    // Interim states change nothing; unknown ids and junk are still 204.
    const id2 = sid();
    await seedDelivery(A, id2);
    await post("/api/sms/status", { MessageSid: id2, MessageStatus: "sending" });
    expect((await statusOf(id2)).status).toBe("sent");
    expect((await post("/api/sms/status", { MessageSid: "SMunknown", MessageStatus: "delivered" })).status).toBe(204);
    expect((await post("/api/sms/status", {})).status).toBe(204);
  });

  it("records undelivered / failed with the error code; carrier error 21610 also opts the member out", async () => {
    const id = sid();
    await seedDelivery(A, id);
    await seedVerified(A, PHONE_A);
    await post("/api/sms/status", { MessageSid: id, MessageStatus: "undelivered", ErrorCode: "30005" });
    expect(await statusOf(id)).toMatchObject({ status: "undelivered", lastError: "twilio 30005" });
    expect((await settingsOf(A)).optedOutAt).toBeNull();

    const id2 = sid();
    await seedDelivery(A, id2);
    await post("/api/sms/status", { MessageSid: id2, MessageStatus: "failed", ErrorCode: "21610" });
    expect(await statusOf(id2)).toMatchObject({ status: "failed", lastError: "twilio 21610" });
    const s = await settingsOf(A);
    expect(s.optedOutAt).not.toBeNull();
    expect(s.enabled).toBe(false);
  });
});

describe("inbound keywords", () => {
  it("STOP-family words opt out every verified row on that number, disable the recap, and reply once", async () => {
    await seedVerified(A, PHONE_A);
    await seedVerified(B, PHONE_A); // a second member who verified the same number
    for (const word of ["STOP", "stop", "UNSUBSCRIBE", "Cancel", "END", "QUIT", "STOPALL"]) {
      await db.update(recapSettingsTable).set({ optedOutAt: null, enabled: true }).where(inArray(recapSettingsTable.userId, [A.userId, B.userId]));
      _resetFakeSmsForTests();
      const r = await inbound(PHONE_A, word);
      expect(r.status).toBe(200);
      for (const m of [A, B]) {
        const s = await settingsOf(m);
        expect(s.optedOutAt, word).not.toBeNull();
        expect(s.enabled).toBe(false);
      }
      expect(sentSms).toHaveLength(1);
      expect(sentSms[0]).toMatchObject({ to: PHONE_A });
      expect(sentSms[0]!.body).toContain("unsubscribed");
      expect(sentSms[0]!.statusCallbackUrl).toBe(`${BASE}/api/sms/status`);
    }
  });

  it("STOP leaves other numbers alone", async () => {
    await seedVerified(A, PHONE_A);
    await seedVerified(B, PHONE_B);
    await inbound(PHONE_A, "STOP");
    expect((await settingsOf(A)).optedOutAt).not.toBeNull();
    expect((await settingsOf(B)).optedOutAt).toBeNull();
    expect((await settingsOf(B)).enabled).toBe(true);
  });

  it("START / UNSTOP / YES clear the opt-out (recap stays off until re-enabled) and reply; a stray YES says nothing", async () => {
    await seedVerified(A, PHONE_A, { optedOutAt: new Date(), enabled: false });
    await inbound(PHONE_A, "START");
    let s = await settingsOf(A);
    expect(s.optedOutAt).toBeNull();
    expect(s.enabled).toBe(false);
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0]!.body).toContain("back on");

    _resetFakeSmsForTests();
    await inbound(PHONE_A, "YES");
    expect(sentSms).toHaveLength(0);

    await db.update(recapSettingsTable).set({ optedOutAt: new Date() }).where(eq(recapSettingsTable.userId, A.userId));
    await inbound(PHONE_A, "unstop");
    s = await settingsOf(A);
    expect(s.optedOutAt).toBeNull();
  });

  it("HELP replies with the help line and changes nothing", async () => {
    await seedVerified(A, PHONE_A);
    await inbound(PHONE_A, "help");
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0]!.body).toContain("Reply STOP");
    const s = await settingsOf(A);
    expect(s.enabled).toBe(true);
    expect(s.optedOutAt).toBeNull();
  });

  it("an unverified number (settings row without verified_at) is treated as unknown", async () => {
    await seedSettings(A, { phoneE164: PHONE_A, enabled: false });
    await inbound(PHONE_A, "STOP");
    expect(sentSms).toHaveLength(0);
    expect((await settingsOf(A)).optedOutAt).toBeNull();
  });

  it("unknown numbers are dropped (audited as unknown_sender, nothing sent, nothing queued)", async () => {
    const id = sid();
    const r = await inbound(STRANGER, "STOP", id);
    expect(r.status).toBe(200);
    expect(sentSms).toHaveLength(0);
    expect(_emittedForTests).toHaveLength(0);
    const [row] = await db.select().from(smsInboundTable).where(eq(smsInboundTable.providerMessageId, id));
    expect(row).toMatchObject({ action: "unknown_sender", matchedUserId: null, fromE164: STRANGER });
    expect(row!.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("anything else from a verified number is queued as sms.inbound, and the handler records it as unhandled", async () => {
    await seedVerified(A, PHONE_A);
    const id = sid();
    await inbound(PHONE_A, "spent 12 coffee", id);
    expect(sentSms).toHaveLength(0);
    expect(_emittedForTests).toEqual([
      expect.objectContaining({
        queue: "sms.inbound",
        data: { providerMessageId: id, fromE164: PHONE_A, body: "spent 12 coffee" },
        opts: { singletonKey: id },
      }),
    ]);
    await handleSmsInbound([{ data: _emittedForTests[0]!.data } as never]);
    await handleSmsInbound([{ data: _emittedForTests[0]!.data } as never]); // retry: no duplicate row
    const rows = await db.select().from(smsInboundTable).where(eq(smsInboundTable.providerMessageId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "unhandled", matchedUserId: A.userId });
    // Not production: a short preview is kept; the hash is always there.
    expect(rows[0]!.bodyPreview).toBe("spent 12 coffee");
  });

  it("a replayed webhook (same MessageSid) does not reply twice", async () => {
    await seedVerified(A, PHONE_A);
    const id = sid();
    await inbound(PHONE_A, "STOP", id);
    await inbound(PHONE_A, "STOP", id);
    expect(sentSms).toHaveLength(1);
    expect(await db.select().from(smsInboundTable).where(eq(smsInboundTable.providerMessageId, id))).toHaveLength(1);
  });

  it("keeps no body preview in production", async () => {
    await seedVerified(A, PHONE_A);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const id = sid();
    try {
      // production always validates: the default signed post passes.
      await inbound(PHONE_A, "HELP", id);
    } finally {
      process.env.NODE_ENV = env;
    }
    const [row] = await db.select().from(smsInboundTable).where(eq(smsInboundTable.providerMessageId, id));
    expect(row!.bodyPreview).toBeNull();
    expect(row!.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

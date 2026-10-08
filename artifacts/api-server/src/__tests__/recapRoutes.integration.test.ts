import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import { db, recapDeliveriesTable, recapSettingsTable, recapVerificationsTable } from "@workspace/db";
import { pinEnv } from "./_helpers/aiEnv";
import { makeMembers, dropMembers, type TestMember } from "./_helpers/smsFixtures";

// (AI-4b) /recap/*: settings validation, the verify flow (code, expiry, lockout,
// daily starts), test-send cap, pause, unsubscribe, deliveries, and isolation
// between household members.

pinEnv({ SMS_PROVIDER: "fake", SMS_DAILY_SEND_CAP: "10000", SMS_WEBHOOK_BASE_URL: undefined, NODE_ENV: "test" });

let current: TestMember;
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = current.userId;
    req.actualUserId = current.userId;
    req.householdId = current.householdId;
    req.householdOwnerId = current.userId;
    next();
  },
}));

import recapRouter from "../routes/recap";
import { sentSms, _resetFakeSmsForTests, _failNextFakeSms } from "../lib/sms/fake";
import { _resetSmsProviderForTests } from "../lib/sms";

let server: Server;
let base = "";
let A: TestMember, B: TestMember, C: TestMember, D: TestMember;

async function call(as: TestMember, method: string, path: string, body?: unknown) {
  current = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  [A, B, C, D] = await makeMembers(4);
  const app = express();
  app.use(express.json());
  app.use(recapRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await dropMembers([A, B, C, D]);
});
beforeEach(() => {
  _resetFakeSmsForTests();
  _resetSmsProviderForTests();
});

let startedCodeForA = "";
const codeFromLastText = () => /\b(\d{6})\b/.exec(sentSms.at(-1)!.body)![1]!;

describe("settings", () => {
  it("creates defaults on first read (once) and never returns the full number", async () => {
    const r1 = await call(A, "GET", "/recap/settings");
    const r2 = await call(A, "GET", "/recap/settings");
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({
      enabled: false,
      sendTimeLocal: "07:00",
      timezone: "America/Chicago",
      phoneLast4: null,
      verified: false,
      pausedUntil: null,
      skipWeekends: false,
      extraAlerts: false,
      consentedAt: null,
      optedOutAt: null,
      consentTextVersion: expect.any(String),
    });
    expect(r1.json.consentText).toContain("STOP");
    expect(r2.json).toEqual(r1.json);
    const rows = await db.select().from(recapSettingsTable).where(eq(recapSettingsTable.userId, A.userId));
    expect(rows).toHaveLength(1);
  });

  it("validates time zone, time, and refuses to enable without a verified number and consent", async () => {
    expect((await call(A, "PUT", "/recap/settings", { timezone: "Mars/Olympus" })).json.code).toBe("bad_timezone");
    expect((await call(A, "PUT", "/recap/settings", { timezone: "Mars/Olympus" })).status).toBe(400);
    for (const t of ["7:00", "25:00", "07:60", "0700", ""]) {
      expect((await call(A, "PUT", "/recap/settings", { sendTimeLocal: t })).status).toBe(400);
    }
    const off = await call(A, "PUT", "/recap/settings", { enabled: true });
    expect(off.status).toBe(400);
    expect(off.json.code).toBe("not_verified");
    const ok = await call(A, "PUT", "/recap/settings", { sendTimeLocal: "06:30", timezone: "America/New_York", skipWeekends: true });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ sendTimeLocal: "06:30", timezone: "America/New_York", skipWeekends: true, enabled: false });
    // Change it back so the test-send template below starts from the defaults.
    await call(A, "PUT", "/recap/settings", { sendTimeLocal: "07:00", timezone: "America/Chicago", skipWeekends: false });
  });
});

describe("phone verification", () => {
  it("needs consent and a US mobile number", async () => {
    expect((await call(A, "POST", "/recap/verify/start", { phoneE164: "(555) 555-0100", consent: false })).json.code).toBe("consent_required");
    expect((await call(A, "POST", "/recap/verify/start", { phoneE164: "12345", consent: true })).json.code).toBe("bad_phone");
    expect((await call(A, "POST", "/recap/verify/start", {})).status).toBe(400);
    expect(sentSms).toHaveLength(0);
  });

  it("start texts a 6-digit code with the opt-out line and records consent; the code is stored only hashed", async () => {
    const r = await call(A, "POST", "/recap/verify/start", { phoneE164: "(555) 555-0100", consent: true });
    expect(r.status).toBe(200);
    expect(r.json.sent).toBe(true);
    expect(new Date(r.json.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(r.json.devCode).toBeUndefined(); // fake provider, not console
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0]!.to).toBe("+15555550100");
    expect(sentSms[0]!.body).toMatch(/H2 code \d{6}\./);
    expect(sentSms[0]!.body).toContain("Reply STOP");
    const code = codeFromLastText();
    startedCodeForA = code;
    const [v] = await db.select().from(recapVerificationsTable).where(eq(recapVerificationsTable.userId, A.userId));
    expect(v!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(v)).not.toContain(code);
    const s = (await call(A, "GET", "/recap/settings")).json;
    expect(s.consentedAt).not.toBeNull();
    expect(s.verified).toBe(false);
    const [d] = await db.select().from(recapDeliveriesTable).where(and(eq(recapDeliveriesTable.userId, A.userId), eq(recapDeliveriesTable.kind, "verification")));
    expect(d).toMatchObject({ status: "sent", provider: "fake" });
  });

  it("five wrong codes lock the code, even for the right code afterwards", async () => {
    const code = startedCodeForA;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 5; i++) {
      const r = await call(A, "POST", "/recap/verify/confirm", { code: wrong });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("wrong_code");
    }
    const locked = await call(A, "POST", "/recap/verify/confirm", { code });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe("locked");
    expect((await call(A, "GET", "/recap/settings")).json.verified).toBe(false);
  });

  it("a fresh start replaces the code; the right code verifies the number and enabling then works", async () => {
    expect((await call(A, "POST", "/recap/verify/start", { phoneE164: "+15555550100", consent: true })).status).toBe(200);
    const code = codeFromLastText();
    expect((await call(A, "POST", "/recap/verify/confirm", { code: "12345" })).json.code).toBe("bad_code");
    const ok = await call(A, "POST", "/recap/verify/confirm", { code });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ verified: true, phoneLast4: "0100" });
    expect(JSON.stringify(ok.json)).not.toContain("5555550100");
    // The same code cannot be used twice.
    expect((await call(A, "POST", "/recap/verify/confirm", { code })).status).toBe(400);
    const on = await call(A, "PUT", "/recap/settings", { enabled: true });
    expect(on.status).toBe(200);
    expect(on.json.enabled).toBe(true);
  });

  it("an expired code is refused", async () => {
    await call(C, "POST", "/recap/verify/start", { phoneE164: "5555550102", consent: true });
    const code = codeFromLastText();
    await db.update(recapVerificationsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(recapVerificationsTable.userId, C.userId));
    const r = await call(C, "POST", "/recap/verify/confirm", { code });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("expired");
  });

  it("at most 3 starts a day per member", async () => {
    // C already started once (the expiry test).
    expect((await call(C, "POST", "/recap/verify/start", { phoneE164: "5555550102", consent: true })).status).toBe(200);
    expect((await call(C, "POST", "/recap/verify/start", { phoneE164: "5555550102", consent: true })).status).toBe(200);
    const r = await call(C, "POST", "/recap/verify/start", { phoneE164: "5555550102", consent: true });
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("too_many_starts");
    expect(sentSms).toHaveLength(2);
    // Another member is not affected.
    expect((await call(D, "POST", "/recap/verify/start", { phoneE164: "5555550103", consent: true })).status).toBe(200);
  });

  it("answers 502 when the text cannot be sent", async () => {
    _failNextFakeSms(1);
    const r = await call(B, "POST", "/recap/verify/start", { phoneE164: "5555550104", consent: true });
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("send_failed");
  });
});

describe("test-send", () => {
  it("is refused until a number is verified", async () => {
    const r = await call(B, "POST", "/recap/test-send");
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("not_verified");
  });

  it("sends the fixed template rendered with the member's settings, 3 a day", async () => {
    const first = await call(A, "POST", "/recap/test-send");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: "sent", deliveryId: expect.any(String) });
    expect(sentSms.at(-1)).toMatchObject({
      to: "+15555550100",
      body: "H2 test: your morning recap will arrive at 07:00 America/Chicago. Reply STOP to opt out.",
    });
    await call(A, "PUT", "/recap/settings", { sendTimeLocal: "06:30", timezone: "America/New_York" });
    expect((await call(A, "POST", "/recap/test-send")).status).toBe(200);
    expect(sentSms.at(-1)!.body).toBe("H2 test: your morning recap will arrive at 06:30 America/New_York. Reply STOP to opt out.");
    expect((await call(A, "POST", "/recap/test-send")).status).toBe(200);
    const fourth = await call(A, "POST", "/recap/test-send");
    expect(fourth.status).toBe(429);
    expect(fourth.json.code).toBe("test_limit");
    expect(sentSms.filter((m) => m.body.startsWith("H2 test:"))).toHaveLength(3);
  });

  it("simultaneous test-sends cannot slip past the cap", async () => {
    // D verifies, then fires 6 at once.
    await db.update(recapSettingsTable).set({ phoneE164: "+15555550103", verifiedAt: new Date() }).where(eq(recapSettingsTable.userId, D.userId));
    const results = await Promise.all(Array.from({ length: 6 }, () => call(D, "POST", "/recap/test-send")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
  });
});

describe("pause, unsubscribe, deliveries", () => {
  it("pauses until a future time, clears on null or a past time, and refuses nonsense or more than a year", async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const p = await call(A, "POST", "/recap/pause", { until });
    expect(p.status).toBe(200);
    expect(p.json.pausedUntil).toBe(until);
    expect((await call(A, "POST", "/recap/pause", { until: null })).json.pausedUntil).toBeNull();
    await call(A, "POST", "/recap/pause", { until });
    expect((await call(A, "POST", "/recap/pause", { until: new Date(Date.now() - 1000).toISOString() })).json.pausedUntil).toBeNull();
    expect((await call(A, "POST", "/recap/pause", { until: "next tuesday-ish" })).status).toBe(400);
    expect((await call(A, "POST", "/recap/pause", { until: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status).toBe(400);
    expect((await call(A, "POST", "/recap/pause", {})).status).toBe(400);
  });

  it("lists only the caller's own deliveries, newest first, at most 30", async () => {
    const mine = await call(A, "GET", "/recap/deliveries");
    expect(mine.status).toBe(200);
    expect(mine.json.length).toBeGreaterThanOrEqual(4); // 2 verification + 3 tests
    expect(mine.json.every((d: any) => Object.keys(d).sort().join() === "createdAt,forDate,id,kind,status")).toBe(true);
    const times = mine.json.map((d: any) => new Date(d.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((await call(A, "GET", "/recap/deliveries?limit=2")).json).toHaveLength(2);
    expect((await call(A, "GET", "/recap/deliveries?limit=31")).status).toBe(400);
    expect((await call(A, "GET", "/recap/deliveries?limit=0")).status).toBe(400);
  });

  it("members never see each other's settings or deliveries", async () => {
    const aIds = new Set((await call(A, "GET", "/recap/deliveries")).json.map((d: any) => d.id));
    const bList = (await call(B, "GET", "/recap/deliveries")).json;
    expect(bList.every((d: any) => !aIds.has(d.id))).toBe(true);
    const bSettings = (await call(B, "GET", "/recap/settings")).json;
    expect(bSettings.verified).toBe(false);
    expect(bSettings.phoneLast4).toBeNull();
    // A's PUT lands only on A's row.
    await call(A, "PUT", "/recap/settings", { extraAlerts: true });
    expect((await call(B, "GET", "/recap/settings")).json.extraAlerts).toBe(false);
    expect((await call(A, "GET", "/recap/settings")).json.extraAlerts).toBe(true);
    const rows = await db.select().from(recapSettingsTable).where(eq(recapSettingsTable.householdId, B.householdId));
    expect(rows.every((r) => r.userId === B.userId)).toBe(true);
  });

  it("unsubscribe opts out and turns the recap off; enabling and test-send are then refused until re-verified", async () => {
    const u = await call(A, "POST", "/recap/unsubscribe");
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ enabled: false });
    expect(u.json.optedOutAt).not.toBeNull();
    expect((await call(A, "PUT", "/recap/settings", { enabled: true })).json.code).toBe("opted_out");
    expect((await call(A, "POST", "/recap/test-send")).json.code).toBe("opted_out");
    // A fresh verification is fresh consent and lifts the opt-out.
    await call(A, "POST", "/recap/verify/start", { phoneE164: "+15555550100", consent: true });
    // (A has used 2 starts before + this one = 3rd, allowed.)
    const ok = await call(A, "POST", "/recap/verify/confirm", { code: codeFromLastText() });
    expect(ok.status).toBe(200);
    expect(ok.json.optedOutAt).toBeNull();
  });
});

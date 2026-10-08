import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { createHmac } from "node:crypto";
import { LOG_REDACT_PATHS, logger } from "../lib/logger";
import { consoleProvider } from "../lib/sms/console";
import { fakeProvider, sentSms, _resetFakeSmsForTests, _failNextFakeSms } from "../lib/sms/fake";
import { createTwilioProvider, signTwilioRequest, validateTwilioSignature } from "../lib/sms/twilio";
import {
  getSmsConfig,
  getSmsProvider,
  getDailySendCap,
  getStatusCallbackUrl,
  _resetSmsProviderForTests,
} from "../lib/sms";
import { isUsE164, normalizeUsPhone, scrubError } from "../lib/sms/phone";
import { classifyInbound } from "../lib/sms/inbound";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-4b) The provider seam without a database: which provider is chosen, what
// the Twilio adapter sends, signature vectors, the console provider's redacted
// logging, phone normalisation and the keyword classifier.

const KEYS = [
  "SMS_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_FROM",
  "SMS_WEBHOOK_BASE_URL",
  "SMS_DAILY_SEND_CAP",
];
pinEnv(Object.fromEntries(KEYS.map((k) => [k, undefined])));

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  _resetSmsProviderForTests();
  _resetFakeSmsForTests();
});

function fullTwilioEnv(): void {
  process.env.SMS_PROVIDER = "twilio";
  process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MG00000000000000000000000000000000";
  process.env.SMS_WEBHOOK_BASE_URL = "https://h2.example.test/";
}

describe("provider selection", () => {
  it("defaults to console and reports it configured", () => {
    expect(getSmsConfig()).toEqual({ provider: "console", configured: true });
    expect(getSmsProvider().name).toBe("console");
  });

  it("twilio needs sid, token, a sender and the webhook base URL; anything missing falls back to console and never throws", () => {
    process.env.SMS_PROVIDER = "twilio";
    expect(getSmsConfig()).toEqual({ provider: "twilio", configured: false });
    expect(() => getSmsProvider()).not.toThrow();
    expect(getSmsProvider().name).toBe("console");

    fullTwilioEnv();
    delete process.env.SMS_WEBHOOK_BASE_URL;
    expect(getSmsConfig().configured).toBe(false);
    expect(getSmsProvider().name).toBe("console");

    fullTwilioEnv();
    expect(getSmsConfig()).toEqual({ provider: "twilio", configured: true });
    expect(getSmsProvider().name).toBe("twilio");
    expect(getStatusCallbackUrl()).toBe("https://h2.example.test/api/sms/status");
  });

  it("a sending number can stand in for the messaging service", () => {
    fullTwilioEnv();
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    expect(getSmsConfig().configured).toBe(false);
    process.env.TWILIO_FROM = "+15555550199";
    expect(getSmsConfig().configured).toBe(true);
  });

  it("the fake provider is refused in production", () => {
    process.env.SMS_PROVIDER = "fake";
    expect(getSmsProvider().name).toBe("fake");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(getSmsProvider().name).toBe("console");
      expect(getSmsConfig()).toEqual({ provider: "fake", configured: false });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("the daily cap defaults to 50 and reads SMS_DAILY_SEND_CAP", () => {
    expect(getDailySendCap()).toBe(50);
    process.env.SMS_DAILY_SEND_CAP = "7";
    expect(getDailySendCap()).toBe(7);
    process.env.SMS_DAILY_SEND_CAP = "nonsense";
    expect(getDailySendCap()).toBe(50);
    process.env.SMS_DAILY_SEND_CAP = "0";
    expect(getDailySendCap()).toBe(0);
  });
});

describe("fake and console providers", () => {
  it("fake records what it was asked to send and can be told to fail", async () => {
    const r = await fakeProvider.send({ to: "+15555550100", body: "hi", idempotencyKey: "k1" });
    expect(r.providerId).toBe("fake_1");
    expect(sentSms).toEqual([{ to: "+15555550100", body: "hi", idempotencyKey: "k1" }]);
    _failNextFakeSms();
    await expect(fakeProvider.send({ to: "+15555550100", body: "x", idempotencyKey: "k2" })).rejects.toThrow();
    expect(sentSms).toHaveLength(1);
  });

  it("console logs under the `sms` key (whose to/body the logger redacts) and returns a stable id", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation((() => {}) as never);
    const a = await consoleProvider.send({ to: "+15555550100", body: "secret words", idempotencyKey: "k" });
    const b = await consoleProvider.send({ to: "+15555550100", body: "secret words", idempotencyKey: "k" });
    expect(a.providerId).toBe(b.providerId);
    const [obj] = spy.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(obj)).toEqual(["sms"]);
    expect(obj.sms).toMatchObject({ to: "+15555550100", body: "secret words" });
    spy.mockRestore();
  });

  it("the logger's redact paths remove sms.to and sms.body from real output", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const l = pino({ redact: LOG_REDACT_PATHS }, sink);
    l.info({ sms: { to: "+15555550100", body: "secret words", idempotencyKey: "k" } }, "sms");
    const out = lines.join("");
    expect(out).not.toContain("+15555550100");
    expect(out).not.toContain("secret words");
    expect(out).toContain("[Redacted]");
    expect(out).toContain('"idempotencyKey":"k"');
  });
});

describe("twilio adapter", () => {
  it("sends the exact params through a messaging service, with the per-message status callback", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM1" });
    const p = createTwilioProvider(
      { accountSid: "AC1", authToken: "t", messagingServiceSid: "MG1", from: "+15555550199" },
      { messages: { create } },
    );
    const r = await p.send({
      to: "+15555550100",
      body: "hello",
      idempotencyKey: "k",
      statusCallbackUrl: "https://h2.example.test/api/sms/status",
    });
    expect(r).toEqual({ providerId: "SM1" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      to: "+15555550100",
      body: "hello",
      messagingServiceSid: "MG1",
      statusCallback: "https://h2.example.test/api/sms/status",
    });
  });

  it("falls back to `from` and omits statusCallback when none is given", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM2" });
    const p = createTwilioProvider({ accountSid: "AC1", authToken: "t", from: "+15555550199" }, { messages: { create } });
    await p.send({ to: "+15555550100", body: "hello", idempotencyKey: "k" });
    expect(create).toHaveBeenCalledWith({ to: "+15555550100", body: "hello", from: "+15555550199" });
  });

  it("refuses to build with no sender, and passes a client error through", async () => {
    expect(() => createTwilioProvider({ accountSid: "AC1", authToken: "t" })).toThrow(/TWILIO_MESSAGING_SERVICE_SID/);
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const p = createTwilioProvider({ accountSid: "AC1", authToken: "t", from: "+15555550199" }, { messages: { create } });
    await expect(p.send({ to: "+15555550100", body: "x", idempotencyKey: "k" })).rejects.toThrow("boom");
  });
});

describe("twilio signature (validateRequest wired)", () => {
  const token = "test-auth-token";
  const url = "https://h2.example.test/api/sms/inbound";
  const params = { MessageSid: "SM1", From: "+15555550100", Body: "STOP" };

  it("accepts the signature Twilio would compute", () => {
    expect(validateTwilioSignature(token, signTwilioRequest(token, url, params), url, params)).toBe(true);
  });

  it("is the documented algorithm: base64 HMAC-SHA1 of the url plus the sorted name+value pairs", () => {
    const u = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const p = { Digits: "1234", To: "+18005551212", From: "+14158675310", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" };
    const data = u + Object.keys(p).sort().map((k) => k + (p as Record<string, string>)[k]).join("");
    const sig = createHmac("sha1", "12345").update(Buffer.from(data, "utf-8")).digest("base64");
    expect(validateTwilioSignature("12345", sig, u, p)).toBe(true);
    expect(validateTwilioSignature("12345", sig, u, { ...p, Digits: "1235" })).toBe(false);
  });

  it("rejects a changed param, a changed url, the wrong token, garbage and an empty signature", () => {
    const sig = signTwilioRequest(token, url, params);
    expect(validateTwilioSignature(token, sig, url, { ...params, Body: "START" })).toBe(false);
    expect(validateTwilioSignature(token, sig, `${url}?x=1`, params)).toBe(false);
    expect(validateTwilioSignature("other-token", sig, url, params)).toBe(false);
    expect(validateTwilioSignature(token, "not-a-signature", url, params)).toBe(false);
    expect(validateTwilioSignature(token, "", url, params)).toBe(false);
  });
});

describe("phone helpers and keywords", () => {
  it("normalises common US formats to E.164 and refuses the rest", () => {
    for (const ok of ["(555) 555-0100", "555-555-0100", "5555550100", "15555550100", "+1 555 555 0100", "+15555550100"]) {
      expect(normalizeUsPhone(ok)).toBe("+15555550100");
    }
    for (const bad of ["", "12345", "+442071838750", "+10555550100", "+15551550100", "abc", "+155555501000"]) {
      expect(normalizeUsPhone(bad)).toBeNull();
    }
    expect(isUsE164("+15555550100")).toBe(true);
    expect(isUsE164("5555550100")).toBe(false);
  });

  it("scrubs anything number-like out of a provider error", () => {
    expect(scrubError("Unable to create record: The 'To' number +15555550100 is not valid")).not.toMatch(/5555550100/);
    expect(scrubError("code 21610")).toBe("code 21610");
  });

  it("classifies the opt-out, opt-in and help keywords (case, spaces, trailing punctuation)", () => {
    for (const w of ["STOP", "stop", " Stop ", "STOPALL", "UNSUBSCRIBE", "cancel", "END", "quit", "Stop."]) {
      expect(classifyInbound(w)).toBe("stop");
    }
    for (const w of ["START", "unstop", "Yes", "yes!"]) expect(classifyInbound(w)).toBe("start");
    expect(classifyInbound("help")).toBe("help");
    for (const w of ["spent 12 coffee", "please stop sending", "stopping", "", "?"]) expect(classifyInbound(w)).toBe("other");
  });
});

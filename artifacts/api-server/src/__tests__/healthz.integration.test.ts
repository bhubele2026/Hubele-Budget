import { describe, it, expect, beforeEach } from "vitest";
import healthRouter from "../routes/health";
import { createTestApp } from "./_helpers/createTestApp";
import { _resetJobsHealthCacheForTests } from "../jobs/boss";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-0) /api/healthz reports jobs, AI and SMS as booleans and counts only,
// and still answers 200 when job state cannot be read.

pinEnv({
  JOBS_MODE: undefined,
  PGBOSS_SCHEMA: "pgboss_health_absent",
  AI_PROVIDER: "fake",
  AI_ENABLED: "true",
  ANTHROPIC_API_KEY: "sk-ant-secret-value-must-not-leak",
  SMS_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: "AC-secret-sid",
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_MESSAGING_SERVICE_SID: undefined,
});

const { request } = createTestApp(healthRouter);

beforeEach(() => _resetJobsHealthCacheForTests());

describe("GET /healthz", () => {
  it("has the full shape, with no secret anywhere in the body", async () => {
    const { status, json } = await request("GET", "/healthz");
    expect(status).toBe(200);
    expect(json).toEqual({
      status: "ok",
      version: expect.any(String),
      jobs: { mode: "off", started: false, failedLast24h: 0, dlq: 0 },
      ai: { enabled: true, configured: true, provider: "fake" },
      sms: { provider: "twilio", configured: false },
    });
    const body = JSON.stringify(json);
    expect(body).not.toContain("sk-ant");
    expect(body).not.toContain("AC-secret");
  });

  it("stays 200 with null counts when the job tables cannot be read", async () => {
    process.env.PGBOSS_SCHEMA = "Not A Valid Schema";
    const { status, json } = await request("GET", "/healthz");
    process.env.PGBOSS_SCHEMA = "pgboss_health_absent";
    expect(status).toBe(200);
    expect((json as { jobs: unknown }).jobs).toEqual({ mode: "off", started: false, failedLast24h: null, dlq: null });
  });

  it("reports sms console as the default provider and AI off when AI_ENABLED is not true", async () => {
    delete process.env.SMS_PROVIDER;
    process.env.AI_ENABLED = "false";
    const { json } = await request("GET", "/healthz");
    process.env.SMS_PROVIDER = "twilio";
    process.env.AI_ENABLED = "true";
    expect(json).toMatchObject({ ai: { enabled: false }, sms: { provider: "console", configured: true } });
  });

  it("reports twilio as configured only when sid, token, a sender and the webhook base URL are all set", async () => {
    process.env.TWILIO_AUTH_TOKEN = "t";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    try {
      // No webhook base URL yet: status callbacks and signature checks would not work.
      const missing = await request("GET", "/healthz");
      expect((missing.json as { sms: unknown }).sms).toEqual({ provider: "twilio", configured: false });
      process.env.SMS_WEBHOOK_BASE_URL = "https://h2.example.test";
      const { json } = await request("GET", "/healthz");
      expect((json as { sms: unknown }).sms).toEqual({ provider: "twilio", configured: true });
      expect(JSON.stringify(json)).not.toContain("MG1");
    } finally {
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      delete process.env.SMS_WEBHOOK_BASE_URL;
    }
  });
});

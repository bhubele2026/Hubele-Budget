import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { db, aiUsageTable, aiTaskConfigTable, aiBudgetTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { runStructured } from "../ai/structured";
import { queueFakeSteps, resetFake, fakeCalls, registerFakeFixture } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";
import { PingOutput, pingV1 } from "../ai/prompts/ping.v1";
import { createTestHousehold } from "./_helpers/testHousehold";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-0) runStructured end to end on the fake provider and a real Postgres:
// what it returns, what it retries, and the ai_usage row every attempt leaves.

pinEnv({ AI_PROVIDER: "fake", AI_ENABLED: "true", AI_PAUSED: undefined, AI_MODEL_CHAT: undefined });

const OWNER = `test-ai-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH: string;

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
});
afterAll(async () => {
  await db.delete(aiUsageTable).where(eq(aiUsageTable.householdId, HH));
  await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, HH));
  await db.delete(aiTaskConfigTable).where(eq(aiTaskConfigTable.task, "chat"));
  invalidateTaskConfigCache();
});
beforeEach(async () => {
  resetFake();
  invalidateTaskConfigCache();
  await db.delete(aiUsageTable).where(eq(aiUsageTable.householdId, HH));
  await db.delete(aiTaskConfigTable).where(eq(aiTaskConfigTable.task, "chat"));
});

const ping = (word = "hello", validate?: (v: PingOutput) => string | null) =>
  runStructured<PingOutput>({
    task: "chat",
    householdId: HH,
    promptVersion: pingV1.PROMPT_VERSION,
    schema: PingOutput,
    system: pingV1.system,
    messages: pingV1.build({ word }),
    ...(validate ? { validate } : {}),
  });

const rows = () =>
  db.select().from(aiUsageTable).where(eq(aiUsageTable.householdId, HH)).orderBy(asc(aiUsageTable.createdAt));

describe("runStructured (fake provider)", () => {
  it("returns the validated value, labelled demo, and writes one ok row", async () => {
    queueFakeSteps("chat", { kind: "ok", value: { echo: "hello" }, usage: { inputTokens: 50, outputTokens: 7 } });
    const r = await ping();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ echo: "hello" });
    expect(r.demo).toBe(true);
    expect(r.usage).toMatchObject({ attempts: 1, inputTokens: 50, outputTokens: 7, costUsd: 0, provider: "fake" });
    const rs = await rows();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ task: "chat", status: "ok", model: "fake", promptVersion: "ping.v1", inputTokens: 50, outputTokens: 7, costUsd: "0.000000" });
    expect(rs[0]!.requestId).toMatch(/^fake_/);
    // The model saw the system text as given and the word wrapped as data.
    expect(fakeCalls[0]!.system).toBe(pingV1.system);
    expect(fakeCalls[0]!.messages[0]!.content).toBe('<untrusted source="word">hello</untrusted>');
    expect(fakeCalls[0]!.effort).toBe("low");
    expect(fakeCalls[0]!.model).toBe("claude-opus-5-5");
  });

  it("output that does not decode is retried ONCE, then succeeds — two rows", async () => {
    queueFakeSteps("chat", { kind: "text", text: "{not json" }, { kind: "ok", value: { echo: "hello" } });
    const r = await ping();
    expect(r.ok).toBe(true);
    expect(r.ok && r.usage.attempts).toBe(2);
    expect((await rows()).map((x) => x.status)).toEqual(["parse_failed", "ok"]);
  });

  it("output that breaks the schema counts as parse_failed and is retried once; two failures fail", async () => {
    queueFakeSteps(
      "chat",
      { kind: "ok", value: { echo: "x".repeat(80) } }, // breaks .max(40)
      { kind: "text", text: "still not json" },
      { kind: "ok", value: { echo: "never reached" } },
    );
    const r = await ping();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe("parse_failed");
    expect(r.usage?.attempts).toBe(2);
    expect((await rows()).map((x) => x.status)).toEqual(["parse_failed", "parse_failed"]);
    expect(fakeCalls).toHaveLength(2);
  });

  it("business validation rejects a well-formed value — validation_failed, not retried", async () => {
    queueFakeSteps("chat", { kind: "ok", value: { echo: "goodbye" } });
    const r = await ping("hello", (v) => (v.echo === "hello" ? null : "echo must equal the word sent"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toMatchObject({ kind: "validation_failed", message: "echo must equal the word sent", retryable: false });
    expect((await rows()).map((x) => x.status)).toEqual(["validation_failed"]);
  });

  it("a refusal is never retried", async () => {
    queueFakeSteps("chat", { kind: "refusal" }, { kind: "ok", value: { echo: "hello" } });
    const r = await ping();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.failure.kind).toBe("refusal");
    expect(fakeCalls).toHaveLength(1);
    expect((await rows()).map((x) => x.status)).toEqual(["refusal"]);
  });

  it("a max_tokens cut is reported, not retried", async () => {
    queueFakeSteps("chat", { kind: "max_tokens" });
    const r = await ping();
    expect(!r.ok && r.failure.kind).toBe("max_tokens");
    expect(fakeCalls).toHaveLength(1);
  });

  it("SDK errors map to kinds and leave a row with the request id", async () => {
    queueFakeSteps("chat", {
      kind: "throw",
      error: new Anthropic.RateLimitError(429, {}, "rate limited", new Headers({ "request-id": "req_rl_1" })),
    });
    const r = await ping();
    expect(!r.ok && r.failure).toMatchObject({ kind: "rate_limited", retryable: true, requestId: "req_rl_1" });
    const rs = await rows();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ status: "rate_limited", requestId: "req_rl_1", costUsd: null });

    queueFakeSteps("chat", { kind: "throw", error: new Anthropic.APIConnectionTimeoutError({ message: "t" }) });
    const t = await ping();
    expect(!t.ok && t.failure.kind).toBe("timeout");
  });

  it("disabled: AI_ENABLED off, or the task turned off in ai_task_config — no call, no row", async () => {
    process.env.AI_ENABLED = "false";
    const off = await ping();
    process.env.AI_ENABLED = "true";
    expect(!off.ok && off.failure.kind).toBe("disabled");

    await db.insert(aiTaskConfigTable).values({ task: "chat", enabled: false, updatedBy: "test" });
    invalidateTaskConfigCache();
    const taskOff = await ping();
    expect(!taskOff.ok && taskOff.failure).toMatchObject({ kind: "disabled", message: "AI task chat is turned off" });
    expect(fakeCalls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("ai_task_config model/effort reach the call", async () => {
    await db.insert(aiTaskConfigTable).values({ task: "chat", model: "claude-sonnet-5-5", effort: "medium", enabled: true });
    invalidateTaskConfigCache();
    queueFakeSteps("chat", { kind: "ok", value: { echo: "hello" } });
    await ping();
    expect(fakeCalls[0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
  });

  it("budget_exceeded: a paused household is blocked before any call, with one zero-cost row", async () => {
    await db
      .insert(aiBudgetTable)
      .values({ householdId: HH, pausedUntil: new Date(Date.now() + 3_600_000) })
      .onConflictDoUpdate({ target: aiBudgetTable.householdId, set: { pausedUntil: new Date(Date.now() + 3_600_000) } });
    const r = await ping();
    await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, HH));
    expect(!r.ok && r.failure.kind).toBe("budget_exceeded");
    expect(fakeCalls).toHaveLength(0);
    const rs = await rows();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ status: "budget_exceeded", costUsd: "0.000000", inputTokens: null });
  });

  it("a registered fixture answers when nothing is queued (demo mode)", async () => {
    registerFakeFixture("chat", (call) => ({ echo: String(call.messages.length) }));
    const r = await ping();
    expect(r.ok && r.value).toEqual({ echo: "1" });
  });
});

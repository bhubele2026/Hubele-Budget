import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, aiTaskConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getTaskConfig, invalidateTaskConfigCache, DEFAULT_TASK_CONFIG, TASK_CONFIG_CACHE_MS } from "../ai/config";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-0) Per-task config: ai_task_config row → env → defaults, with the row
// cached in-process for 60 s.

pinEnv({ AI_MODEL_RECAP: undefined, AI_EFFORT_RECAP: undefined, AI_MODEL_RECEIPT: undefined });

beforeEach(async () => {
  await db.delete(aiTaskConfigTable).where(eq(aiTaskConfigTable.task, "recap"));
  invalidateTaskConfigCache();
  delete process.env.AI_MODEL_RECAP;
  delete process.env.AI_EFFORT_RECAP;
});
afterAll(async () => {
  await db.delete(aiTaskConfigTable).where(eq(aiTaskConfigTable.task, "recap"));
  invalidateTaskConfigCache();
});

describe("getTaskConfig", () => {
  it("defaults: claude-opus-5-5, effort low, 4096 tokens, 60 s, 2 retries, 8 iterations", async () => {
    const c = await getTaskConfig("recap");
    expect(c).toMatchObject({
      model: "claude-opus-5-5",
      effort: "low",
      maxTokens: 4096,
      timeoutMs: 60_000,
      maxRetries: 2,
      maxIterations: 8,
      enabled: true,
      source: { model: "default", effort: "default" },
    });
    expect(DEFAULT_TASK_CONFIG.model).toBe("claude-opus-5-5");
    expect((await getTaskConfig("sms_question")).maxIterations).toBe(4);
  });

  it("env AI_MODEL_<TASK> / AI_EFFORT_<TASK> beat the defaults; a bad effort is ignored", async () => {
    process.env.AI_MODEL_RECAP = "claude-haiku-4-5";
    process.env.AI_EFFORT_RECAP = "medium";
    expect(await getTaskConfig("recap")).toMatchObject({ model: "claude-haiku-4-5", effort: "medium", source: { model: "env", effort: "env" } });
    process.env.AI_EFFORT_RECAP = "ludicrous";
    expect((await getTaskConfig("recap")).effort).toBe("low");
    // Other tasks are untouched.
    expect((await getTaskConfig("receipt")).model).toBe("claude-opus-5-5");
  });

  it("an ai_task_config row beats env, and is cached for 60 s", async () => {
    process.env.AI_MODEL_RECAP = "claude-haiku-4-5";
    const t0 = 1_000_000;
    await db.insert(aiTaskConfigTable).values({ task: "recap", model: "claude-sonnet-5-5", effort: "high", updatedBy: "test" });
    const c = await getTaskConfig("recap", t0);
    expect(c).toMatchObject({ model: "claude-sonnet-5-5", effort: "high", source: { model: "db", effort: "db" } });

    await db.update(aiTaskConfigTable).set({ model: "claude-opus-5-5", enabled: false }).where(eq(aiTaskConfigTable.task, "recap"));
    // Inside the cache window the old row still answers…
    expect((await getTaskConfig("recap", t0 + TASK_CONFIG_CACHE_MS - 1)).model).toBe("claude-sonnet-5-5");
    // …after it, the new one does.
    const later = await getTaskConfig("recap", t0 + TASK_CONFIG_CACHE_MS);
    expect(later).toMatchObject({ model: "claude-opus-5-5", enabled: false });
  });

  it("a row with a null model falls through to env for the model only", async () => {
    process.env.AI_MODEL_RECAP = "claude-haiku-4-5";
    await db.insert(aiTaskConfigTable).values({ task: "recap", model: null, effort: "high" });
    expect(await getTaskConfig("recap")).toMatchObject({ model: "claude-haiku-4-5", effort: "high", source: { model: "env", effort: "db" } });
  });
});

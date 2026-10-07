import type Anthropic from "@anthropic-ai/sdk";
import type * as z from "zod/v4";
import { logger } from "../lib/logger";
import { assertBudget } from "./budget";
import { getProvider, isAiEnabled } from "./client";
import { getTaskConfig, type AiTask } from "./config";
import { classifyError } from "./errors";
import { costUsd } from "./prices";
import { ref } from "./redact";
import type { AiFailureInfo, AiResult, AiUsageSummary } from "./types";
import { AiFailure } from "./types";
import { recordUsage, type AiUsageStatus } from "./usage";

// (AI-0) The one way a structured model call is made.
//
//   enabled? → assertBudget → call (system block cached) →
//   output did not decode (parsed_output null) → parse_failed, ONE retry →
//   zod (code validates every output) → validate(value) → AiResult
//
// A refusal is never retried; a max_tokens cut is not retried either (the
// same request would be cut again). Every attempt writes one ai_usage row;
// a call the budget blocks writes one zero-cost row. Nothing about the
// prompt or the answer is logged — task, status, counts and a hashed
// household reference only.

export interface RunStructuredArgs<T> {
  task: AiTask;
  /** The household paying for the call; null only for household-less tasks (eval_judge). */
  householdId: string | null;
  runId?: string | null;
  promptVersion?: string | null;
  /** zod/v4 schema (see aiZodHelpers.smoke.test.ts — bare `zod` is refused by the SDK helper). */
  schema: z.ZodType<T>;
  system: string;
  messages: Anthropic.MessageParam[];
  /** Business validation. Return an error string to reject the value, or null to accept it. */
  validate?: (value: T) => string | null;
}

const MAX_ATTEMPTS = 2; // the first try + one retry, for undecodable output only

function emptyUsage(model: string, provider: "anthropic" | "fake"): AiUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    attempts: 0,
    model,
    provider,
  };
}

function fail<T>(failure: AiFailureInfo, usage?: AiUsageSummary): AiResult<T> {
  return usage && usage.attempts > 0 ? { ok: false, failure, usage } : { ok: false, failure };
}

export async function runStructured<T>(args: RunStructuredArgs<T>): Promise<AiResult<T>> {
  const { task, householdId } = args;
  const hh = ref("household", householdId);

  if (!isAiEnabled()) {
    return fail({ kind: "disabled", retryable: false, message: "AI is turned off" });
  }
  const cfg = await getTaskConfig(task);
  if (!cfg.enabled) {
    return fail({ kind: "disabled", retryable: false, message: `AI task ${task} is turned off` });
  }

  const provider = getProvider();
  const total = emptyUsage(cfg.model, provider.name);
  const row = {
    householdId,
    task,
    promptVersion: args.promptVersion ?? null,
    runId: args.runId ?? null,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await assertBudget(householdId, task);
    } catch (err) {
      const failure = classifyError(err);
      if (err instanceof AiFailure && err.kind === "budget_exceeded") {
        await recordUsage({ ...row, model: cfg.model, costUsd: 0, status: "budget_exceeded" });
      }
      logger.info({ ai: { task, household: hh, status: failure.kind } }, "AI call blocked");
      return fail(failure, total);
    }

    const t0 = Date.now();
    let res;
    try {
      res = await provider.callStructured({
        task,
        model: cfg.model,
        effort: cfg.effort,
        maxTokens: cfg.maxTokens,
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
        system: args.system,
        messages: args.messages,
        schema: args.schema,
      });
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const failure = classifyError(err);
      total.attempts += 1;
      total.latencyMs += latencyMs;
      await recordUsage({
        ...row,
        model: cfg.model,
        costUsd: null,
        latencyMs,
        status: failure.kind,
        requestId: failure.requestId ?? null,
      });
      logger.warn({ ai: { task, household: hh, status: failure.kind, latencyMs } }, "AI call failed");
      return fail(failure, total);
    }

    const latencyMs = Date.now() - t0;
    const cost = res.demo ? 0 : costUsd(res.model, res.usage);
    total.attempts += 1;
    total.latencyMs += latencyMs;
    total.model = res.model;
    total.inputTokens += res.usage.inputTokens;
    total.outputTokens += res.usage.outputTokens;
    total.cacheWriteTokens += res.usage.cacheWriteTokens;
    total.cacheReadTokens += res.usage.cacheReadTokens;
    total.costUsd = total.costUsd === null || cost === null ? null : Math.round((total.costUsd + cost) * 1e6) / 1e6;

    let status: AiUsageStatus = "ok";
    let failure: AiFailureInfo | null = null;
    let value: T | undefined;

    if (res.stopReason === "refusal") {
      status = "refusal";
      failure = { kind: "refusal", retryable: false, message: "The model declined this request" };
    } else if (res.stopReason === "max_tokens" || res.stopReason === "model_context_window_exceeded") {
      status = "max_tokens";
      failure = { kind: "max_tokens", retryable: false, message: `Output cut off (${res.stopReason})` };
    } else if (res.parsed === null) {
      status = "parse_failed";
      failure = { kind: "parse_failed", retryable: false, message: `Output did not decode: ${res.parseError ?? "unknown"}` };
    } else {
      const checked = args.schema.safeParse(res.parsed);
      if (!checked.success) {
        status = "parse_failed";
        const first = checked.error.issues[0];
        failure = {
          kind: "parse_failed",
          retryable: false,
          message: `Output did not match the schema${first ? ` at ${first.path.join(".") || "(root)"}: ${first.message}` : ""}`,
        };
      } else {
        value = checked.data;
        const verdict = args.validate ? args.validate(checked.data) : null;
        if (verdict) {
          status = "validation_failed";
          failure = { kind: "validation_failed", retryable: false, message: verdict };
        }
      }
    }
    if (failure && res.requestId) failure.requestId = res.requestId;

    await recordUsage({
      ...row,
      model: res.model,
      usage: res.usage,
      costUsd: cost,
      latencyMs,
      status,
      requestId: res.requestId,
    });
    logger.info(
      {
        ai: {
          task,
          household: hh,
          status,
          attempt,
          model: res.model,
          latencyMs,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          cacheReadTokens: res.usage.cacheReadTokens,
          costUsd: cost,
        },
      },
      "AI call",
    );

    if (status === "parse_failed" && attempt < MAX_ATTEMPTS) continue;
    if (failure) return fail(failure, total);
    return { ok: true, value: value as T, usage: total, demo: res.demo };
  }
  // Unreachable: the loop always returns on its last attempt.
  return fail({ kind: "parse_failed", retryable: false, message: "No attempt succeeded" }, total);
}

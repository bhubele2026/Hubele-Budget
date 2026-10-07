import { db, aiTaskConfigTable, type AiTaskConfigRow } from "@workspace/db";
import { logger } from "../lib/logger";

// (AI-0) Every AI task the program will run, and how each one is tuned.
// Resolution order, per field: ai_task_config row (60 s in-process cache)
// → env AI_MODEL_<TASK> / AI_EFFORT_<TASK> → the defaults below. Only model,
// effort and on/off are owner-tunable without a deploy; token, time and
// iteration bounds are code.

export const TASKS = [
  "categorize",
  "chat",
  "recap",
  "receipt",
  "sms_question",
  "eval_judge",
] as const;
export type AiTask = (typeof TASKS)[number];

export function isAiTask(v: unknown): v is AiTask {
  return typeof v === "string" && (TASKS as readonly string[]).includes(v);
}

// Effort is the spend dial on claude-opus-5-5 (thinking is always on there).
// Bounded to the three levels the program budgets for.
export const EFFORTS = ["low", "medium", "high"] as const;
export type AiEffort = (typeof EFFORTS)[number];

function isEffort(v: unknown): v is AiEffort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

export interface TaskConfig {
  task: AiTask;
  model: string;
  effort: AiEffort;
  maxTokens: number;
  timeoutMs: number;
  /** SDK-level retries on 408/409/429/5xx/connection errors. */
  maxRetries: number;
  /** Tool-runner turn cap (used by the agent packages). */
  maxIterations: number;
  /** ai_task_config.enabled; a disabled task answers `disabled`. */
  enabled: boolean;
  source: { model: ConfigSource; effort: ConfigSource };
}
export type ConfigSource = "db" | "env" | "default";

export const DEFAULT_TASK_CONFIG = {
  model: "claude-opus-5-5",
  effort: "low" as AiEffort,
  maxTokens: 4096,
  timeoutMs: 60_000,
  maxRetries: 2,
  maxIterations: 8,
} as const;

// The plan caps an SMS question's agent run at 4 turns (chat keeps 8).
const PER_TASK_DEFAULTS: Partial<
  Record<AiTask, Partial<Omit<TaskConfig, "task" | "source" | "enabled">>>
> = {
  sms_question: { maxIterations: 4 },
};

export const TASK_CONFIG_CACHE_MS = 60_000;
let cache: { at: number; rows: Map<string, AiTaskConfigRow> } | null = null;

/** Drop the in-process copy of ai_task_config (tests; after an owner edit). */
export function invalidateTaskConfigCache(): void {
  cache = null;
}

async function loadRows(nowMs: number): Promise<Map<string, AiTaskConfigRow>> {
  if (cache && nowMs - cache.at < TASK_CONFIG_CACHE_MS) return cache.rows;
  try {
    const rows = await db.select().from(aiTaskConfigTable);
    cache = { at: nowMs, rows: new Map(rows.map((r) => [r.task, r])) };
  } catch (err) {
    // A config read must never take AI down with it: fall back to env and
    // defaults, and try the table again next call.
    logger.warn({ err }, "ai_task_config read failed — using env/defaults");
    return new Map();
  }
  return cache.rows;
}

function envKey(prefix: string, task: AiTask): string {
  return `${prefix}_${task.toUpperCase()}`;
}

export async function getTaskConfig(
  task: AiTask,
  nowMs: number = Date.now(),
): Promise<TaskConfig> {
  const row = (await loadRows(nowMs)).get(task);
  const base = { ...DEFAULT_TASK_CONFIG, ...(PER_TASK_DEFAULTS[task] ?? {}) };

  let model: string = base.model;
  let modelSource: ConfigSource = "default";
  const envModel = process.env[envKey("AI_MODEL", task)]?.trim();
  if (row?.model?.trim()) {
    model = row.model.trim();
    modelSource = "db";
  } else if (envModel) {
    model = envModel;
    modelSource = "env";
  }

  let effort: AiEffort = base.effort;
  let effortSource: ConfigSource = "default";
  const envEffort = process.env[envKey("AI_EFFORT", task)]?.trim().toLowerCase();
  if (row?.effort && isEffort(row.effort)) {
    effort = row.effort;
    effortSource = "db";
  } else {
    if (row?.effort) {
      logger.warn({ task, effort: row.effort }, "ai_task_config.effort is not low|medium|high — ignored");
    }
    if (envEffort && isEffort(envEffort)) {
      effort = envEffort;
      effortSource = "env";
    } else if (envEffort) {
      logger.warn({ task, effort: envEffort }, `${envKey("AI_EFFORT", task)} is not low|medium|high — ignored`);
    }
  }

  return {
    task,
    model,
    effort,
    maxTokens: base.maxTokens,
    timeoutMs: base.timeoutMs,
    maxRetries: base.maxRetries,
    maxIterations: base.maxIterations,
    enabled: row ? row.enabled : true,
    source: { model: modelSource, effort: effortSource },
  };
}

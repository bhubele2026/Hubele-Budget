import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  uuid,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// (AI-0) The AI platform's three tables. The SQL twin of this file is
// lib/db/migrations/0010_ai_core.sql — the two must agree column for column
// (aiSchemaParity.integration.test.ts checks it).
//
// The law these serve: code computes every figure. A model may classify,
// extract, draft or propose; it never writes money. Every call is bounded
// (ai_budget), logged (ai_usage) and configurable without a deploy
// (ai_task_config). No foreign keys on purpose: ai_usage is an append-only
// cost ledger that must survive the rows it talks about, and both other
// tables are keyed by values (a household id, a task name) that are checked
// in code before any call.

// One row per API attempt (a parse retry is a second row). Blocked calls
// (budget_exceeded) are written too, at zero cost, so the cost screen can show
// them; they never count toward a daily cap.
export const aiUsageTable = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id"),
    task: text("task").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version"),
    runId: uuid("run_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    // null when the model is not in the price table — never a guess.
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
    // "ok" or an AiFailure kind (parse_failed, refusal, rate_limited, …).
    status: text("status").notNull(),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    householdCreatedIdx: index("ai_usage_household_created_idx").on(
      t.householdId,
      t.createdAt,
    ),
  }),
);
export type AiUsageRow = typeof aiUsageTable.$inferSelect;

// Per-household caps. No row = the defaults in code (25 soft / 40 hard /
// the default daily caps). `paused_until` is the per-household kill switch.
export const aiBudgetTable = pgTable("ai_budget", {
  householdId: uuid("household_id").primaryKey(),
  monthlyCapUsd: numeric("monthly_cap_usd", { precision: 10, scale: 2 })
    .notNull()
    .default("25"),
  hardCapUsd: numeric("hard_cap_usd", { precision: 10, scale: 2 })
    .notNull()
    .default("40"),
  // { "<task>": <calls per UTC day> } — merged over the defaults in code.
  dailyCaps: jsonb("daily_caps"),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
export type AiBudgetRow = typeof aiBudgetTable.$inferSelect;

// Per-task overrides (model, effort, on/off) that beat env and defaults.
// Read through a 60 s in-process cache (ai/config.ts).
export const aiTaskConfigTable = pgTable("ai_task_config", {
  task: text("task").primaryKey(),
  model: text("model"),
  effort: text("effort"),
  enabled: boolean("enabled").notNull().default(true),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
export type AiTaskConfigRow = typeof aiTaskConfigTable.$inferSelect;

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
  uniqueIndex,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { householdsTable } from "./index";

// (AI-3) The agent's trail: what it ran (`agent_runs`), what it did
// (`agent_actions`, the Activity screen) and what it noticed
// (`agent_findings`, written by the deterministic monitor). The SQL twins are
// lib/db/migrations/0030_agent_runs.sql and 0070_agent_findings.sql — the two
// must agree column for column (agentSchemaParity.integration.test.ts).
//
// Nothing here stores a raw merchant string: a run's `summary` is counts and
// refs, a finding's `payload` is ids and figures. AI-1 (chat / categorize) reuses
// agent_runs and agent_actions as they are.

export const agentRunsTable = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    // At most 300 characters; counts and refs only, never a raw merchant string.
    summary: text("summary"),
    error: text("error"),
    conversationId: uuid("conversation_id"),
    // The pg-boss job id when a job made the run; a retry finds its row by it.
    jobId: text("job_id"),
  },
  (t) => ({
    jobIdUnique: unique("agent_runs_job_id_unique").on(t.jobId),
    householdStartedIdx: index("agent_runs_household_started_idx").on(t.householdId, t.startedAt),
    kindCheck: check(
      "agent_runs_kind_check",
      sql`${t.kind} in ('chat', 'categorize', 'monitor', 'recap', 'receipt', 'sms_question')`,
    ),
    triggerCheck: check(
      "agent_runs_trigger_check",
      sql`${t.trigger} in ('user', 'txn_arrived', 'schedule', 'sms', 'retry')`,
    ),
    statusCheck: check(
      "agent_runs_status_check",
      sql`${t.status} in ('running', 'succeeded', 'failed', 'refused', 'budget_exceeded')`,
    ),
    summaryLenCheck: check("agent_runs_summary_len_check", sql`char_length(${t.summary}) <= 300`),
  }),
);

export const agentActionsTable = pgTable(
  "agent_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRunsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: uuid("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    outcome: text("outcome").notNull(),
    reversible: boolean("reversible").notNull().default(false),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: text("undone_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    householdCreatedIdx: index("agent_actions_household_created_idx").on(t.householdId, t.createdAt),
    runIdx: index("agent_actions_run_idx").on(t.runId),
    typeCheck: check(
      "agent_actions_type_check",
      sql`${t.type} in ('set_category', 'remember', 'propose', 'wishlist', 'finding', 'recap')`,
    ),
    outcomeCheck: check(
      "agent_actions_outcome_check",
      sql`${t.outcome} in ('applied', 'proposed', 'needs_attention')`,
    ),
  }),
);

export const agentFindingsTable = pgTable(
  "agent_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // `kind:targetRef:periodBucket` — one row per thing noticed per period.
    dedupeKey: text("dedupe_key").notNull(),
    severity: text("severity").notNull(),
    confidence: text("confidence").notNull(),
    // Refs (ids) and figures (numbers) only.
    payload: jsonb("payload").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    surfacedInRecapId: uuid("surfaced_in_recap_id"),
  },
  (t) => ({
    householdDedupeUq: uniqueIndex("agent_findings_household_dedupe_uq").on(t.householdId, t.dedupeKey),
    householdOpenIdx: index("agent_findings_household_seen_idx").on(t.householdId, t.lastSeen),
    kindCheck: check(
      "agent_findings_kind_check",
      sql`${t.kind} in ('bill_increase', 'category_acceleration', 'shortfall_before_income', 'duplicate_charge', 'goal_behind', 'limit_near', 'bank_stale')`,
    ),
    severityCheck: check("agent_findings_severity_check", sql`${t.severity} in ('info', 'watch', 'high')`),
    confidenceCheck: check("agent_findings_confidence_check", sql`${t.confidence} in ('estimate', 'confirmed')`),
  }),
);

export type AgentRun = typeof agentRunsTable.$inferSelect;
export type AgentAction = typeof agentActionsTable.$inferSelect;
export type AgentFinding = typeof agentFindingsTable.$inferSelect;

import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  uuid,
  jsonb,
  date,
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

// ── (AI-2) Ask: conversations, proposals, memory, wish list ─────────────────
// SQL twin: lib/db/migrations/0050_ask_agent.sql (askAgentSchemaParity test).

export const agentConversationsTable = pgTable(
  "agent_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    householdUserIdx: index("agent_conversations_household_user_idx").on(t.householdId, t.userId, t.lastMessageAt),
  }),
);

export const agentMessagesTable = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => agentConversationsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversationCreatedIdx: index("agent_messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    roleCheck: check("agent_messages_role_check", sql`${t.role} in ('user', 'assistant', 'tool')`),
  }),
);

// What the model proposes, a person approves. Nothing here is applied by the
// model: `POST /agent/proposals/:id/approve` applies it through the existing
// writers and stamps `applied_action_id`.
export const agentProposalsTable = pgTable(
  "agent_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRunsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    rationale: text("rationale").notNull().default(""),
    status: text("status").notNull().default("proposed"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    appliedActionId: uuid("applied_action_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    householdStatusIdx: index("agent_proposals_household_status_idx").on(t.householdId, t.status, t.createdAt),
    kindCheck: check(
      "agent_proposals_kind_check",
      sql`${t.kind} in ('set_category', 'weekly_limit', 'budget_line', 'extra_debt_payment', 'bill_amount')`,
    ),
    statusCheck: check(
      "agent_proposals_status_check",
      sql`${t.status} in ('proposed', 'approved', 'rejected', 'applied', 'expired')`,
    ),
  }),
);

// Preferences and decisions the household (or the agent, visibly) keeps. Read
// ONLY by the agent's tools and /memory: no money figure is computed from it
// (memoryImportLaw.test.ts walks the import graph).
export const agentMemoryTable = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    memberUserId: text("member_user_id"),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    source: text("source").notNull(),
    createdByKind: text("created_by_kind").notNull(),
    createdByUserId: text("created_by_user_id"),
    evidenceTxnIds: uuid("evidence_txn_ids").array().notNull().default(sql`'{}'::uuid[]`),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    keyUq: uniqueIndex("agent_memory_household_member_scope_key_uq").on(
      t.householdId,
      sql`coalesce(${t.memberUserId}, '')`,
      t.scope,
      t.key,
    ),
    scopeCheck: check("agent_memory_scope_check", sql`${t.scope} in ('categorization', 'spending', 'debt', 'general')`),
    sourceCheck: check("agent_memory_source_check", sql`${t.source} in ('user_stated', 'inferred', 'agent_proposed')`),
    createdByKindCheck: check("agent_memory_created_by_kind_check", sql`${t.createdByKind} in ('user', 'agent')`),
  }),
);

export const wishlistItemsTable = pgTable(
  "wishlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    url: text("url"),
    categoryId: uuid("category_id"),
    targetDate: date("target_date"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    waitingUntil: date("waiting_until").notNull(),
    decision: text("decision").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    lastEvaluation: jsonb("last_evaluation"),
  },
  (t) => ({
    householdIdx: index("wishlist_items_household_idx").on(t.householdId, t.requestedAt),
    decisionCheck: check("wishlist_items_decision_check", sql`${t.decision} in ('pending', 'approved', 'declined', 'bought')`),
  }),
);

export type AgentConversation = typeof agentConversationsTable.$inferSelect;
export type AgentMessage = typeof agentMessagesTable.$inferSelect;
export type AgentProposal = typeof agentProposalsTable.$inferSelect;
export type AgentMemory = typeof agentMemoryTable.$inferSelect;
export type WishlistItem = typeof wishlistItemsTable.$inferSelect;

import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  date,
  uuid,
  uniqueIndex,
  index,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { householdsTable } from "./index";

// (AI-4b) Recap delivery plumbing: per-member settings and phone consent, the
// 6-digit verification codes, the delivery ledger and the inbound-text audit.
// The SQL twin of this file is lib/db/migrations/0100_recap_sms.sql — the two
// must agree column for column (recapSmsSchemaParity.integration.test.ts).
//
// Nothing here stores a message body. Phone numbers are stored (a text cannot
// be sent without one) but never logged: the `sms.*` log keys are redacted.

// One row per household member. `phone_e164` is only ever set by a confirmed
// verification; `consented_at` records the in-app consent sentence the member
// agreed to (`consent_text_version`); `opted_out_at` is set by a STOP text or
// the in-app unsubscribe and blocks every send until a START text or a fresh
// verification.
export const recapSettingsTable = pgTable(
  "recap_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    sendTimeLocal: text("send_time_local").notNull().default("07:00"),
    timezone: text("timezone").notNull().default("America/Chicago"),
    phoneE164: text("phone_e164"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    skipWeekends: boolean("skip_weekends").notNull().default(false),
    extraAlerts: boolean("extra_alerts").notNull().default(false),
    consentTextVersion: text("consent_text_version"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    householdUserUq: uniqueIndex("recap_settings_household_user_uq").on(t.householdId, t.userId),
    phoneIdx: index("recap_settings_phone_idx").on(t.phoneE164),
  }),
);

// A pending phone verification: the code is stored only as a SHA-256 hash.
export const recapVerificationsTable = pgTable(
  "recap_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    phoneE164: text("phone_e164").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index("recap_verifications_user_created_idx").on(t.userId, t.createdAt),
  }),
);

// The delivery ledger: one row per text we attempt. `idempotency_key` is the
// dedupe (a retry can never send the same text twice); the partial unique
// index makes "one scheduled recap per member per day" a database fact.
export const recapDeliveriesTable = pgTable(
  "recap_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    // Set by the recap generator (a later package); no FK until `recaps` exists.
    recapId: uuid("recap_id"),
    forDate: date("for_date"),
    kind: text("kind").notNull(),
    toE164: text("to_e164").notNull(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyUq: uniqueIndex("recap_deliveries_idempotency_uq").on(t.idempotencyKey),
    scheduledUq: uniqueIndex("recap_deliveries_user_date_scheduled_uq")
      .on(t.userId, t.forDate)
      .where(sql`kind = 'scheduled'`),
    providerMessageIdx: index("recap_deliveries_provider_message_idx").on(t.providerMessageId),
    userCreatedIdx: index("recap_deliveries_user_created_idx").on(t.userId, t.createdAt),
    kindCheck: check(
      "recap_deliveries_kind_check",
      sql`kind in ('scheduled', 'test', 'verification', 'alert', 'reply')`,
    ),
    statusCheck: check(
      "recap_deliveries_status_check",
      sql`status in ('queued', 'sent', 'delivered', 'undelivered', 'failed')`,
    ),
  }),
);

// Audit of every inbound text we acted on. The full body is never stored in
// production; outside production the first 160 characters go in `body_preview`
// to make local debugging possible.
export const smsInboundTable = pgTable("sms_inbound", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerMessageId: text("provider_message_id").notNull().unique(),
  fromE164: text("from_e164").notNull(),
  bodyHash: text("body_hash").notNull(),
  bodyPreview: text("body_preview"),
  matchedUserId: text("matched_user_id"),
  // stop | start | help | unhandled | unknown_sender
  action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// (AI-4a) One drafted morning recap per member per day. `facts` is the exact
// deterministic object the text was written from (money in dollars; category
// names only, no merchant strings); `text` is the full message including the
// link, i.e. what is sent. The SQL twin is lib/db/migrations/0090_recaps.sql.
export const recapsTable = pgTable(
  "recaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    forDate: date("for_date").notNull(),
    facts: jsonb("facts").notNull(),
    text: text("text").notNull(),
    source: text("source").notNull(),
    promptVersion: text("prompt_version"),
    model: text("model"),
    status: text("status").notNull().default("drafted"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateUq: uniqueIndex("recaps_user_date_uq").on(t.userId, t.forDate),
    householdGeneratedIdx: index("recaps_household_generated_idx").on(t.householdId, t.generatedAt),
    sourceCheck: check("recaps_source_check", sql`source in ('model', 'template')`),
    statusCheck: check("recaps_status_check", sql`status in ('drafted', 'sent', 'failed', 'skipped')`),
  }),
);

export type RecapSettings = typeof recapSettingsTable.$inferSelect;
export type RecapDelivery = typeof recapDeliveriesTable.$inferSelect;
export type Recap = typeof recapsTable.$inferSelect;

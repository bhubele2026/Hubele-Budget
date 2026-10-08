import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  uuid,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { householdsTable, transactionsTable } from "./index";

// (PR-A) Categorization engine v2. Created by
// lib/db/migrations/0020_categorization_v2.sql — keep the two equal (the
// schemaMigrations test replays the SQL and compares column for column).
// (V1) `resolved_via` comes from 0111_category_decisions_resolved_via.sql.
// (V7) resolution 'unreviewed' comes from 0116_category_decisions_unreviewed.sql.

/**
 * One row per categorization decision: what the engine (or a person) decided
 * for a transaction, why, how sure, and what happened to it. The engine is
 * idempotent through `(transaction_id, input_hash)`: the same inputs never
 * produce a second decision. Open queue = band provisional|queue, unresolved,
 * not undone.
 */
export const categoryDecisionsTable = pgTable(
  "category_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactionsTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    categoryId: uuid("category_id"),
    previousCategoryId: uuid("previous_category_id"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    band: text("band").notNull(),
    explanation: text("explanation").notNull(),
    ruleId: uuid("rule_id"),
    memoryId: uuid("memory_id"),
    recurringItemId: uuid("recurring_item_id"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    inputHash: text("input_hash").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Who resolved it: a user id, or 'system' when a newer engine decision superseded it. */
    resolvedBy: text("resolved_by"),
    /**
     * accepted | corrected | skipped (a person answered it) or (V7)
     * 'unreviewed': a provisional model suggestion left unchanged for
     * SILENT_ACCEPT_DAYS. Unreviewed is NOT verified: it leaves the queue but
     * counts toward neither the model's record nor its priors.
     */
    resolution: text("resolution"),
    /**
     * (V1) How it was settled: 'user' (a person accepted / corrected / skipped
     * it) or 'silent' (a provisional model suggestion that stood unchanged for
     * SILENT_ACCEPT_DAYS; resolution 'unreviewed' since V7). NULL while open,
     * or when the engine superseded it.
     */
    resolvedVia: text("resolved_via"),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdMemoryId: uuid("created_memory_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("category_decisions_txn_hash_uq").on(t.transactionId, t.inputHash),
    index("category_decisions_open_idx")
      .on(t.householdId, t.band)
      .where(sql`resolved_at IS NULL AND undone_at IS NULL`),
    index("category_decisions_txn_created_idx").on(t.transactionId, t.createdAt),
    check(
      "category_decisions_source_ck",
      sql`${t.source} IN ('locked','rule','memory','recurring','inherited','heuristic','model','user','refund')`,
    ),
    check("category_decisions_band_ck", sql`${t.band} IN ('auto','provisional','queue')`),
    check(
      "category_decisions_resolution_ck",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('accepted','corrected','skipped','unreviewed')`,
    ),
    check(
      "category_decisions_resolved_via_ck",
      sql`${t.resolvedVia} IS NULL OR ${t.resolvedVia} IN ('user','silent')`,
    ),
  ],
);
export type CategoryDecision = typeof categoryDecisionsTable.$inferSelect;

/**
 * What the household taught the engine: a merchant signature (see
 * `merchantSignature`) filed into a category, at one of three scopes —
 * every row of the merchant, the merchant on one account, or the merchant
 * within an amount band. Written only by a person's correction or accept.
 */
export const merchantMemoryTable = pgTable(
  "merchant_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    signature: text("signature").notNull(),
    scope: text("scope").notNull(),
    plaidAccountId: text("plaid_account_id"),
    amountBandLo: numeric("amount_band_lo", { precision: 12, scale: 2 }),
    amountBandHi: numeric("amount_band_hi", { precision: 12, scale: 2 }),
    categoryId: uuid("category_id").notNull(),
    count: integer("count").notNull().default(1),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    learnedFromTxnId: uuid("learned_from_txn_id"),
    source: text("source").notNull().default("user"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("merchant_memory_key_uq").on(
      t.householdId,
      t.signature,
      t.scope,
      sql`coalesce(${t.plaidAccountId}, '')`,
      sql`coalesce(${t.amountBandLo}, 0)`,
    ),
    index("merchant_memory_household_signature_idx").on(t.householdId, t.signature),
    check(
      "merchant_memory_scope_ck",
      sql`${t.scope} IN ('merchant','merchant_account','merchant_amount')`,
    ),
  ],
);
export type MerchantMemory = typeof merchantMemoryTable.$inferSelect;

/**
 * A transaction split across categories. Σ amount = the parent's amount to the
 * cent (enforced by the route); the parent keeps its own category. Survives
 * Plaid upserts because it is a separate table, not reshaped parent rows.
 */
export const transactionSplitsTable = pgTable(
  "transaction_splits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactionsTable.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    member: text("member"),
    note: text("note"),
    source: text("source").notNull().default("user"),
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("transaction_splits_txn_idx").on(t.transactionId),
    check("transaction_splits_source_ck", sql`${t.source} IN ('user','receipt','model')`),
  ],
);
export type TransactionSplit = typeof transactionSplitsTable.$inferSelect;

import {
  pgTable,
  text,
  numeric,
  date,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { debtsTable, householdsTable, transactionsTable } from "./index";

// (PR-D) The debt plan's four tables. The SQL twin of this file is
// lib/db/migrations/0060_debt_plan.sql — the two must agree column for column
// (schemaMigrations.integration.test.ts replays the SQL and compares).
//
// Every amount here is computed in code from bank and creditor records; none
// is ever written by a model. Every table carries household_id and every read
// is household-scoped.

// A milestone the household has REACHED. Insert-only: a balance that ticks
// back up never un-achieves one (`writeAchievedMilestones`). Keys are shared
// with the projection (`milestonesFor`): `debt_zero:<debtId>`,
// `first_card_zero`, `pct_25` … `pct_100`.
export const debtMilestonesTable = pgTable(
  "debt_milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    // Kept when the debt is deleted: the milestone still happened.
    debtId: uuid("debt_id").references((): AnyPgColumn => debtsTable.id, {
      onDelete: "set null",
    }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    achievedOn: date("achieved_on").notNull(),
    evidence: jsonb("evidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    householdKeyUq: uniqueIndex("debt_milestones_household_key_uq").on(t.householdId, t.key),
  }),
);

// What the creditor's statement said (Plaid /liabilities/get, or typed in).
export const debtStatementsTable = pgTable(
  "debt_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    debtId: uuid("debt_id")
      .notNull()
      .references((): AnyPgColumn => debtsTable.id, { onDelete: "cascade" }),
    statementDate: date("statement_date").notNull(),
    statementBalance: numeric("statement_balance", { precision: 12, scale: 2 }),
    minPayment: numeric("min_payment", { precision: 12, scale: 2 }),
    dueDate: date("due_date"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceCheck: check("debt_statements_source_check", sql`${t.source} IN ('plaid', 'manual')`),
    debtDateUq: uniqueIndex("debt_statements_debt_date_uq").on(t.debtId, t.statementDate),
    householdIdx: index("debt_statements_household_idx").on(t.householdId),
  }),
);

// Each row on a liability account (a card or loan's own feed), classified:
// interest, fee, payment, charge or credit (`classifyLiabilityRow`). `amount`
// is a magnitude; `kind` carries the direction. One event per transaction.
export const debtLedgerEventsTable = pgTable(
  "debt_ledger_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    debtId: uuid("debt_id")
      .notNull()
      .references((): AnyPgColumn => debtsTable.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id").references(
      (): AnyPgColumn => transactionsTable.id,
      { onDelete: "cascade" },
    ),
    kind: text("kind").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    occurredOn: date("occurred_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    kindCheck: check(
      "debt_ledger_events_kind_check",
      sql`${t.kind} IN ('interest', 'fee', 'payment', 'charge', 'credit')`,
    ),
    transactionUq: uniqueIndex("debt_ledger_events_transaction_uq")
      .on(t.transactionId)
      .where(sql`${t.transactionId} IS NOT NULL`),
    debtDayIdx: index("debt_ledger_events_debt_day_idx").on(t.debtId, t.occurredOn),
    householdIdx: index("debt_ledger_events_household_idx").on(t.householdId, t.occurredOn),
  }),
);

// One row per debt per day: the balance and what moved it since the debt's
// previous snapshot (`decomposeDelta`). Signed contributions to the balance
// (owed going up is positive): delta = payments_confirmed + interest + fees +
// new_charges + credits + unexplained, exactly. Upserted, so re-running a day
// changes nothing.
export const debtProgressSnapshotsTable = pgTable(
  "debt_progress_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    debtId: uuid("debt_id")
      .notNull()
      .references((): AnyPgColumn => debtsTable.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    balanceEffective: numeric("balance_effective", { precision: 12, scale: 2 }).notNull(),
    delta: numeric("delta", { precision: 12, scale: 2 }).notNull(),
    paymentsConfirmed: numeric("payments_confirmed", { precision: 12, scale: 2 }).notNull(),
    interest: numeric("interest", { precision: 12, scale: 2 }).notNull(),
    fees: numeric("fees", { precision: 12, scale: 2 }).notNull(),
    newCharges: numeric("new_charges", { precision: 12, scale: 2 }).notNull(),
    // Refunds and statement credits. Not in the package's column list, but
    // `decomposeDelta` has five causes and the identity needs all five.
    credits: numeric("credits", { precision: 12, scale: 2 }).notNull().default("0"),
    unexplained: numeric("unexplained", { precision: 12, scale: 2 }).notNull(),
    transferPairTxnId: uuid("transfer_pair_txn_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    debtDayUq: uniqueIndex("debt_progress_snapshots_debt_day_uq").on(t.debtId, t.asOf),
    householdIdx: index("debt_progress_snapshots_household_idx").on(t.householdId, t.asOf),
  }),
);

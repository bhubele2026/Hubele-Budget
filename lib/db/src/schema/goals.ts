import { pgTable, text, numeric, integer, boolean, date, timestamp, uuid, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { householdsTable, plaidAccountsTable } from "./index";

// (PR-C) GOALS AND RESERVES. One row per goal the household keeps.
//
//   manual_current_amount  what the household says the goal holds. For a goal
//                          `reserved_in_checking` it is money still sitting in
//                          checking, and the money position holds it back
//                          (`reservesHeld`) — while the goal is active and no
//                          account backs it.
//   plaid_account_id       a savings account that backs the goal: progress is
//                          read from that account's balance, never from
//                          checking, and the goal never enters the reserve.
//                          ON DELETE SET NULL so a retired account row (the
//                          re-link dedupe) never blocks the delete.
//   kind 'buffer'          its target sits BESIDE forecast_settings.cash_buffer;
//                          it never changes the buffer.
//
// The SQL twin is lib/db/migrations/0080_goals.sql
// (goals.integration.test.ts checks they agree column for column).
export const goalsTable = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    targetAmount: numeric("target_amount", { precision: 12, scale: 2 }),
    manualCurrentAmount: numeric("manual_current_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    plaidAccountId: uuid("plaid_account_id").references(() => plaidAccountsTable.id, { onDelete: "set null" }),
    monthlyContribution: numeric("monthly_contribution", { precision: 12, scale: 2 }).notNull().default("0"),
    targetDate: date("target_date"),
    reservedInChecking: boolean("reserved_in_checking").notNull().default(false),
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("goals_household_status_idx").on(t.householdId, t.status),
    check("goals_kind_check", sql`${t.kind} in ('savings', 'buffer', 'sinking', 'debt_payoff')`),
    check("goals_status_check", sql`${t.status} in ('active', 'paused', 'reached', 'archived')`),
  ],
);

export type Goal = typeof goalsTable.$inferSelect;

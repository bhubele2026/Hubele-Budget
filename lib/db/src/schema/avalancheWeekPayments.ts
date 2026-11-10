import { pgTable, text, numeric, date, timestamp, uuid, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { householdsTable } from "./index";

// ⭐ (AVAL-W) "WE PAID IT" — one row per weekly avalanche payment the household
// marked paid from the home page or the Debt page (POST /avalanche/weekly/pay),
// kept so POST /avalanche/weekly/pay/:id/undo can put everything back exactly:
//
//   week_date      the payment day (YYYY-MM-DD) it closed.
//   total          what the week paid, to the cent (the plan's figure).
//   resolution_id  the `avalanche:extra | week_date | matched` answer it wrote.
//   replaced       the answers that write replaced (forecast_resolutions rows,
//                  as stored), restored by the undo with their own ids.
//   debts          per debt it paid (`AvalancheWeekPaymentDebt`): the amount,
//                  whether the bank carries its balance (`linked`: no balance
//                  write), and for a manual debt its balance, status and as-of
//                  before and after, the day's history row before, and the
//                  claim transaction the payment wrote.
//   created_by     the person who pressed it (a member may).
//   undone_at/by   set by the undo; the row stays as history.
//
// One live row per week (the partial unique index): a second press is refused.
// The SQL twin is lib/db/migrations/0241_avalanche_week_payments.sql
// (schemaMigrations.integration.test.ts checks they agree column for column).
export const avalancheWeekPaymentsTable = pgTable(
  "avalanche_week_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    weekDate: date("week_date").notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    resolutionId: uuid("resolution_id").notNull(),
    replaced: jsonb("replaced").notNull(),
    debts: jsonb("debts").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: text("undone_by"),
  },
  (t) => [
    index("avalanche_week_payments_household_created_idx").on(t.householdId, t.createdAt),
    uniqueIndex("avalanche_week_payments_live_week_uq")
      .on(t.householdId, t.weekDate)
      .where(sql`${t.undoneAt} IS NULL`),
  ],
);

/** One debt a "We paid it" paid, as `avalanche_week_payments.debts` keeps it. */
export interface AvalancheWeekPaymentDebt {
  debtId: string;
  name: string;
  /** What the week paid this debt (the plan's figure). */
  amount: number;
  /** The bank carries this debt's balance (`plaid_account_id`): no balance write, no claim. */
  linked: boolean;
  /** The stored balance before the payment (numeric text, as the column reads). */
  balanceBefore: string;
  statusBefore: string;
  /** After the payment; null for a linked debt (nothing was written). */
  balanceAfter: string | null;
  statusAfter: string | null;
  /** `last_balance_update` before (ISO), restored by the undo. */
  lastBalanceUpdateBefore: string | null;
  /** The balance-history day the payment wrote, and that day's row before it (null: there was none). */
  snapshotDay: string | null;
  snapshotBefore: string | null;
  /** The claim transaction the payment wrote; null for a linked debt. */
  claimTxnId: string | null;
  paidOff: boolean;
}

export type AvalancheWeekPayment = typeof avalancheWeekPaymentsTable.$inferSelect;

import { pgTable, text, date, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";
import { householdsTable } from "./index";

// ⭐ (BANK-AUTO) A BANK ROW THE AUTO-SORT MUST LEAVE ALONE.
//
// The auto-sort (api-server lib/bankAutoSort.ts) writes a `matched` answer
// (`forecast_resolutions.source = 'auto'`) for a bank row it is sure of. When a
// person undoes or deletes such an answer, this row records it, so the next
// sync never matches that bank row automatically again — the person decides it.
// One row per household and bank row; the plan it had been matched to is kept
// for the record. The SQL twin is lib/db/migrations/0250_bank_auto_sort.sql
// (schemaMigrations.integration.test.ts checks they agree column for column).
export const bankAutoMatchDeclinesTable = pgTable(
  "bank_auto_match_declines",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    txnId: uuid("txn_id").notNull(),
    recurringItemId: text("recurring_item_id"),
    occurrenceDate: date("occurrence_date"),
    declinedBy: text("declined_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ name: "bank_auto_match_declines_pkey", columns: [t.householdId, t.txnId] })],
);
export type BankAutoMatchDecline = typeof bankAutoMatchDeclinesTable.$inferSelect;

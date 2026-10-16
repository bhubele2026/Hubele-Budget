import { pgTable, text, timestamp, uuid, index, primaryKey } from "drizzle-orm/pg-core";
import { householdsTable } from "./index";

// (WN) WHAT'S NEW READS — who pressed "I've read this", and when.
//
// One row per person per note: the household's "What's new" sheet stays in
// front of each person until they press it, and the press is recorded for the
// PERSON here, never in the browser. The owner reads the other person's rows
// (GET /whats-new/reads) for "Read by <name> on <day>" / "Not read yet".
//
//   user_id       the signed-in Clerk id (req.actualUserId). No foreign key,
//                 like user_ui_preferences: the report joins household_members.
//   household_id  req.householdId at the time of the read.
//   update_id     a note id from @workspace/avalanche-core/whatsNew.
//   read_at       the FIRST press: the primary key makes a repeat a no-op.
//
// The SQL twin is lib/db/migrations/0230_whats_new_reads.sql
// (schemaMigrations.integration.test.ts checks they agree column for column).
// Both constraints are named so `drizzle-kit push` and the SQL agree.
export const whatsNewReadsTable = pgTable(
  "whats_new_reads",
  {
    userId: text("user_id").notNull(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    updateId: text("update_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "whats_new_reads_pkey", columns: [t.userId, t.updateId] }),
    index("whats_new_reads_household_idx").on(t.householdId),
  ],
);

export type WhatsNewRead = typeof whatsNewReadsTable.$inferSelect;

import { pgTable, bigint, timestamp, uuid } from "drizzle-orm/pg-core";

// ⭐ (PERF) ONE NUMBER PER HOUSEHOLD THAT MOVES ON EVERY WRITE TO ITS MONEY DATA.
//
// Bumped by database triggers (lib/db/migrations/0251_household_data_revisions.sql)
// on every table the forecast ledger and the spine read, whatever wrote the row.
// The API's ledger cache (api-server lib/ledgerCache.ts) serves a computed
// ledger again only at the revision it was built at. No row = revision 0. No
// foreign key on purpose: a bump must never fail the write behind it.
export const householdDataRevisionsTable = pgTable("household_data_revisions", {
  householdId: uuid("household_id").primaryKey(),
  rev: bigint("rev", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type HouseholdDataRevision = typeof householdDataRevisionsTable.$inferSelect;

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// (PR-0) The migration runner's ledger (src/migrate.ts). Production creates it
// from lib/db/migrations/0001_schema_migrations.sql; it is declared here too
// because `drizzle-kit push` (dev and tests) DROPS any public table the
// drizzle schema does not know — it silently removed this ledger in testing.
// Keep the two definitions equal. Nothing in the app reads or writes it.
export const schemaMigrationsTable = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

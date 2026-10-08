import { pgTable, integer, timestamp, date, uuid, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { householdsTable } from "./index";

// (PR-E) One row per household per day: the progress metrics the nightly
// `metrics.snapshot` job computes (lib/avalanche-core/src/metrics.ts). `version`
// is the metric DEFINITION version; a recompute under an older definition never
// overwrites a row written under a newer one. The SQL twin is
// lib/db/migrations/0110_household_metrics_daily.sql
// (metricsSchemaParity.integration.test.ts checks they agree).
export const householdMetricsDailyTable = pgTable(
  "household_metrics_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    version: integer("version").notNull().default(1),
    metrics: jsonb("metrics").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("household_metrics_daily_household_as_of_uq").on(t.householdId, t.asOf)],
);

export type HouseholdMetricsDaily = typeof householdMetricsDailyTable.$inferSelect;

import { pgTable, text, integer, date, timestamp, uuid, index, check, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { householdsTable } from "./index";

// (V5) PLAN ADJUSTMENTS — a week the household itself chose to start LOWER.
//
// One row per household, week and kind. Today the only kind is `carry_over`:
// last week ran over its cap and the household chose to take the overage out
// of the next week. `amount_cents` is whole cents and STRICTLY NEGATIVE (the
// CHECK): an adjustment can only lower a week, never raise one — nothing here
// can hand the household more room than its own cap.
//
//   week_start   the Sunday of the household week the row lowers.
//   created_by   the signed-in user who chose it (the household's owner).
//
// Written only by `artifacts/api-server/src/lib/weekAdjustments.ts` from the
// owner-only routes; read by the money position (`moneyPosition.ts`). No job
// and nothing under `src/ai` may write it (weekAdjustmentsLaws.test.ts).
//
// The SQL twin is lib/db/migrations/0115_plan_adjustments.sql
// (weekAdjustments.integration.test.ts checks they agree column for column).
export const planAdjustmentsTable = pgTable(
  "plan_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    weekStart: date("week_start").notNull(),
    amountCents: integer("amount_cents").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("plan_adjustments_household_week_kind_uq").on(t.householdId, t.weekStart, t.kind),
    index("plan_adjustments_household_week_idx").on(t.householdId, t.weekStart),
    check("plan_adjustments_amount_negative_check", sql`${t.amountCents} < 0`),
    check("plan_adjustments_kind_check", sql`${t.kind} in ('carry_over')`),
  ],
);

export type PlanAdjustment = typeof planAdjustmentsTable.$inferSelect;

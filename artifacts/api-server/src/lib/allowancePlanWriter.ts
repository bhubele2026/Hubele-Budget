// ⚠️ (PR-B1) THE ONE WRITER OF `allowance_plans`.
//
// The weekly cap is the household's own decision. A person changes a plan, in
// one of these user-initiated ways; nothing automatic ever does — no job, no
// agent, no "helpful" raise when a week runs over:
//   - (S2) the owner sets a plan from this week (or month) on: `POST
//     /allowance-plans` (`createOwnerAllowancePlan`) — the one-tap, confirmed
//     "Use $450 as the weekly plan from this week";
//   - the owner edits a plan: `PUT /allowance-plans/:id` (`writeOwnerAllowancePlan`),
//     and an approved weekly-limit proposal goes through the same function;
//   - (lead's ruling on PR-B1 Q4) a household member saving the weekly or
//     monthly allowance on the classic Allowances page (`PUT /settings`), which
//     is mirrored into the household pool's plan for the current week
//     (`mirrorSettingsAllowance`) until `settings` is retired.
// `allowancePlans.integration.test.ts` asserts that no file under `src/jobs` or
// `src/ai` imports this module or names the table, and the table's own CHECK
// pins `created_by_kind = 'user'`.
//
// ⭐ (S2, owner's decision 2026-10-14) A PAST WEEK KEEPS THE PLAN IT WAS JUDGED
// AGAINST. No writer here changes a row that started before the current period
// (this week's Sunday, or this month's 1st): editing one inserts a new row from
// the current period instead, and no row's start may move into the past. Rows
// that start in the current period or later are edited in place.

import { and, eq, isNull, sql } from "drizzle-orm";
import { allowancePlansTable, db, type AllowancePlan } from "@workspace/db";
import { isPeriodStart, monthBounds, weekBounds } from "@workspace/avalanche-core";
import { householdTodayISO } from "./householdClock";

/** `db` or a transaction on it. */
type Executor = Pick<typeof db, "execute">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PlanPeriod = "weekly" | "monthly";

/** The first day of the household's current period: this week's Sunday, or this month's 1st. */
export function currentPlanPeriodStart(period: PlanPeriod, todayISO: string): string {
  return period === "weekly" ? weekBounds(todayISO).start : monthBounds(todayISO).start;
}

/** Why a start date is refused for a plan — or null when it may be used. */
export type PlanStartProblem = "start_not_a_sunday" | "start_not_first_of_month" | "start_in_past";

/**
 * ⭐ (S2) The one rule for a plan's start: a weekly plan starts on a household
 * week start (a Sunday), a monthly one on the 1st, and never before the current
 * period — a past week or month is never re-planned. Pure.
 */
export function planStartProblem(period: PlanPeriod, effectiveFrom: string, todayISO: string): PlanStartProblem | null {
  if (!isPeriodStart(period === "weekly" ? "week" : "month", effectiveFrom)) {
    return period === "weekly" ? "start_not_a_sunday" : "start_not_first_of_month";
  }
  return effectiveFrom < currentPlanPeriodStart(period, todayISO) ? "start_in_past" : null;
}

export interface AllowancePlanEdit {
  /** Dollars, `0`–`99999999.99`, at most two decimals. */
  amount: string;
  /** `YYYY-MM-DD`; omitted keeps the row's own start (or, for a past row, the current period's). */
  effectiveFrom?: string;
}

export interface NewAllowancePlan {
  period: PlanPeriod;
  /** Dollars, more than 0, at most two decimals. */
  amount: string;
  /** `YYYY-MM-DD`: a period start, this period or later (`planStartProblem`). */
  effectiveFrom: string;
}

export type AllowancePlanWriteResult =
  | {
      ok: true;
      plan: AllowancePlan;
      /** True when a new row was written; false when a row of the current period (or later) was updated. */
      created: boolean;
    }
  | { ok: false; reason: "not_found" | "conflict" | "amount_not_positive" | PlanStartProblem };

const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: string })?.code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505";

/** What every owner write stamps: typed by the owner, no suggestion's working, a person wrote it. */
const OWNER_WRITE = { source: "owner", derivation: null, createdByKind: "user" } as const;

/**
 * Set the plan of `memberUserId` (null = the household pool) for `period` from
 * `effectiveFrom`: update the row that already starts that day, or insert one.
 * Only ever called with a start in the current period or later.
 */
async function setPlanFrom(
  tx: Tx,
  householdId: string,
  memberUserId: string | null,
  period: PlanPeriod,
  amount: string,
  effectiveFrom: string,
): Promise<{ plan: AllowancePlan; created: boolean }> {
  const [existing] = await tx
    .select({ id: allowancePlansTable.id })
    .from(allowancePlansTable)
    .where(
      and(
        eq(allowancePlansTable.householdId, householdId),
        memberUserId == null ? isNull(allowancePlansTable.memberUserId) : eq(allowancePlansTable.memberUserId, memberUserId),
        eq(allowancePlansTable.period, period),
        eq(allowancePlansTable.effectiveFrom, effectiveFrom),
      ),
    )
    .for("update");
  if (existing) {
    const [plan] = await tx
      .update(allowancePlansTable)
      .set({ amount, ...OWNER_WRITE })
      .where(eq(allowancePlansTable.id, existing.id))
      .returning();
    return { plan: plan!, created: false };
  }
  const [plan] = await tx
    .insert(allowancePlansTable)
    .values({ householdId, memberUserId, period, amount, effectiveFrom, ...OWNER_WRITE })
    .returning();
  return { plan: plan!, created: true };
}

/**
 * ⭐ (S2) The owner sets the household's `period` plan from `effectiveFrom` on —
 * the confirmed "Use $450 as the weekly plan from this week". A weekly plan
 * starts on a Sunday, a monthly one on the 1st, this period or later; the
 * amount is more than $0. A row of the household pool already starting that day
 * is updated (it is this period's or later, never a past one); otherwise a row
 * is inserted. Past weeks keep their own plan rows untouched.
 */
export async function createOwnerAllowancePlan(
  householdId: string,
  plan: NewAllowancePlan,
  todayISO: string = householdTodayISO(),
): Promise<AllowancePlanWriteResult> {
  if (!(Number(plan.amount) > 0)) return { ok: false, reason: "amount_not_positive" };
  const problem = planStartProblem(plan.period, plan.effectiveFrom, todayISO);
  if (problem) return { ok: false, reason: problem };
  try {
    const out = await db.transaction((tx) =>
      setPlanFrom(tx, householdId, null, plan.period, plan.amount, plan.effectiveFrom),
    );
    return { ok: true, ...out };
  } catch (err) {
    // Two saves raced for the same start: the second is told, never merged.
    if (isUniqueViolation(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
}

/**
 * Set one plan's amount (and optionally its start) as the owner typed it:
 * `source = 'owner'`, `derivation` cleared (the figure is no longer the
 * suggestion's), `created_by_kind` stays 'user'. Scoped to the household — a
 * plan of another household is "not found".
 *
 * ⭐ (S2) It never rewrites history. A row that started before the current
 * period (this week's Sunday, or this month's 1st) is LEFT AS IT IS — the past
 * weeks it governed keep their cap — and the edit becomes the plan from the
 * current period (or from `effectiveFrom`, when given) on: the row starting that
 * day is updated, or a new one is inserted (`created: true`). A row starting in
 * the current period or later is edited in place. A new start must be a period
 * start, this period or later (`planStartProblem`).
 */
export async function writeOwnerAllowancePlan(
  householdId: string,
  planId: string,
  edit: AllowancePlanEdit,
  todayISO: string = householdTodayISO(),
): Promise<AllowancePlanWriteResult> {
  try {
    return await db.transaction(async (tx): Promise<AllowancePlanWriteResult> => {
      const [row] = await tx
        .select()
        .from(allowancePlansTable)
        .where(and(eq(allowancePlansTable.id, planId), eq(allowancePlansTable.householdId, householdId)))
        .for("update");
      if (!row) return { ok: false, reason: "not_found" };
      const period: PlanPeriod = row.period === "monthly" ? "monthly" : "weekly";
      if (edit.effectiveFrom) {
        const problem = planStartProblem(period, edit.effectiveFrom, todayISO);
        if (problem) return { ok: false, reason: problem };
      }
      const current = currentPlanPeriodStart(period, todayISO);
      if (row.effectiveFrom < current) {
        // A past week was judged against this row: keep it, and plan from now on.
        const out = await setPlanFrom(tx, householdId, row.memberUserId, period, edit.amount, edit.effectiveFrom ?? current);
        return { ok: true, ...out };
      }
      const [plan] = await tx
        .update(allowancePlansTable)
        .set({ amount: edit.amount, ...(edit.effectiveFrom ? { effectiveFrom: edit.effectiveFrom } : {}), ...OWNER_WRITE })
        .where(eq(allowancePlansTable.id, row.id))
        .returning();
      return { ok: true, plan: plan!, created: false };
    });
  } catch (err) {
    // Another plan of the same household, member and period already starts that day.
    if (isUniqueViolation(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
}

/**
 * (Lead's ruling on PR-B1 Q4) Mirror a classic-page allowance edit into the
 * household pool's plan: upsert the `period` row effective `weekStartSunday`
 * (the Sunday of the current household week, so the edit governs this week, as
 * the classic page always meant it to) at `amount`, `source = 'owner'`, no
 * derivation. A second edit in the same week updates that row. Older rows are
 * kept, so past weeks keep the cap they had. A $0 amount is written as a $0 row,
 * which reads as "no cap" (`everydayPlanFromRows`, ruling Q2).
 */
export async function mirrorSettingsAllowance(
  exec: Executor,
  householdId: string,
  period: "weekly" | "monthly",
  amount: string,
  weekStartSunday: string,
): Promise<void> {
  await exec.execute(sql`
    INSERT INTO allowance_plans
      (household_id, member_user_id, period, amount, effective_from, source, derivation, created_by_kind)
    VALUES (${householdId}, NULL, ${period}, ${amount}, ${weekStartSunday}, 'owner', NULL, 'user')
    ON CONFLICT (household_id, (coalesce("member_user_id", '')), period, effective_from)
    DO UPDATE SET amount = EXCLUDED.amount, source = 'owner', derivation = NULL, created_by_kind = 'user'
  `);
}

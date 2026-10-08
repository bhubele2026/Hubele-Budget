// ⚠️ (PR-B1) THE ONE WRITER OF `allowance_plans`.
//
// The weekly cap is the household's own decision. A person changes a plan, in
// one of two user-initiated ways; nothing automatic ever does — no job, no
// agent, no "helpful" raise when a week runs over:
//   - the owner, through `PUT /allowance-plans/:id` (`writeOwnerAllowancePlan`);
//   - (lead's ruling on PR-B1 Q4) a household member saving the weekly or
//     monthly allowance on the classic Allowances page (`PUT /settings`), which
//     is mirrored into the household pool's plan for the current week
//     (`mirrorSettingsAllowance`) until `settings` is retired.
// `allowancePlans.integration.test.ts` asserts that no file under `src/jobs` or
// `src/ai` imports this module or names the table, and the table's own CHECK
// pins `created_by_kind = 'user'`.

import { and, eq, sql } from "drizzle-orm";
import { allowancePlansTable, db, type AllowancePlan } from "@workspace/db";

/** `db` or a transaction on it. */
type Executor = Pick<typeof db, "execute">;

export interface AllowancePlanEdit {
  /** Dollars, `0`–`99999999.99`, at most two decimals. */
  amount: string;
  /** `YYYY-MM-DD`; omitted keeps the row's own start. */
  effectiveFrom?: string;
}

export type AllowancePlanWriteResult =
  | { ok: true; plan: AllowancePlan }
  | { ok: false; reason: "not_found" | "conflict" };

/**
 * Set one plan's amount (and optionally its start) as the owner typed it:
 * `source = 'owner'`, `derivation` cleared (the figure is no longer the
 * suggestion's), `created_by_kind` stays 'user'. Scoped to the household — a
 * plan of another household is "not found".
 */
export async function writeOwnerAllowancePlan(
  householdId: string,
  planId: string,
  edit: AllowancePlanEdit,
): Promise<AllowancePlanWriteResult> {
  try {
    const [plan] = await db
      .update(allowancePlansTable)
      .set({
        amount: edit.amount,
        ...(edit.effectiveFrom ? { effectiveFrom: edit.effectiveFrom } : {}),
        source: "owner",
        derivation: null,
        createdByKind: "user",
      })
      .where(and(eq(allowancePlansTable.id, planId), eq(allowancePlansTable.householdId, householdId)))
      .returning();
    return plan ? { ok: true, plan } : { ok: false, reason: "not_found" };
  } catch (err) {
    // Another plan of the same household, member and period already starts that day.
    if ((err as { code?: string; cause?: { code?: string } })?.code === "23505" ||
        (err as { cause?: { code?: string } })?.cause?.code === "23505") {
      return { ok: false, reason: "conflict" };
    }
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

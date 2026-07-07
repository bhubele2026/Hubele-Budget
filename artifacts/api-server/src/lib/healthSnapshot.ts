// Persist + read the daily budget-health series.
//
// `upsertTodayHealth` computes today's health (healthScore.ts) and upserts one
// row per (household, day) into budget_health_history — same upsert-per-day
// cadence as debt_balance_history. Called both by the nightly cron job (so the
// trend fills in even when the app is never opened) and opportunistically on
// the /budget-health read (so opening the app reflects the latest numbers).
//
// `getHealthTrend` returns the recent daily series for the sparkline, and
// `computeDeltas` derives "vs yesterday / vs ~7 days ago" from it. Never throws.

import { and, desc, eq, gte } from "drizzle-orm";
import { db, budgetHealthHistoryTable } from "@workspace/db";
import { computeBudgetHealth, type HealthFacts } from "./healthScore";
import { logger } from "./logger";

export interface HealthTrendPoint {
  recordedOn: string; // YYYY-MM-DD
  score: number;
  status: string;
  grade: string;
}

export interface HealthDeltas {
  vsYesterday: number | null; // today − most-recent-prior-day
  vsLastWeek: number | null; // today − score ~7 days ago
  direction: "improving" | "holding" | "slipping" | "new";
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compute today's health and upsert it as the (household, today) row. Idempotent
 * — a later same-day call overwrites the row with fresher numbers. Returns the
 * computed facts (so the caller can reuse them without recomputing).
 */
export async function upsertTodayHealth(
  householdId: string,
  ownerUserId: string,
): Promise<HealthFacts> {
  const facts = await computeBudgetHealth(householdId, ownerUserId);
  try {
    await db
      .insert(budgetHealthHistoryTable)
      .values({
        userId: ownerUserId,
        householdId,
        recordedOn: todayISO(),
        score: facts.score,
        status: facts.status,
        grade: facts.grade,
        payload: {
          dimensions: facts.dimensions,
          drivers: facts.drivers,
          facts: facts.facts,
        },
      })
      .onConflictDoUpdate({
        target: [budgetHealthHistoryTable.householdId, budgetHealthHistoryTable.recordedOn],
        set: {
          score: facts.score,
          status: facts.status,
          grade: facts.grade,
          payload: {
            dimensions: facts.dimensions,
            drivers: facts.drivers,
            facts: facts.facts,
          },
        },
      });
  } catch (err) {
    logger.warn({ err, householdId }, "healthSnapshot: upsert failed (non-fatal)");
  }
  return facts;
}

/** The last `days` daily rows for a household, oldest-first (for the sparkline). */
export async function getHealthTrend(
  householdId: string,
  days = 30,
): Promise<HealthTrendPoint[]> {
  try {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const sinceISO = since.toISOString().slice(0, 10);
    const rows = await db
      .select({
        recordedOn: budgetHealthHistoryTable.recordedOn,
        score: budgetHealthHistoryTable.score,
        status: budgetHealthHistoryTable.status,
        grade: budgetHealthHistoryTable.grade,
      })
      .from(budgetHealthHistoryTable)
      .where(
        and(
          eq(budgetHealthHistoryTable.householdId, householdId),
          gte(budgetHealthHistoryTable.recordedOn, sinceISO),
        ),
      )
      .orderBy(budgetHealthHistoryTable.recordedOn);
    return rows.map((r) => ({
      recordedOn: r.recordedOn,
      score: r.score,
      status: r.status,
      grade: r.grade,
    }));
  } catch (err) {
    logger.warn({ err, householdId }, "healthSnapshot: getHealthTrend failed");
    return [];
  }
}

/** "vs yesterday" and "vs ~7 days ago" deltas + an overall direction label. */
export function computeDeltas(
  todayScore: number,
  trend: HealthTrendPoint[],
): HealthDeltas {
  // trend is oldest-first and includes today's row (it was just upserted).
  const priorDays = trend.filter((p) => p.recordedOn < todayISO());
  if (priorDays.length === 0) {
    return { vsYesterday: null, vsLastWeek: null, direction: "new" };
  }
  const yesterday = priorDays[priorDays.length - 1];
  const vsYesterday = todayScore - yesterday.score;

  // Closest row on-or-before 7 days ago.
  const weekAgoISO = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const weekCandidates = priorDays.filter((p) => p.recordedOn <= weekAgoISO);
  const weekRef = weekCandidates.length
    ? weekCandidates[weekCandidates.length - 1]
    : priorDays[0];
  const vsLastWeek = todayScore - weekRef.score;

  const ref = vsLastWeek;
  const direction: HealthDeltas["direction"] =
    ref > 1 ? "improving" : ref < -1 ? "slipping" : "holding";
  return { vsYesterday, vsLastWeek, direction };
}

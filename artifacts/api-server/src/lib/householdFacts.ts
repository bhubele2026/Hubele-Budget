// One deterministic "whole picture" summary that unifies every advisor tile
// around the household's single North Star: getting out of debt.
//
// Every tile's advisor is siloed to its own facts (bills sees bills, banking
// sees merchants, the debrief sees the week). This module produces the ONE
// cross-tile debt-payoff slice — highest-APR target debt, months to freedom,
// interest saved vs minimums, and the safe extra the cash signal says is
// available — so every advisor can tie its advice back to the payoff.
//
// CLAUDE.md §1: the AI NEVER does arithmetic. Every figure here is computed by
// EXISTING builders (computeCashSignal, resolveAvalancheTargetDebt,
// computeAvalanchePayoffFacts) — this module only reads them and reshapes into
// a compact, prompt-ready summary. No new financial math, no re-derivation.
//
// Contract: buildHouseholdFacts NEVER throws. Any failure (missing forecast
// settings, no debts, DB hiccup) yields the all-zeros fallback so an advisor
// that enriches its prompt with this slice can never be broken by it.

import { db, debtsTable, householdsTable, avalancheSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeCashSignal, parseISO } from "./cashSignal";
import {
  resolveAvalancheTargetDebt,
  computeAvalanchePayoffFacts,
} from "./avalancheSim";
import { logger } from "./logger";

export interface HouseholdFacts {
  /** Highest-APR active debt the avalanche is attacking (null = debt-free). */
  targetDebt: { name: string; apr: number; balance: number } | null;
  /** Months until ALL debts are paid under the current plan (null = underwater). */
  monthsToFreedom: number | null;
  /** Months shaved off the payoff vs paying only minimums (null when either
   *  side of the comparison doesn't converge). */
  monthsSavedVsMin: number | null;
  /** Interest saved vs minimums-only, whole+cents dollars (0 when unknown). */
  interestSavedVsMin: number;
  /** Safe extra the cash signal says can go to debt without breaching buffer. */
  maxSafeExtra: number;
  /** Days from the projection's first day until its lowest point (0 when n/a). */
  runwayDays: number;
  /** Lowest projected bank balance over the horizon. */
  lowestProjected: number;
  /** ISO date of the lowest projected point (null when n/a). */
  lowestDate: string | null;
}

const ZERO_FACTS: HouseholdFacts = {
  targetDebt: null,
  monthsToFreedom: null,
  monthsSavedVsMin: null,
  interestSavedVsMin: 0,
  maxSafeExtra: 0,
  runwayDays: 0,
  lowestProjected: 0,
  lowestDate: null,
};

function daysBetween(fromISO: string | undefined, toISO: string | null): number {
  if (!fromISO || !toISO) return 0;
  try {
    const diff =
      (parseISO(toISO).getTime() - parseISO(fromISO).getTime()) / 86_400_000;
    return diff > 0 ? Math.round(diff) : 0;
  } catch {
    return 0;
  }
}

/**
 * Build the cross-tile debt-payoff summary for a household. Reuses the exact
 * same builders the Avalanche / Forecast tiles already use, so the numbers
 * can never drift from what those tiles show. Never throws — returns the
 * all-zeros fallback on any error.
 *
 * `ownerUserId` is the household owner (forecast + avalanche settings are keyed
 * by the owner's user id). Callers usually have `req.householdOwnerId`; when
 * omitted it's resolved from the households table.
 */
export async function buildHouseholdFacts(
  householdId: string,
  ownerUserId?: string,
): Promise<HouseholdFacts> {
  try {
    let owner = ownerUserId;
    if (!owner) {
      const [row] = await db
        .select({ ownerUserId: householdsTable.ownerUserId })
        .from(householdsTable)
        .where(eq(householdsTable.id, householdId));
      owner = row?.ownerUserId;
    }
    if (!owner) return ZERO_FACTS;

    const debts = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.householdId, householdId));

    const [avaSettings] = await db
      .select()
      .from(avalancheSettingsTable)
      .where(eq(avalancheSettingsTable.userId, owner));
    const manualExtra = Number(avaSettings?.manualExtra ?? 0) || 0;

    const target = resolveAvalancheTargetDebt(debts);
    const payoff = computeAvalanchePayoffFacts(debts, "avalanche", manualExtra);

    let maxSafeExtra = 0;
    let runwayDays = 0;
    let lowestProjected = 0;
    let lowestDate: string | null = null;
    try {
      const cs = await computeCashSignal(householdId, owner, { horizonDays: 90 });
      maxSafeExtra = Number(cs.maxSafeExtra) || 0;
      lowestProjected = Number(cs.lowestProjected) || 0;
      lowestDate = cs.lowestDate;
      runwayDays = daysBetween(cs.fromDate, cs.lowestDate);
    } catch (err) {
      logger.warn(
        { err, householdId },
        "householdFacts: cashSignal failed, omitting runway/maxSafeExtra",
      );
    }

    return {
      targetDebt: target
        ? { name: target.name, apr: target.apr, balance: target.balance }
        : null,
      monthsToFreedom: payoff.monthsToFreedom,
      monthsSavedVsMin: payoff.monthsSavedVsMin,
      interestSavedVsMin: payoff.interestSavedVsMin,
      maxSafeExtra,
      runwayDays,
      lowestProjected,
      lowestDate,
    };
  } catch (err) {
    logger.warn({ err, householdId }, "householdFacts: build failed, using zeros");
    return ZERO_FACTS;
  }
}

function money(n: number): string {
  return `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

function plural(n: number, one: string): string {
  return `${n} ${Math.abs(n) === 1 ? one : `${one}s`}`;
}

/**
 * One deterministic directive sentence routing freed-up dollars to the
 * highest-APR debt. Returns null when there's no active debt to attack.
 * Every number comes from the facts — the model never computes it.
 *
 * `amount` optionally overrides the dollar figure (e.g. a specific bucket's
 * saved dollars); defaults to the cash signal's safe extra.
 */
export function debtDirective(f: HouseholdFacts, amount?: number): string | null {
  if (!f.targetDebt) return null;
  const aprPct = Math.round((Number(f.targetDebt.apr) || 0) * 100);
  const dollars = amount != null && amount > 0
    ? money(amount)
    : f.maxSafeExtra > 0
      ? money(f.maxSafeExtra)
      : null;
  const lead = dollars
    ? `Send ${dollars} to ${f.targetDebt.name}`
    : `Route any freed-up dollars to ${f.targetDebt.name}`;
  const apr = aprPct > 0 ? ` (highest APR at ${aprPct}%)` : " (highest APR)";
  let tail = ".";
  if (f.monthsSavedVsMin != null && f.monthsSavedVsMin > 0) {
    tail = ` — that's about ${plural(f.monthsSavedVsMin, "month")} off your payoff.`;
  } else if (f.monthsToFreedom != null && f.monthsToFreedom > 0) {
    tail = ` — keeps you on track to debt-free in ${plural(f.monthsToFreedom, "month")}.`;
  }
  return `${lead}${apr}${tail}`;
}

/**
 * A compact FACTS block any advisor can append to its own facts so the model
 * knows the household's payoff picture and can tie its advice back to it.
 * Returns "" when there's nothing debt-relevant to add (keeps prompts lean).
 */
export function formatDebtSliceForPrompt(f: HouseholdFacts): string {
  if (!f.targetDebt && f.maxSafeExtra <= 0) return "";
  const lines: string[] = ["DEBT-PAYOFF PICTURE (the household's North Star):"];
  if (f.targetDebt) {
    const aprPct = Math.round((Number(f.targetDebt.apr) || 0) * 100);
    lines.push(
      `  Target debt (highest APR): ${f.targetDebt.name} — ${money(f.targetDebt.balance)} at ${aprPct}%`,
    );
  } else {
    lines.push("  No active debt — debt-free.");
  }
  if (f.monthsToFreedom != null) {
    lines.push(`  Months to debt-free (current plan): ${f.monthsToFreedom}`);
  }
  if (f.monthsSavedVsMin != null && f.monthsSavedVsMin > 0) {
    lines.push(`  Months saved vs minimums-only: ${f.monthsSavedVsMin}`);
  }
  if (f.interestSavedVsMin > 0) {
    lines.push(`  Interest saved vs minimums-only: ${money(f.interestSavedVsMin)}`);
  }
  if (f.maxSafeExtra > 0) {
    lines.push(
      `  Safe extra available for debt right now (won't breach cash buffer): ${money(f.maxSafeExtra)}`,
    );
  }
  const directive = debtDirective(f);
  if (directive) lines.push(`  Directive to echo when there's surplus: ${directive}`);
  return lines.join("\n");
}

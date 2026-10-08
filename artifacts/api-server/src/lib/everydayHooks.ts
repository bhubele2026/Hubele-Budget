// ⭐ (PR-B2, owner decision 7) THE EVERYDAY HOOKS' SERVER LOADER — what each
// hook occurrence on the forecast is worth: the card payoff it stands for.
// The rule itself is pure and lives in avalanche-core (`everydayHooks.ts`);
// this file only reads what that rule needs and adds nothing to it.
//
//   the hooks     `settings.preferences.everydayHooks` (server-owned; set once
//                 per household by `0042_everyday_hooks.sql`), each naming an
//                 active, non-income recurring item.
//   charges       `computeWeeklyPayoff` — the SAME per-card engine the Amex
//                 page uses (`amexCardCadence.ts` cadence, "not mine" charges
//                 out, a pending charge its posted row replaced counted once),
//                 with `allCoverages`: every purchase, filed or not (an unfiled
//                 charge is owed, and counts against the allowance): the weekly cards' charges for a weekly
//                 period, the monthly cards' for a monthly one. Read only for a
//                 period that has started; a future period has no charges yet.
//   the cap       `allowance_plans` through `everydayPlanFromRows` (the week's
//                 override honoured), falling back to the owner's
//                 `settings.weekly_allowance_amount` / `monthly_allowance_amount`
//                 when no plan row is in effect.
//   spent         the open period's rows, classified by `classifyMovement` with
//                 the ledger's own tier-2 pairs — exactly as the money position
//                 sizes `remainingWeek` (weekly: allowance_weekly + unfiled;
//                 monthly: allowance_monthly).
//
// ⚠️ READ-ONLY, like the ledger that calls it.

import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import {
  classifyMovement,
  everydayPlanFromRows,
  hookPeriodOf,
  payoffFor,
  readEverydayHooks,
  spendAmount,
  type EverydayHooks,
  type HookCadence,
  type Payoff,
} from "@workspace/avalanche-core";

export interface HookSettings {
  hooks: EverydayHooks;
  weeklyAllowanceAmount: string | null;
  monthlyAllowanceAmount: string | null;
  weeklyAllowanceOverrides: Record<string, string | number> | null;
}

/** The owner's hooks and allowance settings, read once. */
export async function readHookSettings(ownerUserId: string): Promise<HookSettings> {
  const [s] = await db
    .select({
      weekly: settingsTable.weeklyAllowanceAmount,
      monthly: settingsTable.monthlyAllowanceAmount,
      preferences: settingsTable.preferences,
    })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  const prefs = (s?.preferences as Record<string, unknown> | null | undefined) ?? null;
  const overrides = prefs?.weeklyAllowanceOverrides;
  return {
    hooks: readEverydayHooks(prefs),
    weeklyAllowanceAmount: s?.weekly ?? null,
    monthlyAllowanceAmount: s?.monthly ?? null,
    weeklyAllowanceOverrides:
      overrides && typeof overrides === "object" && !Array.isArray(overrides)
        ? (overrides as Record<string, string | number>)
        : null,
  };
}

export interface HookOccurrence {
  key: string;
  cadence: HookCadence;
  occurrenceDate: string;
}

export interface HookPayoff extends Payoff {
  periodStart: string;
  periodEnd: string;
}

const toCents = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * ⭐ Each occurrence's payoff (`payoffFor`), keyed like the ledger's plans.
 * `tier2PairedTxnIds` are the ledger's own tier-2 off-curve pairs, so the
 * remaining allowance reads exactly as `GET /money/position`'s does.
 */
export async function loadHookPayoffs(args: {
  householdId: string;
  ownerUserId: string;
  todayISO: string;
  settings: HookSettings;
  occurrences: readonly HookOccurrence[];
  tier2PairedTxnIds: ReadonlySet<string>;
}): Promise<Map<string, HookPayoff>> {
  const { householdId, ownerUserId, todayISO, settings, occurrences } = args;
  const out = new Map<string, HookPayoff>();
  if (occurrences.length === 0) return out;

  const [{ computeWeeklyPayoff }, { loadAllowancePlans, planRowsOf }, { loadMoneyContext, loadMovementRows }, { TRACKING_START }] =
    await Promise.all([
      import("./amexAnchor"),
      import("./allowancePlans"),
      import("./moneyContext"),
      import("./spendingFacts"),
    ]);

  // One entry per distinct period.
  type Period = { cadence: HookCadence; start: string; end: string };
  const periods = new Map<string, Period>();
  for (const o of occurrences) {
    const p = hookPeriodOf(o.cadence, o.occurrenceDate);
    periods.set(`${o.cadence}|${p.start}`, { cadence: o.cadence, ...p });
  }
  const started = [...periods.values()].filter((p) => p.start <= todayISO);
  const open = started.filter((p) => p.end >= todayISO);

  // Charges, for the periods that have started (future periods owe nothing yet).
  const charges = new Map<string, number>();
  await Promise.all(
    started.map(async (p) => {
      // A weekly period is its Sunday; a monthly one is read through a day whose
      // Sunday is inside the month (the 7th), so the engine bills that month.
      const weekStart = p.cadence === "weekly" ? p.start : `${p.start.slice(0, 8)}07`;
      const payoff = await computeWeeklyPayoff(householdId, weekStart, ownerUserId, { allCoverages: true });
      const cents =
        p.cadence === "weekly"
          ? toCents(payoff.combinedWeekCharges)
          : payoff.cards.filter((c) => c.cadence === "monthly").reduce((s, c) => s + toCents(c.weekCharges), 0);
      charges.set(`${p.cadence}|${p.start}`, cents);
    }),
  );

  // What the open periods have already spent from their allowance.
  const spent = new Map<string, number>();
  if (open.length > 0) {
    const from = open.reduce((m, p) => (p.start < m ? p.start : m), open[0]!.start);
    const to = open.reduce((m, p) => (p.end > m ? p.end : m), open[0]!.end);
    const rangeStart = from < TRACKING_START ? TRACKING_START : from;
    const money = await loadMoneyContext(householdId, { start: rangeStart, end: to }, { tier2PairedTxnIds: args.tier2PairedTxnIds });
    const rows = await loadMovementRows(householdId, rangeStart, to, money);
    const classified = rows.map((r) => ({ date: r.occurredOn, coverage: classifyMovement(r, money).coverage, cents: toCents(spendAmount(r)) }));
    for (const p of open) {
      const lo = p.start < TRACKING_START ? TRACKING_START : p.start;
      let c = 0;
      for (const r of classified) {
        if (r.date < lo || r.date > p.end) continue;
        if (p.cadence === "weekly" ? r.coverage === "allowance_weekly" || r.coverage === "needs_classification" : r.coverage === "allowance_monthly") {
          c += r.cents;
        }
      }
      spent.set(`${p.cadence}|${p.start}`, c);
    }
  }

  const planRows = planRowsOf(await loadAllowancePlans(householdId));
  const capOf = (p: Period): number => {
    const plan = everydayPlanFromRows(p.start, planRows, settings.weeklyAllowanceOverrides);
    if (p.cadence === "weekly") {
      return plan.weeklySource === "none" ? toCents(settings.weeklyAllowanceAmount) : plan.weeklyCents;
    }
    return plan.monthlySource === "none" ? toCents(settings.monthlyAllowanceAmount) : plan.monthlyCents;
  };

  for (const o of occurrences) {
    const p = hookPeriodOf(o.cadence, o.occurrenceDate);
    const id = `${o.cadence}|${p.start}`;
    const payoff = payoffFor({
      chargesCents: charges.get(id) ?? 0,
      capCents: capOf(periods.get(id)!),
      spentCents: spent.get(id) ?? 0,
      periodEnd: p.end,
      todayISO,
    });
    out.set(o.key, { ...payoff, periodStart: p.start, periodEnd: p.end });
  }
  return out;
}

// ⭐ (AVAL-W) THE HOUSEHOLD'S WEEKLY AVALANCHE — the reads around the pure
// planner (`avalancheWeekly.ts`). One function, `loadWeeklyAvalanchePlan`, and
// every surface reads it: the forecast ledger puts its payments on the curve
// (and stops each paid-off debt's minimum after its payoff day), the Forecast
// register lists the same occurrences, and `GET /avalanche/weekly` shows them.
//
// THE CURVE IT IS PRICED ON is the forecast itself, built WITHOUT any avalanche
// payment (`buildForecastLedger`'s `avalancheBase`), from the household's today
// for `WEEKLY_BASE_HORIZON_DAYS` — a fixed horizon, so the forecast's own
// window (90 days, 12 months, a chart moved to next month) never changes what a
// Friday pays. Every other rule of the forecast applies to it unchanged: the
// bank anchor, the answers, the drag, the everyday hooks, the minimums.
//
// No write. Built once per moment like the ledger (`shareInFlight`): the spine,
// the curve and the page of one load price the plan once.

import { and, eq, gte, inArray } from "drizzle-orm";
import { avalancheSettingsTable, db, debtsTable, forecastResolutionsTable, recurringItemsTable } from "@workspace/db";
import { CENTS, effectiveDebtBalance, rollForwardBalance, round2, walkLedger, type Strategy } from "@workspace/avalanche-core";
import { buildForecastLedger } from "./forecastLedger";
import type { PlanOverride } from "./everydayHooks";
import type { CorrectionOverlay } from "./correctionOverlay";
import { planWeeklyAvalanche, type WeeklyPlan, type WeeklyPlanDebt } from "./avalancheWeekly";
import { AVALANCHE_EXTRA_EVENT_ITEM_ID } from "./debtMinSchedule";
import { withPendingPayments } from "./debtPending";
import { loadInFullDebtIds } from "./cardPayoffMode";
import { isPastOneTime } from "./cashSignal";
import { householdTodayISO } from "./householdClock";
import { expiredHoldsRuleOn } from "./supersededPending";
import { deepFreeze, ledgerFreezeEnabled, ledgerSharingEnabled, shareInFlight } from "./ledgerShare";
import { cachedLedgerRead } from "./ledgerCache";

type AvalancheSettingsRow = typeof avalancheSettingsTable.$inferSelect;

export type AvalancheCadence = "monthly" | "weekly";

/** The fixed horizon the weekly plan is priced on: a year of payment days, plus the planner's look-ahead. */
export const WEEKLY_BASE_HORIZON_DAYS = 400;

/** A payment's answers that settle it: nothing more is paid out of the curve on that day. */
export const SETTLING_ANSWERS = ["skipped", "missed", "dismissed", "matched"] as const;

/** The stored cadence and weekday, read safely (anything unknown reads as the defaults). */
export function cadenceOf(
  row: Pick<AvalancheSettingsRow, "extraCadence" | "extraWeekday"> | null | undefined,
): { cadence: AvalancheCadence; weekday: number } {
  const cadence: AvalancheCadence = row?.extraCadence === "weekly" ? "weekly" : "monthly";
  const w = Number(row?.extraWeekday);
  const weekday = Number.isInteger(w) && w >= 0 && w <= 6 ? w : 5;
  return { cadence, weekday };
}

export type WeeklyAvalanchePlan = WeeklyPlan & {
  todayISO: string;
  /** `avalanche_settings.manual_extra`: the target per month. */
  monthlyTarget: number;
  cashBuffer: number;
  strategy: Strategy;
};

/**
 * Debt id → the day after which its minimum leaves the curve: the payoff days
 * the forecast itself priced (on or before `curveThrough`). A payoff projected
 * past what the forecast can see never stops a minimum on it.
 */
export function minimumsStopAfterOf(plan: Pick<WeeklyPlan, "payoffs" | "curveThrough">): Map<string, string> {
  const out = new Map<string, string>();
  if (!plan.curveThrough) return out;
  for (const p of plan.payoffs) if (p.date <= plan.curveThrough) out.set(p.debtId, p.date);
  return out;
}

/**
 * The weekly plan, or null when the household pays the avalanche monthly.
 * `planOverride` / `correctionOverlay`: a dry run's ledger prices the plan on
 * the dry run's own curve (never shared).
 */
export async function loadWeeklyAvalanchePlan(
  householdId: string,
  ownerUserId: string,
  opts: { planOverride?: PlanOverride | null; correctionOverlay?: CorrectionOverlay | null } = {},
): Promise<WeeklyAvalanchePlan | null> {
  const dryRun = !!opts.planOverride || !!opts.correctionOverlay;
  const build = async (): Promise<WeeklyAvalanchePlan | null> => {
    const built = await buildWeeklyAvalanchePlan(householdId, ownerUserId, opts);
    return ledgerFreezeEnabled() && built ? deepFreeze(built) : built;
  };
  if (dryRun) return build();
  const key = JSON.stringify(["avalancheWeekly", householdId, ownerUserId, householdTodayISO(), expiredHoldsRuleOn()]);
  // ⭐ (PERF) The plan — and the 400-day base it is priced on — is kept while the household's data revision holds
  // (`ledgerCache.ts`): every ledger of a page load and the loads after it price it once, not once per build.
  return cachedLedgerRead("avalancheWeekly", householdId, key, (rev) =>
    ledgerSharingEnabled() ? shareInFlight(rev == null ? key : `${key}\u0001${rev}`, build) : build(),
  );
}

async function buildWeeklyAvalanchePlan(
  householdId: string,
  ownerUserId: string,
  opts: { planOverride?: PlanOverride | null; correctionOverlay?: CorrectionOverlay | null },
): Promise<WeeklyAvalanchePlan | null> {
  const [[settings], debtRows, recurring, inFullDebtIds] = await Promise.all([
    db.select().from(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, ownerUserId)),
    db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId)),
    db.select().from(recurringItemsTable).where(eq(recurringItemsTable.householdId, householdId)),
    loadInFullDebtIds(householdId, ownerUserId),
  ]);
  const { cadence, weekday } = cadenceOf(settings);
  if (cadence !== "weekly") return null;

  // The curve without any avalanche payment, from today.
  const ledger = await buildForecastLedger(householdId, ownerUserId, {
    horizonDays: WEEKLY_BASE_HORIZON_DAYS,
    avalancheBase: true,
    planOverride: opts.planOverride ?? null,
    correctionOverlay: opts.correctionOverlay ?? null,
  });
  const todayISO = ledger.todayISO;
  const startingBalance = rollForwardBalance(ledger.items, ledger.startBalanceAtAnchor, ledger.fromISO);
  const curve = walkLedger(ledger.items, startingBalance, ledger.fromISO, ledger.toISO).daily.map((p) => ({
    date: p.date,
    balance: Number(p.balance),
  }));

  // The debts the avalanche pays: active, not a card paid in full (the everyday
  // hook pays those), at the NETTED balance (pending payments count, as on
  // every debt figure). A debt with no minimum still takes the extra.
  const linked = new Set<string>();
  for (const r of recurring) {
    if (r.debtId && r.active === "true" && !isPastOneTime(r, todayISO)) linked.add(r.debtId);
  }
  const netted = await withPendingPayments(householdId, debtRows);
  const debts: WeeklyPlanDebt[] = netted
    .filter((d) => (d.status ?? "active") === "active" && !inFullDebtIds.has(d.id))
    .map((d) => {
      const minPayment = Number(d.minPayment) || 0;
      return {
        id: d.id,
        name: d.name,
        apr: Number(d.apr) || 0,
        balance: effectiveDebtBalance(d),
        minPayment,
        dueDay: d.dueDay ?? null,
        // `expandDebtMin`'s own rule: its `debt:<id>` minimum is on the curve.
        minimumOnCurve: minPayment > 0 && Number(d.balance) > CENTS && !linked.has(d.id),
      };
    })
    .filter((d) => d.balance > CENTS)
    .sort((a, b) => a.id.localeCompare(b.id));

  const answers = await db
    .select({ occurrenceDate: forecastResolutionsTable.occurrenceDate })
    .from(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        eq(forecastResolutionsTable.recurringItemId, AVALANCHE_EXTRA_EVENT_ITEM_ID),
        inArray(forecastResolutionsTable.status, [...SETTLING_ANSWERS]),
        gte(forecastResolutionsTable.occurrenceDate, todayISO),
      ),
    );
  const answeredDates = new Set(answers.map((a) => a.occurrenceDate).filter((d): d is string => !!d));

  const monthlyTarget = round2(Math.max(0, Number(settings?.manualExtra ?? 0) || 0));
  const strategy: Strategy = settings?.strategy === "snowball" ? "snowball" : "avalanche";
  const plan = planWeeklyAvalanche({
    debts,
    monthlyTarget,
    weekday,
    cashBuffer: ledger.cashBuffer,
    todayISO,
    curve,
    strategy,
    answeredDates,
  });
  return { ...plan, todayISO, monthlyTarget, cashBuffer: round2(ledger.cashBuffer), strategy };
}

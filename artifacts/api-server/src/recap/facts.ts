import { and, desc, eq, gt, gte, isNotNull, isNull, lt, lte } from "drizzle-orm";
import {
  db,
  agentFindingsTable,
  debtsTable,
  recapsTable,
  transactionsTable,
} from "@workspace/db";
import {
  addDaysISO,
  classifyMovement,
  dayOfWeekISO,
  payoffPct,
  spendAmount,
  weekBounds,
  type MovementCoverage,
} from "@workspace/avalanche-core";
import { buildBillsSummary } from "../lib/billsSummary";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { computeBankFreshness } from "../lib/bankFreshness";
import { withPendingPayments } from "../lib/debtPending";
import { householdDayOf } from "../lib/householdClock";
import { buildMoneyPosition, POSITION_HORIZON_DAYS } from "../lib/moneyPosition";
import { loadMoneyContext, loadMovementRows } from "../lib/moneyContext";
import { computeReviewCount } from "../lib/reviewCount";
import { TRACKING_START } from "../lib/spendingFacts";
import { SEVERITY_RANK, type FindingSeverity } from "../monitor/types";
import { safeName } from "./text";

// (AI-4a) THE RECAP'S FACTS — everything the morning text may say, worked out
// by code and nothing else. Money is in dollars as plain numbers; every number
// the text is later allowed to contain comes from this object (validate.ts).
//
// Each figure is read through the function the owning screen uses:
//   position   buildMoneyPosition   (also GET /money/position and the spine)
//   yesterday  loadMoneyContext + loadMovementRows + classifyMovement (the
//              same loader and classifier PR-B1's week uses), by occurred_on
//   bills      buildBillsSummary    (also GET /bills/summary)
//   review     computeReviewCount   (the spine's reviewCount)
//   debt       payoffPct over withPendingPayments (the spine's debt.payoffPct)
// READ-ONLY and free: no Plaid call, no model call, no write.

const DISCRETIONARY: ReadonlySet<MovementCoverage> = new Set<MovementCoverage>([
  "allowance_weekly",
  "unplanned",
  "needs_classification",
]);
const LOOKBACK_DAYS = 14;
const TOP_CATEGORIES = 3;
const BILL_DAYS = 3;
const MAX_FINDINGS = 3;

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const weekdayOf = (iso: string): string => WEEKDAYS[dayOfWeekISO(iso)]!;

export interface RecapFinding {
  /** Internal: the agent_findings row; stripped before the model sees the facts. */
  id: string;
  kind: string;
  severity: FindingSeverity;
  /** One line built by code from the finding's figures. */
  summary: string;
  surfaced: boolean;
}

export interface RecapFacts {
  forDate: string;
  yesterday: string;
  yesterdayWeekday: string;
  spentYesterday: { total: number; count: number; topCategories: Array<{ name: string; total: number }> };
  lateArrivals: { count: number; total: number; fromDate: string | null; fromWeekday: string | null };
  weekToDate: {
    spent: number;
    cap: number | null;
    remainingWeek: number | null;
    withinPlan: "yes" | "tight" | "over" | null;
  };
  position: {
    safeToSpendNow: number | null;
    availableUntilPayday: number | null;
    paydayDate: string | null;
    paydayWeekday: string | null;
    horizonKind: "payday" | "week_end";
    confidence: "firm" | "estimated";
    degraded: boolean;
  };
  billsNext3Days: Array<{ name: string; date: string; weekday: string; amount: number; dueTomorrow: boolean }>;
  /** The spine's review count. */
  reviewCount: number;
  /** The categorizer's review count (0 until that package is wired in). */
  categorizationReviewCount: number;
  /** reviewCount + categorizationReviewCount: "N charges need a look". */
  needsLookCount: number;
  /** The one next step, chosen by code: review, then a bill due tomorrow, else none. */
  nextStep: "review" | "bill_tomorrow" | null;
  debt: { payoffPct: number | null; confirmedPaymentsYesterday: number };
  freshness: { stale: boolean; staleReason: string | null; asOfBank: string | null; daysSinceBank: number | null };
  progress: { lowerThanLastWeek: boolean; debtPayment: boolean };
  findings: RecapFinding[];
}

// ── The categorizer's review count (feature-detected) ───────────────────────
// PR-A (the categorizer) is not on this base. Its package registers a counter
// here once it lands; until then the count is 0. A registry rather than a
// dynamic import because the server is bundled: an import of a module that does
// not exist cannot be probed at runtime.
type ReviewCounter = (householdId: string, ownerUserId: string) => Promise<number>;
let categorizationReviewCounter: ReviewCounter | null = null;

export function registerCategorizationReviewCount(fn: ReviewCounter | null): void {
  categorizationReviewCounter = fn;
}

async function categorizationReviewCount(householdId: string, ownerUserId: string): Promise<number> {
  if (!categorizationReviewCounter) return 0;
  try {
    const n = await categorizationReviewCounter(householdId, ownerUserId);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const r2 = (n: number): number => Math.round(n * 100) / 100;
const numOrNull = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? r2(n) : null;
};
const sumBy = <T,>(rows: T[], f: (r: T) => number): number => r2(rows.reduce((a, r) => a + f(r), 0));

function describeFinding(kind: string, payload: Record<string, unknown>): string {
  const n = (k: string): number | null => numOrNull(payload[k] as number | string | null | undefined);
  const usd = (v: number | null): string => (v === null ? "" : `$${Math.round(v).toLocaleString("en-US")}`);
  switch (kind) {
    case "bill_increase":
      return `a bill came in at ${usd(n("latest"))}, up ${usd(n("increase"))} from usual`;
    case "category_acceleration":
      return `a category is on pace to pass its monthly plan by ${usd(n("overBy"))}`;
    case "shortfall_before_income":
      return `cash may dip ${usd(n("shortBy"))} under the buffer before payday`;
    case "duplicate_charge":
      return `two matching charges of ${usd(n("amount"))} landed close together`;
    case "limit_near":
      return `the weekly limit is nearly used, ${usd(n("remainingWeek"))} left`;
    case "goal_behind":
      return "a goal is behind schedule";
    case "bank_stale":
      return "bank data is out of date";
    default:
      return "something needs a look";
  }
}

// ── The facts ───────────────────────────────────────────────────────────────
export async function recapFacts(
  householdId: string,
  ownerUserId: string,
  userId: string,
  forDate: string,
): Promise<RecapFacts> {
  const yesterday = addDaysISO(forDate, -1);

  // The cash signal and freshness are read once and handed to the position, so
  // its figures sit on the very curve the spine quotes.
  const cash = await computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS });
  const freshness = await computeBankFreshness(householdId, ownerUserId);
  const position = await buildMoneyPosition(householdId, ownerUserId, { cash, freshness });

  // Rows: two household weeks back from yesterday, through yesterday.
  const wk = weekBounds(yesterday);
  const lastWkStart = addDaysISO(wk.start, -7);
  const lastWkSame = addDaysISO(yesterday, -7);
  const rawFrom = addDaysISO(yesterday, -(LOOKBACK_DAYS - 1));
  const from = [rawFrom, lastWkStart, TRACKING_START].reduce((a, b) => (a > b ? a : b));

  // The previous recap's generation time bounds "late arrivals".
  const [prev] = await db
    .select({ generatedAt: recapsTable.generatedAt })
    .from(recapsTable)
    .where(and(eq(recapsTable.userId, userId), lt(recapsTable.forDate, forDate)))
    .orderBy(desc(recapsTable.forDate))
    .limit(1);

  const money = await loadMoneyContext(householdId, { start: from, end: yesterday });
  const rows = from <= yesterday ? await loadMovementRows(householdId, from, yesterday, money) : [];
  const disc = rows
    .map((r) => ({ r, cov: classifyMovement(r, money).coverage, spend: spendAmount(r) }))
    .filter((x) => DISCRETIONARY.has(x.cov) && x.spend > 0);

  // Yesterday.
  const yRows = disc.filter((x) => x.r.occurredOn === yesterday);
  const byCat = new Map<string, number>();
  for (const x of yRows) {
    const cat = x.r.categoryId ? money.categoriesById.get(x.r.categoryId)?.name : null;
    const name = safeName(cat, "Unfiled");
    byCat.set(name, (byCat.get(name) ?? 0) + x.spend);
  }
  const topCategories = [...byCat.entries()]
    .map(([name, total]) => ({ name, total: r2(total) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, TOP_CATEGORIES);
  const spentYesterday = { total: sumBy(yRows, (x) => x.spend), count: yRows.length, topCategories };

  // Late arrivals: older rows that only reached us after the last recap went out.
  let lateArrivals: RecapFacts["lateArrivals"] = { count: 0, total: 0, fromDate: null, fromWeekday: null };
  const olderEnd = addDaysISO(yesterday, -1);
  if (prev && from <= olderEnd) {
    const arrived = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          gte(transactionsTable.occurredOn, from),
          lte(transactionsTable.occurredOn, olderEnd),
          gt(transactionsTable.createdAt, prev.generatedAt),
        ),
      );
    const ids = new Set(arrived.map((a) => a.id));
    const late = disc.filter((x) => x.r.occurredOn < yesterday && ids.has(x.r.id));
    if (late.length) {
      const fromDate = late.map((x) => x.r.occurredOn).sort().at(-1)!;
      lateArrivals = {
        count: late.length,
        total: sumBy(late, (x) => x.spend),
        fromDate,
        fromWeekday: weekdayOf(fromDate),
      };
    }
  }

  // Progress: this week through yesterday against the same span last week.
  const thisWeek = sumBy(disc.filter((x) => x.r.occurredOn >= wk.start), (x) => x.spend);
  const lastWeek = sumBy(
    disc.filter((x) => x.r.occurredOn >= lastWkStart && x.r.occurredOn <= lastWkSame),
    (x) => x.spend,
  );

  // Money position (as of now; the recap is read on its own morning).
  const horizon = position.horizon;
  const paydayDate = position.paydayDate;
  const weekToDate = {
    spent: numOrNull(position.spentWeekDiscretionary) ?? 0,
    cap: numOrNull(position.weekCap),
    remainingWeek: numOrNull(position.remainingWeek),
    withinPlan: position.withinPlan,
  };

  // Bills in the next three days (today through forDate + 3).
  const summary = await buildBillsSummary(householdId, ownerUserId);
  const lastBillDay = addDaysISO(forDate, BILL_DAYS);
  const tomorrow = addDaysISO(forDate, 1);
  const billsNext3Days: RecapFacts["billsNext3Days"] = [];
  for (const b of summary.bills) {
    if (b.item.active !== "true" || !b.nextOccurrence) continue;
    if (b.nextOccurrence < forDate || b.nextOccurrence > lastBillDay) continue;
    billsNext3Days.push({
      name: safeName(b.item.name, "Bill"),
      date: b.nextOccurrence,
      weekday: weekdayOf(b.nextOccurrence),
      amount: Math.abs(numOrNull(b.monthlyAmount) ?? 0),
      dueTomorrow: b.nextOccurrence === tomorrow,
    });
  }
  for (const d of summary.debtMins) {
    if (!d.nextOccurrence || d.nextOccurrence < forDate || d.nextOccurrence > lastBillDay) continue;
    billsNext3Days.push({
      name: safeName(d.debtName, "Payment"),
      date: d.nextOccurrence,
      weekday: weekdayOf(d.nextOccurrence),
      amount: Math.abs(numOrNull(d.amount) ?? 0),
      dueTomorrow: d.nextOccurrence === tomorrow,
    });
  }
  billsNext3Days.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount || a.name.localeCompare(b.name));

  // Review counts and the one next step.
  const [reviewCount, catReview] = await Promise.all([
    computeReviewCount(householdId, ownerUserId),
    categorizationReviewCount(householdId, ownerUserId),
  ]);
  const needsLookCount = reviewCount + catReview;
  const nextStep: RecapFacts["nextStep"] =
    needsLookCount > 0 ? "review" : billsNext3Days.some((b) => b.dueTomorrow) ? "bill_tomorrow" : null;

  // Debt: the spine's percentage, and posted payments tagged to a debt yesterday.
  const debtRows = await db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId));
  const pct = payoffPct(await withPendingPayments(householdId, debtRows));
  const paid = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.occurredOn, yesterday),
        eq(transactionsTable.pending, false),
        isNotNull(transactionsTable.debtId),
        lt(transactionsTable.amount, "0"),
      ),
    );
  const confirmedPayments = paid.length;

  // Open findings (the monitor's), most serious first.
  const fRows = await db
    .select()
    .from(agentFindingsTable)
    .where(
      and(
        eq(agentFindingsTable.householdId, householdId),
        isNull(agentFindingsTable.resolvedAt),
        isNull(agentFindingsTable.dismissedAt),
      ),
    )
    .orderBy(desc(agentFindingsTable.lastSeen))
    .limit(20);
  const findings: RecapFinding[] = fRows
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      severity: f.severity as FindingSeverity,
      summary: describeFinding(f.kind, (f.payload ?? {}) as Record<string, unknown>),
      surfaced: f.surfacedInRecapId !== null,
    }))
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
    .slice(0, MAX_FINDINGS);

  // Freshness.
  const asOfBank = cash.signal.snapshotAt;
  let daysSinceBank: number | null = null;
  if (asOfBank) {
    const asOfDay = householdDayOf(asOfBank);
    daysSinceBank = Math.max(0, Math.round((Date.parse(forDate) - Date.parse(asOfDay)) / 86_400_000));
  }

  return {
    forDate,
    yesterday,
    yesterdayWeekday: weekdayOf(yesterday),
    spentYesterday,
    lateArrivals,
    weekToDate,
    position: {
      safeToSpendNow: numOrNull(position.safeToSpendNow),
      availableUntilPayday: numOrNull(position.availableUntilPayday),
      paydayDate,
      paydayWeekday: paydayDate ? weekdayOf(paydayDate) : null,
      horizonKind: horizon.kind,
      confidence: position.confidence,
      degraded: position.degraded,
    },
    billsNext3Days,
    reviewCount,
    categorizationReviewCount: catReview,
    needsLookCount,
    nextStep,
    debt: { payoffPct: pct === null ? null : Math.round(pct), confirmedPaymentsYesterday: confirmedPayments },
    freshness: {
      stale: freshness.stale,
      staleReason: freshness.staleReason,
      asOfBank,
      daysSinceBank,
    },
    progress: {
      lowerThanLastWeek: lastWeek > 0 && thisWeek < lastWeek,
      debtPayment: confirmedPayments > 0,
    },
    findings,
  };
}

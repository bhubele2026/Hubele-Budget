// (#850 — Spending overhaul, Phase 1; PR7 — one spending rule) Structured
// Spending-tab facts.
//
// Every outflow in the range goes through `classifyOutflow()` exactly once.
// What it calls spend is household spending (`householdSpend`), split into
// categorized (`realSpend`, which feeds every breakdown) and uncategorized.
// Everything else is surfaced under `excluded` for transparency.

import { and, eq, gte, lte } from "drizzle-orm";
import { db, transactionsTable, budgetCategoriesTable } from "@workspace/db";
import { cleanMerchant } from "./merchantNameExtract";
import {
  classifyMovement,
  classifyOutflow,
  isRealIncome,
  incomeAmount,
  spendAmount,
  type MovementContext,
  type MovementRow,
  type SpendContext,
  type SpendTxn,
} from "./spendingFilter";
import {
  findSupersededPendingForRange,
  type SupersededPending,
} from "./supersededPending";
import {
  effectiveFiling,
  uncategorizedCategoryIds,
  type FilingContext,
} from "./pendingFiling";
import { addDaysISO, householdTodayISO } from "./householdClock";

// The household only started tracking transactions on this date; ranges that
// reach further back are clamped so day/total math is not diluted by empty
// pre-tracking days. (Later this can be derived from the earliest txn.)
export const TRACKING_START = "2026-05-01";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface SpendingFacts {
  range: {
    start: string;
    end: string;
    daysCovered: number;
    trackingStart: string;
    floorApplied: boolean;
  };
  /**
   * Every purchase on any account, categorized or not:
   * `realSpend` + `uncategorized`. The spine's spent week/month.
   */
  householdSpend: { total: number; transactionCount: number };
  /** Categorized purchases only; the basis of every breakdown below. */
  realSpend: { total: number; transactionCount: number };
  realIncome: { total: number; transactionCount: number };
  unplanned: { total: number; transactionCount: number; transactions: { id: string; date: string; description: string; amount: number }[] };
  uncategorized: {
    total: number;
    transactionCount: number;
    sampleMerchants: { name: string; total: number; count: number }[];
  };
  excluded: {
    transfersTotal: number;
    debtPaymentsTotal: number;
    reimbursementTotal: number;
    ignoreTotal: number;
    /** Payments to a credit card from another account (rules 3, 8, 9). */
    cardPayments: number;
    /** Charges flagged reimbursable (rule 7). */
    reimbursable: number;
    /**
     * (PR7b) Pending outflows a posted row replaced (`loadSupersededPendingIds`).
     * The charge counts once, on its posted row; this is the half left out.
     */
    replacedPending: number;
  };
  byCategory: {
    categoryId: string;
    name: string;
    total: number;
    txnCount: number;
    pctOfRealSpend: number;
  }[];
  byMerchant: {
    name: string;
    total: number;
    count: number;
    sampleCategoryName: string | null;
    sampleCategoryId: string | null;
  }[];
  dailyBuckets: { date: string; total: number; count: number }[];
  dailyNet: { date: string; net: number }[];
  dayOfWeek: {
    dow: number;
    label: string;
    avgPerDay: number;
    total: number;
    topMerchants: { name: string; total: number }[];
  }[];
  monthlyTrends: {
    month: string;
    total: number;
    byTopCategory: { name: string; total: number }[];
  }[];
  reimbursable: {
    personalTotal: number;
    outstandingReimbursableTotal: number;
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function topByTotal<T extends { total: number }>(arr: T[], n: number): T[] {
  return [...arr].sort((a, b) => b.total - a.total).slice(0, n);
}

export async function buildSpendingFacts(
  householdId: string,
  rangeStart?: string,
  rangeEnd?: string,
  opts: {
    /**
     * (PR7b review M1; PR-D review M3) The pending pairs, when the caller
     * already has them — the spine reads them once for both of its windows.
     * They must be the whole-ledger answer for every row in this range: a
     * `findSupersededPendingForRange` result whose range covers it, or
     * `findSupersededPending`. Omitted, they are read here for this range.
     */
    supersede?: Pick<SupersededPending, "replacedIds" | "replacedBy">;
  } = {},
): Promise<SpendingFacts> {
  // (PR2) The default window is the household's last 30 days, ending on the
  // household's today (America/Chicago). It used to end on the UTC date, which
  // between 7pm and midnight Central is already tomorrow: tomorrow's
  // future-dated rows came in and the oldest day of the window fell out.
  const todayISO = householdTodayISO();
  const defaultEnd = todayISO;
  const defaultStart = addDaysISO(todayISO, -30);

  let start = rangeStart || defaultStart;
  const end = rangeEnd || defaultEnd;
  let floorApplied = false;
  if (start < TRACKING_START) {
    start = TRACKING_START;
    floorApplied = true;
  }

  const spanDays =
    Math.floor(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  const daysCovered = Number.isFinite(spanDays) ? Math.max(1, spanDays) : 1;

  // --- Context: categories + debt linkage --------------------------------
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      debtId: budgetCategoriesTable.debtId,
      kind: budgetCategoriesTable.kind,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));

  const categoriesById = new Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >();
  const debtCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId, kind: c.kind });
    if (c.debtId) debtCategoryIds.add(c.id);
  }
  const ctx: SpendContext = { categoriesById, debtCategoryIds };

  // --- Transactions in range ---------------------------------------------
  const txns = await db
    .select({
      id: transactionsTable.id,
      unplannedAllowance: transactionsTable.unplannedAllowance,
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      source: transactionsTable.source,
      reimbursable: transactionsTable.reimbursable,
      reimbursed: transactionsTable.reimbursed,
      // (PR7) The columns the one spending rule reads.
      debtId: transactionsTable.debtId,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      pfcDetailed: transactionsTable.pfcDetailed,
      // (PR-D review H1) The rest of the filing a posted row can inherit.
      weeklyAllowance: transactionsTable.weeklyAllowance,
      monthlyAllowance: transactionsTable.monthlyAllowance,
      weeklyBucket: transactionsTable.weeklyBucket,
      // (round 4, review H1/H2) THE signal `effectiveFiling` decides hand-vs-
      // automatic and transfer inheritance from.
      isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
      // (PR-H) Read alongside everything above so a row here can also be run
      // through `classifyMovement` (`classifierHouseholdSpend`, below) —
      // never added to any total in this function.
      plaidAccountId: transactionsTable.plaidAccountId,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, start),
        lte(transactionsTable.occurredOn, end),
      ),
    );

  // (PR7b) Pending rows a posted row replaced — the whole-ledger answer, so it
  // does not depend on where this window starts or ends. (PR-D review M3) Read
  // for this range (`findSupersededPendingForRange`), exact for every row in it.
  const supersede =
    opts.supersede ?? (await findSupersededPendingForRange(householdId, start, end));
  // (PR-D review H1; round 4) What a posted row inherits from the pending row
  // it replaced (`effectiveFiling`) — decided from the stored
  // `isTransferUserOverridden` flag, never by re-reading mapping rules.
  const uncategorizedIds = uncategorizedCategoryIds(cats);
  const filingCtx: FilingContext = { uncategorizedIds };

  // --- Accumulators -------------------------------------------------------
  let householdTotal = 0;
  let householdCount = 0;

  let realTotal = 0;
  let realCount = 0;

  let incomeTotal = 0;
  let incomeCount = 0;
  const dailyIncome = new Map<string, number>();

  let uncatTotal = 0;
  let uncatCount = 0;
  const uncatMerchants = new Map<string, { total: number; count: number }>();

  let transfersTotal = 0;
  let debtPaymentsTotal = 0;
  let reimbursementTotal = 0;
  let ignoreTotal = 0;
  let cardPaymentsTotal = 0;
  let reimbursableExcludedTotal = 0;
  let replacedPendingTotal = 0;

  const byCat = new Map<string, { total: number; txnCount: number }>();
  const byMerch = new Map<
    string,
    { total: number; count: number; catCounts: Map<string, number> }
  >();
  const daily = new Map<string, { total: number; count: number }>();
  const dowTotals = new Array(7).fill(0) as number[];
  // (#dow-drill) Per-weekday merchant totals so the "Spend by day of week"
  // chart can show WHAT was spent when a bar is clicked.
  const dowMerchants = Array.from(
    { length: 7 },
    () => new Map<string, number>(),
  );
  const monthly = new Map<string, { total: number; byCat: Map<string, number> }>();

  let personalTotal = 0; // Amex spend, personal (non-reimbursable)
  let outstandingReimbursableTotal = 0; // Amex reimbursable, not yet reimbursed

  let unplannedTotal = 0;
  let unplannedCount = 0;
  const unplannedRows: { id: string; date: string; description: string; amount: number }[] = [];
  for (const row of txns) {
    // (PR7b) The pending half of a pair its posted row replaced is not a second
    // charge: it counts nowhere (not spend, not income, not another bucket).
    // The posted row carries the charge, with its own date and amount.
    if (supersede.replacedIds.has(row.id)) {
      replacedPendingTotal += spendAmount(row);
      continue;
    }

    // (PR-D review H1) …and the filing the household put on the pending row,
    // wherever the posted row (inserted bare by sync) lacks its own. The same
    // helper the Budget month uses, so both pages file the row alike.
    const t = effectiveFiling(row, supersede.replacedBy.get(row.id), filingCtx);
    const tx: SpendTxn = t;
    const spend = spendAmount(tx);

    // Amex reimbursable accounting is independent of the real-spend buckets.
    if (t.source === "amex" && spend > 0) {
      if (t.reimbursable && !t.reimbursed) outstandingReimbursableTotal += spend;
      else if (!t.reimbursable) personalTotal += spend;
    }

    const c = classifyOutflow(tx, ctx);

    if (c.kind === "not_outflow") {
      // Inflow side. Only earned money counts (see `isRealIncome`); a transfer
      // in, a refund or a debt draw lands here and is deliberately ignored, so
      // "of income spent" is measured against what actually came IN.
      if (isRealIncome(tx, ctx)) {
        const inc = incomeAmount(tx);
        incomeTotal += inc;
        incomeCount += 1;
        dailyIncome.set(t.occurredOn, (dailyIncome.get(t.occurredOn) ?? 0) + inc);
      }
      continue; // nothing below this line applies to a non-outflow
    }

    if (c.kind !== "spend") {
      // Excluded outflow — bucketed for the transparency panel by the rule
      // that excluded it.
      switch (c.kind) {
        case "transfer":
        case "bank_noise":
          transfersTotal += spend;
          break;
        case "debt_payment":
          debtPaymentsTotal += spend;
          break;
        case "card_payment":
          cardPaymentsTotal += spend;
          break;
        case "reimbursable":
          reimbursableExcludedTotal += spend;
          break;
        case "excluded_category": {
          const name = (categoriesById.get(t.categoryId ?? "")?.name ?? "")
            .trim()
            .toLowerCase();
          if (name === "reimbursement") reimbursementTotal += spend;
          else if (name === "ignore") ignoreTotal += spend;
          else transfersTotal += spend; // Transfer, Transfers in/out
          break;
        }
        case "income":
          // An outflow in an income category (a clawback, a reversed
          // deposit) is neither spending nor one of the panel's buckets.
          break;
      }
      continue;
    }

    // ── Household spending ────────────────────────────────────────────────
    householdTotal += spend;
    householdCount += 1;

    // Unplanned means explicitly assigned to UN, not merely uncategorized.
    // Any purchase can be UN, categorized or not; nothing excluded above can.
    if (t.unplannedAllowance) {
      unplannedTotal += spend;
      unplannedCount++;
      unplannedRows.push({ id: t.id, date: t.occurredOn, description: cleanMerchant(t.description) || t.description, amount: round2(spend) });
    }

    if (c.categorized) {
      realTotal += spend;
      realCount += 1;

      const cid = t.categoryId as string;
      const cat = byCat.get(cid) ?? { total: 0, txnCount: 0 };
      cat.total += spend;
      cat.txnCount += 1;
      byCat.set(cid, cat);

      const name = cleanMerchant(t.description) || "Unknown";
      const m = byMerch.get(name) ?? { total: 0, count: 0, catCounts: new Map() };
      m.total += spend;
      m.count += 1;
      m.catCounts.set(cid, (m.catCounts.get(cid) ?? 0) + 1);
      byMerch.set(name, m);

      const day = daily.get(t.occurredOn) ?? { total: 0, count: 0 };
      day.total += spend;
      day.count += 1;
      daily.set(t.occurredOn, day);

      const dow = new Date(`${t.occurredOn}T00:00:00Z`).getUTCDay();
      dowTotals[dow] += spend;
      dowMerchants[dow].set(name, (dowMerchants[dow].get(name) ?? 0) + spend);

      const month = t.occurredOn.slice(0, 7);
      const mo = monthly.get(month) ?? { total: 0, byCat: new Map() };
      mo.total += spend;
      mo.byCat.set(cid, (mo.byCat.get(cid) ?? 0) + spend);
      monthly.set(month, mo);
    } else {
      uncatTotal += spend;
      uncatCount += 1;
      const name = cleanMerchant(t.description) || "Unknown";
      const um = uncatMerchants.get(name) ?? { total: 0, count: 0 };
      um.total += spend;
      um.count += 1;
      uncatMerchants.set(name, um);
    }
  }

  // --- Shape outputs ------------------------------------------------------
  const byCategory = topByTotal(
    [...byCat.entries()].map(([categoryId, v]) => ({
      categoryId,
      name: categoriesById.get(categoryId)?.name ?? "Unknown",
      total: round2(v.total),
      txnCount: v.txnCount,
      pctOfRealSpend: realTotal > 0 ? round2((v.total / realTotal) * 100) : 0,
    })),
    50,
  );

  const byMerchant = topByTotal(
    [...byMerch.entries()].map(([name, v]) => {
      let sampleCategoryId: string | null = null;
      let best = -1;
      for (const [cid, count] of v.catCounts) {
        if (count > best) {
          best = count;
          sampleCategoryId = cid;
        }
      }
      return {
        name,
        total: round2(v.total),
        count: v.count,
        sampleCategoryId,
        sampleCategoryName: sampleCategoryId
          ? categoriesById.get(sampleCategoryId)?.name ?? null
          : null,
      };
    }),
    10,
  );

  const sampleMerchants = topByTotal(
    [...uncatMerchants.entries()].map(([name, v]) => ({
      name,
      total: round2(v.total),
      count: v.count,
    })),
    5,
  );

  const dailyBuckets = [...daily.entries()]
    .map(([date, v]) => ({ date, total: round2(v.total), count: v.count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Count how many of each weekday fall inside [start, end] for avgPerDay.
  const dowOccurrences = new Array(7).fill(0) as number[];
  for (let i = 0; i < daysCovered; i += 1) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    dowOccurrences[d.getUTCDay()] += 1;
  }
  const dayOfWeek = DOW_LABELS.map((label, dow) => ({
    dow,
    label,
    total: round2(dowTotals[dow]),
    avgPerDay:
      dowOccurrences[dow] > 0 ? round2(dowTotals[dow] / dowOccurrences[dow]) : 0,
    topMerchants: [...dowMerchants[dow].entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, total]) => ({ name, total: round2(total) })),
  }));

  const monthlyTrends = [...monthly.entries()]
    .map(([month, v]) => ({
      month,
      total: round2(v.total),
      byTopCategory: topByTotal(
        [...v.byCat.entries()].map(([cid, total]) => ({
          name: categoriesById.get(cid)?.name ?? "Unknown",
          total: round2(total),
        })),
        5,
      ),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  // Daily net across EVERY day the range covers, income minus real spend, in
  // date order. Empty days are emitted as 0 on purpose: a sparkline drawn only
  // over days that happened to have activity compresses quiet stretches and
  // reads as a busier month than it was.
  const dailyNet: { date: string; net: number }[] = [];
  {
    const cursor = new Date(`${start}T00:00:00Z`);
    const last = Date.parse(`${end}T00:00:00Z`);
    while (Number.isFinite(last) && cursor.getTime() <= last) {
      const date = isoDate(cursor);
      const inc = dailyIncome.get(date) ?? 0;
      const out = daily.get(date)?.total ?? 0;
      dailyNet.push({ date, net: round2(inc - out) });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  return {
    range: {
      start,
      end,
      daysCovered,
      trackingStart: TRACKING_START,
      floorApplied,
    },
    householdSpend: { total: round2(householdTotal), transactionCount: householdCount },
    unplanned: { total: round2(unplannedTotal), transactionCount: unplannedCount, transactions: unplannedRows.sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date)).slice(0, 20) },
    realSpend: { total: round2(realTotal), transactionCount: realCount },
    realIncome: { total: round2(incomeTotal), transactionCount: incomeCount },
    uncategorized: {
      total: round2(uncatTotal),
      transactionCount: uncatCount,
      sampleMerchants,
    },
    excluded: {
      transfersTotal: round2(transfersTotal),
      debtPaymentsTotal: round2(debtPaymentsTotal),
      reimbursementTotal: round2(reimbursementTotal),
      ignoreTotal: round2(ignoreTotal),
      cardPayments: round2(cardPaymentsTotal),
      reimbursable: round2(reimbursableExcludedTotal),
      replacedPending: round2(replacedPendingTotal),
    },
    byCategory,
    byMerchant,
    dailyBuckets,
    dailyNet,
    dayOfWeek,
    monthlyTrends,
    reimbursable: {
      personalTotal: round2(personalTotal),
      outstandingReimbursableTotal: round2(outstandingReimbursableTotal),
    },
  };
}

// ── PR-H: the classifier's view of the same figure (parity only) ───────────

/**
 * ⭐ (PR-H, owner decisions 7 and 12) `householdSpend` above, computed from
 * `classifyMovement` coverage instead of `classifyOutflow` directly — the two
 * cannot silently diverge on what counts as household spend once a caller
 * switches to this.
 *
 * ⚠️ NOT CALLED BY `buildSpendingFacts` YET, ON PURPOSE. Wiring it into the
 * live request path would add a query (`loadMoneyContext`'s confirmed-match
 * read) and a second full pass over the range's rows for a number nothing
 * displays — exactly what this performance-conscious codebase's entry-graph
 * and query-shape rules exist to keep out. This is the switch PR8r/PR10 will
 * flip. See docs/reviews/2026-09-14-household-money-core.md.
 *
 * mode "today" (the default) IS `buildSpendingFacts().householdSpend`, total
 * and count, on any ledger — checked on a seeded randomized ledger
 * (`spendingFactsClassifierParity.integration.test.ts`) and over the spine's
 * own month and week windows (`spineParity.integration.test.ts`). Two
 * coverages need today's rule spelled out, because `classifyMovement` places
 * them differently from `classifyOutflow`:
 *   - a confirmed bill match counts like any other purchase (today's rule has
 *     no idea of a match);
 *   - (review M1) a reimbursable row never counts, whatever flag or match it
 *     carries: today's rule 7 fires before either is looked at, while
 *     `classifyMovement` lets a confirmed match (step 2) outrank
 *     `reimbursable` (step 3).
 * mode "forward" is coverage alone — what switching the figure onto
 * `classifyMovement`, as section A specifies it, would do: a confirmed match
 * (carried to its posted row) stops counting — decision 12: the bill is
 * already in the plan. (PR8r, the owner's answer 1) A reimbursable row that
 * carries an allowance flag no longer counts under it: reimbursable comes
 * before the flags, so the two modes agree on every reimbursable row that no
 * confirmed match claims.
 *
 * (PR8r, PR-H review N2) Any other `mode` throws.
 *
 * `rows` must already be in EFFECTIVE-FILING form (`effectiveFiling`) with
 * replaced-pending rows left out — the same preparation `buildSpendingFacts`
 * does before it calls `classifyOutflow`. This function does not re-pair or
 * re-file; it only classifies and sums.
 */
export function classifierHouseholdSpend(
  rows: readonly MovementRow[],
  ctx: MovementContext,
  opts: { mode?: "today" | "forward" } = {},
): { total: number; transactionCount: number } {
  const mode = opts.mode ?? "today";
  if (mode !== "today" && mode !== "forward") {
    throw new Error(`classifierHouseholdSpend: unknown mode ${JSON.stringify(mode)}`);
  }
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const { coverage } = classifyMovement(row, ctx);
    const counts =
      coverage === "unplanned" ||
      coverage === "allowance_monthly" ||
      coverage === "allowance_weekly" ||
      coverage === "needs_classification" ||
      (coverage === "bill_matched" && mode === "today");
    // Today's rule 7: reimbursable is out before any flag or match counts.
    if (counts && !(mode === "today" && row.reimbursable)) {
      total += spendAmount(row);
      count += 1;
    }
  }
  return { total: round2(total), transactionCount: count };
}

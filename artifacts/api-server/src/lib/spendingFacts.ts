// (#850 — Spending overhaul, Phase 1) Structured Spending-tab facts.
//
// Builds the clean, merchant-centric fact set the Phase 2 Spending UI will
// render, on top of the isRealSpend() definition of spending. Transfers,
// debt payments, reimbursements, and ignore-category rows are excluded from
// "real spend" and surfaced separately under `excluded` for transparency.

import { and, eq, gte, lte } from "drizzle-orm";
import { db, transactionsTable, budgetCategoriesTable } from "@workspace/db";
import { cleanMerchant } from "./merchantNameExtract";
import {
  isRealSpend,
  isUncategorizedSpend,
  isDebtCategory,
  isExcludedCategoryName,
  matchesTransferPattern,
  spendAmount,
  type SpendContext,
  type SpendTxn,
} from "./spendingFilter";

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
  realSpend: { total: number; transactionCount: number };
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
  dayOfWeek: { dow: number; label: string; avgPerDay: number; total: number }[];
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
): Promise<SpendingFacts> {
  const today = new Date();
  const defaultEnd = isoDate(today);
  const back30 = new Date(today);
  back30.setUTCDate(back30.getUTCDate() - 30);
  const defaultStart = isoDate(back30);

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
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));

  const categoriesById = new Map<string, { name: string; debtId: string | null }>();
  const debtCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId });
    if (c.debtId) debtCategoryIds.add(c.id);
  }
  const ctx: SpendContext = { categoriesById, debtCategoryIds };

  // --- Transactions in range ---------------------------------------------
  const txns = await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      source: transactionsTable.source,
      reimbursable: transactionsTable.reimbursable,
      reimbursed: transactionsTable.reimbursed,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, start),
        lte(transactionsTable.occurredOn, end),
      ),
    );

  // --- Accumulators -------------------------------------------------------
  let realTotal = 0;
  let realCount = 0;

  let uncatTotal = 0;
  let uncatCount = 0;
  const uncatMerchants = new Map<string, { total: number; count: number }>();

  let transfersTotal = 0;
  let debtPaymentsTotal = 0;
  let reimbursementTotal = 0;
  let ignoreTotal = 0;

  const byCat = new Map<string, { total: number; txnCount: number }>();
  const byMerch = new Map<
    string,
    { total: number; count: number; catCounts: Map<string, number> }
  >();
  const daily = new Map<string, { total: number; count: number }>();
  const dowTotals = new Array(7).fill(0) as number[];
  const monthly = new Map<string, { total: number; byCat: Map<string, number> }>();

  let personalTotal = 0; // Amex spend, personal (non-reimbursable)
  let outstandingReimbursableTotal = 0; // Amex reimbursable, not yet reimbursed

  for (const t of txns) {
    const tx = t as unknown as SpendTxn;
    const spend = spendAmount(tx);

    // Amex reimbursable accounting is independent of the real-spend buckets.
    if (t.source === "amex" && spend > 0) {
      if (t.reimbursable && !t.reimbursed) outstandingReimbursableTotal += spend;
      else if (!t.reimbursable) personalTotal += spend;
    }

    if (spend <= 0) continue; // inflow / refund / non-outflow — skip

    if (isRealSpend(tx, ctx)) {
      realTotal += spend;
      realCount += 1;

      const cid = t.categoryId as string;
      const c = byCat.get(cid) ?? { total: 0, txnCount: 0 };
      c.total += spend;
      c.txnCount += 1;
      byCat.set(cid, c);

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

      const month = t.occurredOn.slice(0, 7);
      const mo = monthly.get(month) ?? { total: 0, byCat: new Map() };
      mo.total += spend;
      mo.byCat.set(cid, (mo.byCat.get(cid) ?? 0) + spend);
      monthly.set(month, mo);
    } else if (!t.categoryId && isUncategorizedSpend(tx)) {
      uncatTotal += spend;
      uncatCount += 1;
      const name = cleanMerchant(t.description) || "Unknown";
      const um = uncatMerchants.get(name) ?? { total: 0, count: 0 };
      um.total += spend;
      um.count += 1;
      uncatMerchants.set(name, um);
    } else {
      // Excluded outflow — classify for the transparency panel. Debt
      // linkage is checked FIRST: many debt payments also match the
      // transfer/payment description patterns (ACH PMT, autopay), and a
      // category linked to a tracked debt is unambiguously a debt payment.
      const catName = t.categoryId
        ? categoriesById.get(t.categoryId)?.name ?? ""
        : "";
      if (isDebtCategory(tx, ctx)) {
        debtPaymentsTotal += spend;
      } else if (
        t.isTransfer ||
        matchesTransferPattern(t.description) ||
        /transfer/i.test(catName)
      ) {
        transfersTotal += spend;
      } else if (catName.trim().toLowerCase() === "reimbursement") {
        reimbursementTotal += spend;
      } else if (catName.trim().toLowerCase() === "ignore") {
        ignoreTotal += spend;
      } else if (isExcludedCategoryName(catName)) {
        // Remaining named exclusions (e.g. "Transfers in/out") -> transfers.
        transfersTotal += spend;
      }
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

  return {
    range: {
      start,
      end,
      daysCovered,
      trackingStart: TRACKING_START,
      floorApplied,
    },
    realSpend: { total: round2(realTotal), transactionCount: realCount },
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
    },
    byCategory,
    byMerchant,
    dailyBuckets,
    dayOfWeek,
    monthlyTrends,
    reimbursable: {
      personalTotal: round2(personalTotal),
      outstandingReimbursableTotal: round2(outstandingReimbursableTotal),
    },
  };
}

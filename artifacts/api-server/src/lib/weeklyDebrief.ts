// (#766 — Phase D1) Weekly Debrief variance computation library.
//
// Pure helpers + the main `computeWeekVariance` reducer that powers
// `GET /api/debrief/weeks/:weekStart`. See lib/db schema comments
// (`weeklyDebriefsTable`) for the snapshot type contract.

import { and, eq, gte, lte, or, sql, isNull, inArray } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  forecastResolutionsTable,
  recurringItemsTable,
  transactionsTable,
  type DebriefActionsSummary,
  type DebriefVarianceCategoryBucket,
  type DebriefVariancePlanItem,
  type DebriefVarianceSnapshot,
  type DebriefVarianceTxnItem,
} from "@workspace/db";
import { expandItem, parseISO, fmtISO, addDays } from "./cashSignal";

// -- Date helpers -----------------------------------------------------

/** Sunday of the week containing `date`. Accepts Date or YYYY-MM-DD. */
export function weekStartFor(date: Date | string): string {
  const d = typeof date === "string" ? parseISO(date) : new Date(date);
  const dow = d.getDay(); // 0 = Sunday
  const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  return fmtISO(sunday);
}

/** Saturday of the week containing `date`. */
export function weekEndFor(date: Date | string): string {
  const sun = parseISO(weekStartFor(date));
  return fmtISO(addDays(sun, 6));
}

/**
 * Bucket a transaction into its Sun–Sat week.
 *
 * Per Phase D1 design decision #2, the bucketing date is the
 * **pending** date (`occurredAt`), falling back to `occurredOn` when
 * `occurredAt` is null (manual entries, very old plaid rows). NOT the
 * post date — pending is when the bank actually saw the swipe.
 */
export function txnWeekKey(t: {
  occurredAt?: string | null;
  occurredOn: string;
}): string {
  const dateStr = t.occurredAt ? t.occurredAt.slice(0, 10) : t.occurredOn;
  return weekStartFor(dateStr);
}

/** Bucket a planned recurring event into its Sun–Sat week. */
export function planWeekKey(e: { date: string }): string {
  return weekStartFor(e.date);
}

// -- isBankRow predicate ---------------------------------------------
//
// (#791) Previous semantics scoped the Debrief actuals to a single
// "configured checking" Plaid account and hard-excluded any row
// whose source was `amex` / `plaid:amex`. That made the Debrief
// blind to legitimate categorized Amex spend — Income, Expenses and
// every category bucket collapsed to $0 whenever Chase was missing
// even though Amex had a full week of categorized transactions.
//
// New rule: a row is countable variance iff it is NOT flagged as a
// pure transfer between the household's own accounts (see
// `is_transfer` on the transactions table — this is the same flag
// the rest of the app uses to keep card-payments / internal moves
// out of allowance/budget math). Excluded-category filtering
// (#783) still happens separately at the category layer.
//
// `loadConfiguredCheckingExternalId` is retained as a no-op stub
// for backwards compatibility with the route caller; the value is
// no longer consulted.

export async function loadConfiguredCheckingExternalId(
  householdId: string,
  ownerUserId: string,
): Promise<string | null> {
  // No longer used by the Debrief variance computation (#791) — the
  // bank-row predicate now accepts any non-transfer household row.
  // Kept as a stub so callers (route post-lock-additions sweep) keep
  // compiling without a churn diff; safe to delete once the route is
  // migrated off of it.
  void householdId;
  void ownerUserId;
  return null;
}

export function makeIsBankRow(_configuredCheckingExternalId?: string | null) {
  void _configuredCheckingExternalId;
  return function isBankRow(
    _source: string | null | undefined,
    _plaidAccountId: string | null | undefined,
    isTransfer?: boolean | null | undefined,
  ): boolean {
    // Pure transfers between the household's own accounts are not
    // variance — same guard the allowance / forecast pages use.
    if (isTransfer === true) return false;
    return true;
  };
}

// -- Money helpers ----------------------------------------------------

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function abs(n: string | number): number {
  return Math.abs(Number(n) || 0);
}

// -- Main reducer -----------------------------------------------------

export interface ComputeWeekVarianceOptions {
  // Override "now" — used by the locked-week post-additions logic so
  // late-syncing rows can be filtered relative to a lockedAt instead
  // of the wall clock.
  now?: Date;
}

/**
 * Build a complete `DebriefVarianceSnapshot` for one Sun–Sat week.
 *
 * Inputs are read from the live database (recurring_items,
 * transactions, forecast_resolutions). No mutation — the caller is
 * responsible for persisting the snapshot when locking.
 */
export async function computeWeekVariance(
  householdId: string,
  weekStart: string,
  opts: ComputeWeekVarianceOptions = {},
): Promise<DebriefVarianceSnapshot> {
  const weekEnd = weekEndFor(weekStart);
  const fromDate = parseISO(weekStart);
  const toDate = parseISO(weekEnd);
  const now = opts.now ?? new Date();

  // Recurring plans expanded into this Sun–Sat window.
  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));

  // For the ±7-day income-timing rule we need to know about income
  // plans whose forecast date falls in the ±7-day pad around the
  // week, even if their forecast date is outside. We expand recurring
  // items across [weekStart - 7d, weekEnd + 7d] and then filter.
  const padFrom = addDays(fromDate, -7);
  const padTo = addDays(toDate, 7);

  type Plan = {
    recurringItemId: string;
    name: string;
    kind: "income" | "expense";
    forecastDate: string;
    forecastAmount: number; // absolute
    categoryId: string | null;
  };
  const plansAll: Plan[] = [];
  for (const item of recurring) {
    for (const ev of expandItem(item, padFrom, padTo)) {
      plansAll.push({
        recurringItemId: item.id,
        name: item.name,
        kind: ev.kind,
        forecastDate: ev.date,
        forecastAmount: Math.abs(ev.amount),
        categoryId: item.categoryId ?? null,
      });
    }
  }
  const plansInWeek = plansAll.filter(
    (p) => p.forecastDate >= weekStart && p.forecastDate <= weekEnd,
  );
  const incomePlansInPad = plansAll.filter(
    (p) => p.kind === "income" && !(p.forecastDate >= weekStart && p.forecastDate <= weekEnd),
  );
  // Filtering of excluded-category plans happens after we load
  // excludedCategoryIds below (depends on a DB query). See the
  // re-assignments where bankTxns is built.

  // (#791) Bank-row predicate no longer scoped to a single
  // "configured checking" Plaid account — every household
  // non-transfer row contributes to actuals.
  const isBankRow = makeIsBankRow();

  // Transactions whose pending-date (or fallback occurredOn) falls in
  // the week. We need a wider SQL filter than just occurredOn because
  // a row with occurredAt = Saturday but occurredOn = Monday belongs
  // to the prior week. Easiest: filter on (occurredAt window) OR
  // (occurredAt null AND occurredOn window).
  const txnsAll = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        or(
          and(
            sql`${transactionsTable.occurredAt} IS NOT NULL`,
            gte(
              sql`${transactionsTable.occurredAt}::date`,
              sql`${weekStart}::date`,
            ),
            lte(
              sql`${transactionsTable.occurredAt}::date`,
              sql`${weekEnd}::date`,
            ),
          ),
          and(
            isNull(transactionsTable.occurredAt),
            gte(transactionsTable.occurredOn, weekStart),
            lte(transactionsTable.occurredOn, weekEnd),
          ),
        ),
      ),
    );
  const bankTxnsPreExclude = txnsAll.filter((t) =>
    isBankRow(t.source, t.plaidAccountId, t.isTransfer),
  );

  // (#783) Exclude system-managed categories (Ignore / Transfer /
  // Uncategorized — any row flagged exclude_from_budget) from the
  // variance computation. These transactions and any recurring plans
  // pointed at them should not affect actualIncome/actualExpenses,
  // byCategory, unmatched plans, or unplanned-charge action panels.
  // Categories are scoped by householdId (same as everything else
  // here); a single input-side filter covers all downstream
  // accumulators.
  const excludedCatRows = await db
    .select({ id: budgetCategoriesTable.id })
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.householdId, householdId),
        eq(budgetCategoriesTable.excludeFromBudget, true),
      ),
    );
  const excludedCategoryIds = new Set(excludedCatRows.map((r) => r.id));
  const isExcludedTxn = (categoryId: string | null | undefined): boolean =>
    !!categoryId && excludedCategoryIds.has(categoryId);

  const bankTxns = bankTxnsPreExclude.filter((t) => !isExcludedTxn(t.categoryId));

  // (#783) Defensively drop recurring-plan occurrences that point at
  // an excluded system category so they never feed planItems /
  // unmatchedPlans / byCategory. Mutate via reassignment so the rest
  // of the function sees the filtered lists.
  const plansInWeekFiltered = plansInWeek.filter(
    (p) => !isExcludedTxn(p.categoryId),
  );
  const incomePlansInPadFiltered = incomePlansInPad.filter(
    (p) => !isExcludedTxn(p.categoryId),
  );

  // forecast_resolutions tied to plans in (or near) this week — we
  // need rescheduled-OUT rows too so we know not to count them as
  // unmatched.
  const resolutionRows = await db
    .select()
    .from(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, householdId));

  // Join matched txns so we can read their dates/amounts.
  const matchedTxnIds = Array.from(
    new Set(
      resolutionRows
        .map((r) => r.matchedTxnId)
        .filter((x): x is string => !!x),
    ),
  );
  const matchedTxnRows = matchedTxnIds.length
    ? await db
        .select()
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, householdId),
            inArray(transactionsTable.id, matchedTxnIds),
          ),
        )
    : [];
  const matchedTxnById = new Map(matchedTxnRows.map((t) => [t.id, t]));

  // Index resolutions by (recurringItemId, occurrenceDate).
  const resByKey = new Map<string, typeof resolutionRows>();
  for (const r of resolutionRows) {
    if (!r.recurringItemId || !r.occurrenceDate) continue;
    const k = `${r.recurringItemId}|${r.occurrenceDate}`;
    const arr = resByKey.get(k) ?? [];
    arr.push(r);
    resByKey.set(k, arr);
  }

  // -- Build plan rows ------------------------------------------------
  const planItems: DebriefVariancePlanItem[] = [];
  let plannedIncome = 0;
  let plannedExpenses = 0;

  for (const p of plansInWeekFiltered) {
    plannedIncome += p.kind === "income" ? p.forecastAmount : 0;
    plannedExpenses += p.kind === "expense" ? p.forecastAmount : 0;

    const k = `${p.recurringItemId}|${p.forecastDate}`;
    const rs = resByKey.get(k) ?? [];
    const matched = rs.find((r) => r.status === "matched");
    const rescheduled = rs.find((r) => r.status === "rescheduled");
    const missedOrSkipped = rs.find(
      (r) => r.status === "missed" || r.status === "skipped",
    );

    if (matched && matched.matchedTxnId) {
      const txn = matchedTxnById.get(matched.matchedTxnId);
      const actualAbs = txn ? abs(txn.amount) : p.forecastAmount;
      const variance =
        p.kind === "income"
          ? actualAbs - p.forecastAmount
          : actualAbs - p.forecastAmount;
      planItems.push({
        recurringItemId: p.recurringItemId,
        name: p.name,
        kind: p.kind,
        forecastDate: p.forecastDate,
        forecastAmount: money(p.forecastAmount),
        categoryId: p.categoryId,
        status: "matched",
        matchedTxnId: matched.matchedTxnId,
        matchedDate: txn?.occurredAt?.slice(0, 10) ?? txn?.occurredOn ?? null,
        matchedAmount: txn ? money(abs(txn.amount)) : null,
        rescheduledTo: null,
        varianceAmount: money(variance),
      });
      continue;
    }
    if (rescheduled) {
      planItems.push({
        recurringItemId: p.recurringItemId,
        name: p.name,
        kind: p.kind,
        forecastDate: p.forecastDate,
        forecastAmount: money(p.forecastAmount),
        categoryId: p.categoryId,
        status: "rescheduled",
        matchedTxnId: null,
        matchedDate: null,
        matchedAmount: null,
        rescheduledTo: rescheduled.rescheduledTo
          ? weekStartFor(rescheduled.rescheduledTo)
          : null,
        varianceAmount: money(0),
      });
      continue;
    }
    if (missedOrSkipped) {
      // missed: user confirms the planned event did not happen. Keep
      //         planned-totals contribution (already added above) and
      //         render varianceAmount = -forecastAmount so the week's
      //         net variance reflects the un-spent / un-received amount.
      // skipped: user is dismissing this occurrence entirely (e.g.
      //         duplicate, retired). Keep planned-totals contribution
      //         consistent with rescheduled (zero variance — user said
      //         "don't count this against me"). For an expense this
      //         under-reports actual spend honestly because nothing
      //         hit the bank for it.
      planItems.push({
        recurringItemId: p.recurringItemId,
        name: p.name,
        kind: p.kind,
        forecastDate: p.forecastDate,
        forecastAmount: money(p.forecastAmount),
        categoryId: p.categoryId,
        status: missedOrSkipped.status as "missed" | "skipped",
        matchedTxnId: null,
        matchedDate: null,
        matchedAmount: null,
        rescheduledTo: null,
        varianceAmount: money(
          missedOrSkipped.status === "missed" ? -p.forecastAmount : 0,
        ),
      });
      continue;
    }

    // Income timing rule: if this is an income plan and there's a
    // matched resolution within ±7 days (pointing at the same item
    // but a different occurrenceDate), treat as on-time, $0 variance.
    if (p.kind === "income") {
      const onTime = resolutionRows.find((r) => {
        if (r.status !== "matched") return false;
        if (r.recurringItemId !== p.recurringItemId) return false;
        if (!r.matchedTxnId) return false;
        const txn = matchedTxnById.get(r.matchedTxnId);
        if (!txn) return false;
        const txnDate = txn.occurredAt?.slice(0, 10) ?? txn.occurredOn;
        const diff = Math.abs(
          (parseISO(txnDate).getTime() - parseISO(p.forecastDate).getTime()) /
            (1000 * 60 * 60 * 24),
        );
        return diff <= 7;
      });
      if (onTime && onTime.matchedTxnId) {
        const txn = matchedTxnById.get(onTime.matchedTxnId)!;
        planItems.push({
          recurringItemId: p.recurringItemId,
          name: p.name,
          kind: p.kind,
          forecastDate: p.forecastDate,
          forecastAmount: money(p.forecastAmount),
          categoryId: p.categoryId,
          status: "matched_on_time",
          matchedTxnId: onTime.matchedTxnId,
          matchedDate: txn.occurredAt?.slice(0, 10) ?? txn.occurredOn,
          matchedAmount: money(abs(txn.amount)),
          rescheduledTo: null,
          varianceAmount: money(0),
        });
        continue;
      }
    }

    planItems.push({
      recurringItemId: p.recurringItemId,
      name: p.name,
      kind: p.kind,
      forecastDate: p.forecastDate,
      forecastAmount: money(p.forecastAmount),
      categoryId: p.categoryId,
      status: "unmatched",
      matchedTxnId: null,
      matchedDate: null,
      matchedAmount: null,
      rescheduledTo: null,
      varianceAmount: money(
        p.kind === "income" ? -p.forecastAmount : -p.forecastAmount,
      ),
    });
  }

  // Income plans whose forecast date is OUTSIDE this week but inside
  // the ±7-day pad — if matched in this week, treat as on-time with
  // $0 variance and include in this week's plan list so the week
  // accounts for them.
  for (const p of incomePlansInPadFiltered) {
    const hits = resolutionRows.filter(
      (r) =>
        r.status === "matched" &&
        r.recurringItemId === p.recurringItemId &&
        r.matchedTxnId &&
        (() => {
          const txn = matchedTxnById.get(r.matchedTxnId!);
          if (!txn) return false;
          const txnDate = txn.occurredAt?.slice(0, 10) ?? txn.occurredOn;
          return txnDate >= weekStart && txnDate <= weekEnd;
        })(),
    );
    for (const r of hits) {
      const diff = Math.abs(
        (parseISO(r.occurrenceDate ?? p.forecastDate).getTime() -
          parseISO(p.forecastDate).getTime()) /
          (1000 * 60 * 60 * 24),
      );
      if (diff > 7) continue;
      const txn = matchedTxnById.get(r.matchedTxnId!)!;
      // Avoid double-counting: if planItems already has a hit for
      // this recurring + matched txn, skip.
      if (planItems.some((pi) => pi.matchedTxnId === r.matchedTxnId)) continue;
      planItems.push({
        recurringItemId: p.recurringItemId,
        name: p.name,
        kind: p.kind,
        forecastDate: p.forecastDate,
        forecastAmount: money(p.forecastAmount),
        categoryId: p.categoryId,
        status: "matched_on_time",
        matchedTxnId: r.matchedTxnId,
        matchedDate: txn.occurredAt?.slice(0, 10) ?? txn.occurredOn,
        matchedAmount: money(abs(txn.amount)),
        rescheduledTo: null,
        varianceAmount: money(0),
      });
    }
  }

  // -- Build txn rows -------------------------------------------------
  // Three states for a bank txn this week:
  //   * matched                 — resolution.status='matched' + matchedTxnId.
  //                                Counts toward planned spend; drops from open.
  //   * acknowledged_unplanned  — resolution.status in
  //                                ('ignored_unforecasted','unplanned') +
  //                                matchedTxnId. User clicked Accept Unplanned
  //                                in the Debrief — drops from open so the
  //                                week can lock, but the dollars STAY counted
  //                                as unplanned variance. Critical for honest
  //                                "variance accuracy": acknowledging a
  //                                surprise charge must not pretend you
  //                                planned it.
  //   * unplanned               — no resolution at all; still open.
  const matchedTxnSet = new Set(
    resolutionRows
      .filter((r) => r.status === "matched" && !!r.matchedTxnId)
      .map((r) => r.matchedTxnId as string),
  );
  const acknowledgedTxnSet = new Set(
    resolutionRows
      .filter(
        (r) =>
          (r.status === "ignored_unforecasted" || r.status === "unplanned") &&
          !!r.matchedTxnId,
      )
      .map((r) => r.matchedTxnId as string),
  );
  const matchedRecurringByTxn = new Map<string, string>();
  for (const r of resolutionRows) {
    if (
      r.status === "matched" &&
      r.matchedTxnId &&
      r.recurringItemId
    ) {
      matchedRecurringByTxn.set(r.matchedTxnId, r.recurringItemId);
    }
  }

  const txnItems: DebriefVarianceTxnItem[] = [];
  let actualIncome = 0;
  let actualExpenses = 0;

  for (const t of bankTxns) {
    const amt = Number(t.amount) || 0;
    const dateStr = t.occurredAt ? t.occurredAt.slice(0, 10) : t.occurredOn;
    if (amt > 0) actualIncome += amt;
    else actualExpenses += Math.abs(amt);
    let status: "matched" | "unplanned" | "acknowledged_unplanned";
    if (matchedTxnSet.has(t.id)) status = "matched";
    else if (acknowledgedTxnSet.has(t.id)) status = "acknowledged_unplanned";
    else status = "unplanned";
    txnItems.push({
      txnId: t.id,
      date: dateStr,
      description: t.description,
      amount: money(amt),
      categoryId: t.categoryId ?? null,
      source: t.source ?? null,
      status,
      matchedRecurringItemId: matchedRecurringByTxn.get(t.id) ?? null,
    });
  }

  // -- By-category breakdown -----------------------------------------
  // (#801) Each bucket carries drill-down arrays so the UI can show
  // "what makes up this number?" popovers. Aggregated in the same
  // loop as the totals so the invariant holds:
  //   sum(plannedItems[].amount)      === Number(plannedAmount)
  //   sum(abs(actualTxns[].amount))   === Number(actualAmount)
  type Acc = {
    planned: number;
    actual: number;
    plannedItems: DebriefVarianceCategoryBucket["plannedItems"];
    actualTxns: DebriefVarianceCategoryBucket["actualTxns"];
  };
  const cat = new Map<string | null, Acc>();
  const ensure = (key: string | null): Acc => {
    let cur = cat.get(key);
    if (!cur) {
      cur = { planned: 0, actual: 0, plannedItems: [], actualTxns: [] };
      cat.set(key, cur);
    }
    return cur;
  };
  for (const p of planItems) {
    // Skip plans that won't be counted against the planned total
    // (matched_on_time income is $0 variance but still IS a planned
    // dollar; rescheduled-out and skipped shouldn't count).
    if (p.status === "rescheduled" || p.status === "skipped") continue;
    const acc = ensure(p.categoryId);
    const amt = Number(p.forecastAmount);
    acc.planned += amt;
    acc.plannedItems.push({
      recurringItemId: p.recurringItemId,
      name: p.name,
      amount: amt,
      forecastDate: p.forecastDate,
    });
  }
  for (const t of txnItems) {
    const acc = ensure(t.categoryId);
    const signed = Number(t.amount);
    acc.actual += Math.abs(signed);
    acc.actualTxns.push({
      txnId: t.txnId,
      description: t.description,
      amount: signed,
      date: t.date,
      matchedToPlan: t.status === "matched",
    });
  }
  const byCategory: DebriefVarianceCategoryBucket[] = [];
  for (const [categoryId, acc] of cat.entries()) {
    byCategory.push({
      categoryId,
      plannedAmount: money(acc.planned),
      actualAmount: money(acc.actual),
      varianceAmount: money(acc.actual - acc.planned),
      plannedItems: acc.plannedItems,
      actualTxns: acc.actualTxns,
    });
  }
  byCategory.sort((a, b) =>
    (a.categoryId ?? "").localeCompare(b.categoryId ?? ""),
  );

  // -- Open-items count ----------------------------------------------
  const unmatchedPlans = planItems.filter((p) => p.status === "unmatched");
  // The Debrief's "Unplanned Charges" section surfaces BOTH still-open
  // unplanned txns AND those already acknowledged via Accept Unplanned
  // (so the user can see what they previously accepted). Only the
  // still-open ones gate locking.
  const unplannedTxns = txnItems.filter(
    (t) => t.status === "unplanned" || t.status === "acknowledged_unplanned",
  );
  const openTxns = txnItems.filter((t) => {
    if (t.status !== "unplanned") return false;
    const txn = bankTxns.find((bt) => bt.id === t.txnId);
    return !(txn?.reviewed ?? false);
  });
  const openItemsCount = unmatchedPlans.length + openTxns.length;

  // -- Totals ---------------------------------------------------------
  const plannedNet = plannedIncome - plannedExpenses;
  const actualNet = actualIncome - actualExpenses;

  return {
    weekStart,
    weekEnd,
    computedAt: now.toISOString(),
    totals: {
      plannedIncome: money(plannedIncome),
      actualIncome: money(actualIncome),
      plannedExpenses: money(plannedExpenses),
      actualExpenses: money(actualExpenses),
      plannedNet: money(plannedNet),
      actualNet: money(actualNet),
      varianceNet: money(actualNet - plannedNet),
    },
    plans: planItems,
    transactions: txnItems,
    unmatchedPlans,
    unplannedTxns,
    byCategory,
    openItemsCount,
  };
}

/** Derive a frozen action summary from a finalized snapshot. */
export function summarizeActions(
  snapshot: DebriefVarianceSnapshot,
  opts: { unplannedAcceptedCount?: number; missedCount?: number } = {},
): DebriefActionsSummary {
  const matched = snapshot.plans.filter(
    (p) => p.status === "matched" || p.status === "matched_on_time",
  ).length;
  const rescheduled = snapshot.plans.filter(
    (p) => p.status === "rescheduled",
  ).length;
  const unmatched = snapshot.plans.filter((p) => p.status === "unmatched").length;
  return {
    matchedCount: matched,
    rescheduledCount: rescheduled,
    missedCount: opts.missedCount ?? 0,
    unmatchedCount: unmatched,
    unplannedAcceptedCount: opts.unplannedAcceptedCount ?? snapshot.unplannedTxns.length,
    convertedToRecurringCount: 0,
  };
}

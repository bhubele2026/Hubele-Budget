// (#766 — Phase D1) Weekly Debrief variance computation library.
//
// Pure helpers + the main `computeWeekVariance` reducer that powers
// `GET /api/debrief/weeks/:weekStart`. See lib/db schema comments
// (`weeklyDebriefsTable`) for the snapshot type contract.

import { and, eq, gte, lte, or, sql, isNull, inArray } from "drizzle-orm";
import {
  db,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
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
// Lifted from routes/forecast.ts so the Debrief library can filter
// bank-checking transactions without dragging the whole route module
// in. Same semantic: a row counts as bank-checking iff its
// plaid_account_id matches the configured checking account; manual
// rows pass through unless they carry an explicit amex/plaid: source.

export async function loadConfiguredCheckingExternalId(
  householdId: string,
  ownerUserId: string,
): Promise<string | null> {
  const [settings] = await db
    .select({
      bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  if (!settings?.bankSnapshotAccountId) return null;
  const [acct] = await db
    .select({ accountId: plaidAccountsTable.accountId })
    .from(plaidAccountsTable)
    .where(eq(plaidAccountsTable.id, settings.bankSnapshotAccountId));
  // Suppress unused householdId warning — kept in the signature so
  // future scoping (cross-household guard) doesn't change callers.
  void householdId;
  return acct?.accountId ?? null;
}

export function makeIsBankRow(configuredCheckingExternalId: string | null) {
  return function isBankRow(
    source: string | null | undefined,
    plaidAccountId: string | null | undefined,
  ): boolean {
    if (plaidAccountId) {
      return (
        configuredCheckingExternalId !== null &&
        plaidAccountId === configuredCheckingExternalId
      );
    }
    const s = (source ?? "manual").toLowerCase();
    if (s === "amex" || s === "plaid:amex") return false;
    if (s.startsWith("plaid:")) return false;
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

  // Owner for snapshot resolution. (We pull settings via householdId
  // → owner mapping below.)
  // Owner-scoped settings: bank snapshot account points at the
  // checking account we treat as canonical. We need the OWNER's user
  // id; for the Debrief the simplest path is to read any settings row
  // for this household — there's at most one (single-household per
  // owner).
  const settingsRow = (
    await db
      .select()
      .from(forecastSettingsTable)
  ).find((s) => s.householdId === householdId);
  const ownerUserId = settingsRow?.userId ?? "";
  const configuredCheckingExternalId = await loadConfiguredCheckingExternalId(
    householdId,
    ownerUserId,
  );
  const isBankRow = makeIsBankRow(configuredCheckingExternalId);

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
  const bankTxns = txnsAll.filter((t) => isBankRow(t.source, t.plaidAccountId));

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

  for (const p of plansInWeek) {
    plannedIncome += p.kind === "income" ? p.forecastAmount : 0;
    plannedExpenses += p.kind === "expense" ? p.forecastAmount : 0;

    const k = `${p.recurringItemId}|${p.forecastDate}`;
    const rs = resByKey.get(k) ?? [];
    const matched = rs.find((r) => r.status === "matched");
    const rescheduled = rs.find((r) => r.status === "rescheduled");

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
  for (const p of incomePlansInPad) {
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
  // A txn is "matched" if any resolution.matchedTxnId === txn.id.
  const matchedTxnSet = new Set(
    resolutionRows
      .map((r) => r.matchedTxnId)
      .filter((x): x is string => !!x),
  );
  const matchedRecurringByTxn = new Map<string, string>();
  for (const r of resolutionRows) {
    if (r.matchedTxnId && r.recurringItemId) {
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
    const isMatched = matchedTxnSet.has(t.id);
    txnItems.push({
      txnId: t.id,
      date: dateStr,
      description: t.description,
      amount: money(amt),
      categoryId: t.categoryId ?? null,
      source: t.source ?? null,
      status: isMatched ? "matched" : "unplanned",
      matchedRecurringItemId: matchedRecurringByTxn.get(t.id) ?? null,
    });
  }

  // -- By-category breakdown -----------------------------------------
  type Acc = { planned: number; actual: number };
  const cat = new Map<string | null, Acc>();
  const bump = (key: string | null, planned: number, actual: number) => {
    const cur = cat.get(key) ?? { planned: 0, actual: 0 };
    cur.planned += planned;
    cur.actual += actual;
    cat.set(key, cur);
  };
  for (const p of planItems) {
    bump(p.categoryId, Number(p.forecastAmount), 0);
  }
  for (const t of txnItems) {
    const absAmt = abs(t.amount);
    bump(t.categoryId, 0, absAmt);
  }
  const byCategory: DebriefVarianceCategoryBucket[] = [];
  for (const [categoryId, acc] of cat.entries()) {
    byCategory.push({
      categoryId,
      plannedAmount: money(acc.planned),
      actualAmount: money(acc.actual),
      varianceAmount: money(acc.actual - acc.planned),
    });
  }
  byCategory.sort((a, b) =>
    (a.categoryId ?? "").localeCompare(b.categoryId ?? ""),
  );

  // -- Open-items count ----------------------------------------------
  const unmatchedPlans = planItems.filter((p) => p.status === "unmatched");
  // An unplanned bank txn is "open" until the user marks it reviewed.
  const unplannedTxns = txnItems.filter((t) => t.status === "unplanned");
  const openTxns = unplannedTxns.filter((t) => {
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

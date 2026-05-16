import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  db,
  debtsTable,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  avalancheSettingsTable,
} from "@workspace/db";

type Cadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "onetime";

type RecurringRow = typeof recurringItemsTable.$inferSelect;

export type CashEvent = {
  date: string;
  itemId: string;
  label: string;
  kind: "income" | "expense";
  amount: number;
};

export function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

function setSafeDay(year: number, monthIdx: number, day: number): Date {
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return new Date(year, monthIdx, Math.min(day, lastDay));
}

export function expandItem(item: RecurringRow, from: Date, to: Date): CashEvent[] {
  if (item.active !== "true") return [];
  const out: CashEvent[] = [];
  const kind: "income" | "expense" = item.kind === "income" ? "income" : "expense";
  const sign = kind === "income" ? 1 : -1;
  const amt = Math.abs(Number(item.amount) || 0);
  const anchor = item.anchorDate ? parseISO(item.anchorDate) : from;

  const push = (d: Date) => {
    if (d < from || d > to) return;
    out.push({ date: fmtISO(d), itemId: item.id, label: item.name, kind, amount: sign * amt });
  };

  switch (item.frequency as Cadence) {
    case "onetime":
      push(anchor);
      break;
    case "weekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -7);
      while (cur < from) cur = addDays(cur, 7);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 7);
      }
      break;
    }
    case "biweekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -14);
      while (cur < from) cur = addDays(cur, 14);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 14);
      }
      break;
    }
    case "monthly": {
      const day = item.dayOfMonth ?? anchor.getDate();
      let y = from.getFullYear(),
        m = from.getMonth();
      const anchorFirst = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const fromFirst = new Date(from.getFullYear(), from.getMonth(), 1);
      if (anchorFirst > fromFirst) {
        y = anchor.getFullYear();
        m = anchor.getMonth();
      }
      let cur = setSafeDay(y, m, day);
      while (cur < from) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      while (cur <= to) {
        push(cur);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      break;
    }
    case "semimonthly": {
      const d1 = item.dayOfMonth ?? anchor.getDate();
      const d2 = ((d1 + 14 - 1) % 30) + 1;
      let y = from.getFullYear(),
        m = from.getMonth();
      const days = [Math.min(d1, d2), Math.max(d1, d2)];
      while (true) {
        const a = setSafeDay(y, m, days[0]);
        const b = setSafeDay(y, m, days[1]);
        if (a > to && b > to) break;
        push(a);
        push(b);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
      break;
    }
    case "quarterly": {
      let cur = anchor;
      while (cur > from) cur = addMonths(cur, -3);
      while (cur < from) cur = addMonths(cur, 3);
      while (cur <= to) {
        push(cur);
        cur = addMonths(cur, 3);
      }
      break;
    }
    case "annual": {
      let cur = anchor;
      while (cur > from) cur = addMonths(cur, -12);
      while (cur < from) cur = addMonths(cur, 12);
      while (cur <= to) {
        push(cur);
        cur = addMonths(cur, 12);
      }
      break;
    }
  }
  return out;
}

export type CashSignal = {
  bankToday: string;
  lowestProjected: string;
  lowestDate: string | null;
  cashBuffer: string;
  status: "ready" | "tight" | "not_yet" | "no_data";
  maxSafeExtra: string;
  snapshotAt: string | null;
  snapshotSource: string | null;
  horizonDays?: number;
  fromDate?: string;
  toDate?: string;
  startingBalance?: string;
  endingBalance?: string;
  endingDate?: string | null;
  projectedIncome?: string;
  projectedExpenses?: string;
  acceptedImpact?: string;
  daily?: Array<{ date: string; balance: string }>;
  /**
   * Per-day expense events (planned recurring + synthesized debt-min) that
   * land inside the projection window, with their bill name and signed
   * amount. The forecast chart uses this to mark big-bill days. Income
   * events and matched-out items are excluded — only entries that actually
   * dip the balance show up.
   *
   * `itemId` is the source recurring item id (or synthesized debt-min id),
   * which lets the chart deep-link a marker click to the matching plan row
   * in the register below.
   */
  events?: Array<{ date: string; label: string; amount: string; itemId: string }>;
};

function r2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Compute the cash signal: today's bank balance + projection of lowest balance.
 *
 * Anchored on the bank snapshot when present:
 *   - Skip checking transactions on/before the snapshot date (already counted).
 *   - (#666) Planned events dated on/before the snapshot are dropped entirely
 *     — bills AND income, real AND synthetic. The bank snapshot is the
 *     truth: anything dated on or before it is already reflected in the
 *     bank balance, or it never posted (in which case the user can mark it
 *     missed). Dropping these guarantees the chart's first point equals
 *     the bank balance whenever there's nothing actionable in Pending.
 *     This replaces the previous "drag pre-snapshot to today" rule, which
 *     silently shifted the chart's first point up or down depending on
 *     which side of zero the dragged events happened to net.
 *   - Post-snapshot planned events project forward on their own date and
 *     drag the line until the user matches/misses/skips them.
 */
export async function computeCashSignal(
  householdId: string,
  ownerUserId: string,
  opts: { horizonDays?: number; fromDate?: string } = {},
): Promise<CashSignal> {
  const [settings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  const cashBuffer = Number(settings?.cashBuffer ?? 500) || 0;
  const daysAhead = opts.horizonDays ?? settings?.daysAhead ?? 90;

  const today = new Date();
  const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const fromDateOnly = opts.fromDate ? parseISO(opts.fromDate) : todayDateOnly;
  const fromISO = fmtISO(fromDateOnly);
  const to = addDays(fromDateOnly, daysAhead);
  const toISO = fmtISO(to);

  const snapshotBalance = settings?.bankSnapshotBalance != null
    ? Number(settings.bankSnapshotBalance)
    : null;
  const snapshotAt = settings?.bankSnapshotAt ?? null;
  const snapshotISO = snapshotAt ? fmtISO(snapshotAt) : null;

  // No snapshot → fall back to startingBalance
  const startBalanceAtAnchor = snapshotBalance ?? (Number(settings?.startingBalance ?? 0) || 0);
  // Anchor: events strictly AFTER snapshot date are projected; if no snapshot, project from today
  const todayISO = fmtISO(todayDateOnly);
  const anchorISO = snapshotISO ?? todayISO;
  // (#681) Past-due pending plans drag the projection to today+1.
  // The bank balance card and the chart's day-0 point both equal the
  // snapshot — anything past-due (still pending and unresolved) is
  // assumed to still post, just not on its original date — so the
  // projection hops it onto tomorrow and keeps re-hopping it forward
  // every real-world day until the user marks it matched, missed,
  // skipped, or dismissed.
  const dragTargetISO = fmtISO(addDays(todayDateOnly, 1));
  // Past-due cutoff: any pending plan whose effective date is on or
  // before MAX(snapshot, today) is considered past-due. We compare
  // against the later of the two so a snapshot dated yesterday and a
  // pending plan dated today both qualify.
  const dragCutoffISO =
    snapshotISO && snapshotISO > todayISO ? snapshotISO : todayISO;
  // The drag is applied unconditionally — independent of the chart
  // window. Window placement is handled by the normal roll-forward /
  // daily-projection logic downstream: if today+1 falls inside the
  // window the dip is visible there; if it falls before the window
  // the roll-forward consumes it into startingBalance; if it falls
  // after the window the daily loop naturally ignores it. Gating on
  // window choice would make the same plan appear and disappear based
  // on which date range the user selects.
  // Expansion start: cover from min(anchor, fromDate) so we can roll the
  // balance forward to fromDate even when fromDate > anchor. We also reach
  // back to the first day of the prior month — matching the lookback the
  // Forecast register uses — so plan occurrences the user can still see
  // as "Pending plan" in the planned-items list are also expanded into
  // the projection. Without this, past-pending bills (e.g. dated before
  // the snapshot) silently disappear from the chart even though they
  // still owe and have not been matched or marked missed.
  const earliestAnchorOrFrom = anchorISO < fromISO ? parseISO(anchorISO) : fromDateOnly;
  // Reach back to the first day of the month BEFORE today — matching
  // the lookback the Forecast register uses to surface "Pending plan"
  // rows. Anchored on today (not fromDate) because the production
  // chart window is always centered on today; non-current-month
  // windows are an edge case that may under-expand past-pending
  // occurrences.
  const priorMonthStart = new Date(
    todayDateOnly.getFullYear(),
    todayDateOnly.getMonth() - 1,
    1,
  );
  const expandStart = priorMonthStart < earliestAnchorOrFrom ? priorMonthStart : earliestAnchorOrFrom;

  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));
  const debtsList = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const linkedRecurringByDebt = new Map<string, RecurringRow>();
  for (const r of recurring) {
    if (r.debtId && r.active === "true" && !linkedRecurringByDebt.has(r.debtId)) {
      linkedRecurringByDebt.set(r.debtId, r);
    }
  }
  const events: CashEvent[] = [];
  for (const item of recurring) events.push(...expandItem(item, expandStart, to));
  // (#667) Synthetic events (debt minimums for debts WITHOUT a linked
  // recurring item, and the "Avalanche extra payment" series) have NO
  // representation in the Forecast Pending UI — the user can't match,
  // skip, or mark-missed them. So if we expanded them back into the
  // pre-snapshot lookback window, the drag-to-today rule would silently
  // pull them onto today's projection with no way for the user to
  // dismiss the dip. The bank snapshot is the truth for everything
  // dated on or before it, so synthetic events are anchored at
  // MAX(expandStart, snapshot+1) — only future synthetic obligations
  // contribute to the projection. Real recurring items keep their
  // existing pre-snapshot expansion since they DO surface as "Pending
  // plan" rows the user can act on.
  const syntheticExpandStart = snapshotAt
    ? new Date(
        Math.max(
          expandStart.getTime(),
          new Date(
            snapshotAt.getFullYear(),
            snapshotAt.getMonth(),
            snapshotAt.getDate() + 1,
          ).getTime(),
        ),
      )
    : expandStart;
  // Inject monthly debt-min events for active debts WITHOUT a linked
  // recurring item — same series the Bills page renders for "Debt
  // minimums", so the projection never double-counts and never misses an
  // obligation that was synced via Plaid liabilities.
  const { expandDebtMin, expandAvalancheExtra } = await import("./debtMinSchedule");
  for (const d of debtsList) {
    events.push(
      ...expandDebtMin(
        d,
        linkedRecurringByDebt.get(d.id) ?? null,
        syntheticExpandStart,
        to,
      ),
    );
  }
  // Inject the synthetic "Avalanche extra payment" events so the cash-
  // signal projection accounts for the same end-of-month outflow that
  // the Forecast register shows. Capped server-side at the avalanche
  // payoff horizon so the projection stops once all debts are paid.
  const [avaSettingsRow] = await db
    .select()
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, ownerUserId));
  const manualExtra = Number(avaSettingsRow?.manualExtra ?? 0) || 0;
  events.push(
    ...expandAvalancheExtra(debtsList, manualExtra, syntheticExpandStart, to, todayDateOnly),
  );

  // Resolve the configured Chase checking account's external Plaid
  // account_id (if any). Forecast is bank-only and scoped to this single
  // account — legacy `forecastFlag = true` rows on Amex / other
  // depository accounts must be filtered out at read time.
  let configuredCheckingExternalId: string | null = null;
  if (settings?.bankSnapshotAccountId) {
    const [acct] = await db
      .select({ accountId: plaidAccountsTable.accountId })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, settings.bankSnapshotAccountId));
    configuredCheckingExternalId = acct?.accountId ?? null;
  }
  const isBankRow = (
    source: string | null,
    plaidAccountId: string | null,
  ): boolean => {
    if (plaidAccountId) {
      return (
        configuredCheckingExternalId !== null &&
        plaidAccountId === configuredCheckingExternalId
      );
    }
    // Manual rows (no plaidAccountId): exclude anything tagged as an
    // explicit credit-card source.
    const s = (source ?? "").toLowerCase();
    if (s === "amex" || s.startsWith("plaid:")) return false;
    return true;
  };

  // Pull future-anchored checking transactions (forecast_flag and reflecting bank movement after snapshot)
  const txnsAll = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.forecastFlag, true),
        gte(transactionsTable.occurredOn, anchorISO),
        lte(transactionsTable.occurredOn, toISO),
      ),
    );
  const txns = txnsAll.filter((t) =>
    isBankRow(t.source, t.plaidAccountId ?? null),
  );

  // Get matched-resolutions to suppress double-count of plan items already paid for by a txn.
  // Drop any resolution whose matched transaction is NOT a Chase
  // checking row, so a legacy Amex match can't suppress a planned item
  // from the projection. Validate the matched transaction's account
  // *independently* of the projection window — a Chase match dated
  // outside [anchor, to] still legitimately suppresses its plan item.
  const resolutionsAll = await db
    .select()
    .from(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, householdId));
  const matchedIds = Array.from(
    new Set(
      resolutionsAll
        .map((r) => r.matchedTxnId)
        .filter((x): x is string => !!x),
    ),
  );
  const matchedTxnBankSet = new Set<string>();
  if (matchedIds.length > 0) {
    const matchedTxns = await db
      .select({
        id: transactionsTable.id,
        source: transactionsTable.source,
        plaidAccountId: transactionsTable.plaidAccountId,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          inArray(transactionsTable.id, matchedIds),
        ),
      );
    for (const t of matchedTxns) {
      if (isBankRow(t.source, t.plaidAccountId ?? null)) {
        matchedTxnBankSet.add(t.id);
      }
    }
  }
  const resolutions = resolutionsAll.filter(
    (r) => !r.matchedTxnId || matchedTxnBankSet.has(r.matchedTxnId),
  );
  const matchedPlanKeys = new Set<string>();
  const matchedTxnIds = new Set<string>();
  const rescheduledByKey = new Map<string, string>();
  // (#480) Plan occurrences the user explicitly Skipped from the Missed
  // bucket are excluded from the projected balance entirely — same key
  // shape as `matchedPlanKeys` so the existing `events` loop can drop
  // them with one extra check.
  const skippedPlanKeys = new Set<string>();
  // Plan occurrences the user explicitly marked as missed (or dismissed).
  // These stop dragging the projection — a "missed" plan means the user
  // acknowledged the bill won't actually post (or already has been
  // accounted for elsewhere). Until that mark, a past-dated pending plan
  // continues to weigh on the projection.
  const missedPlanKeys = new Set<string>();
  for (const r of resolutions) {
    if (r.status === "matched") {
      if (r.recurringItemId && r.occurrenceDate) {
        matchedPlanKeys.add(`${r.recurringItemId}|${r.occurrenceDate}`);
      }
      if (r.matchedTxnId) matchedTxnIds.add(r.matchedTxnId);
    } else if (
      r.status === "rescheduled" &&
      r.recurringItemId &&
      r.occurrenceDate &&
      r.rescheduledTo
    ) {
      rescheduledByKey.set(
        `${r.recurringItemId}|${r.occurrenceDate}`,
        r.rescheduledTo,
      );
    } else if (
      r.status === "skipped" &&
      r.recurringItemId &&
      r.occurrenceDate
    ) {
      skippedPlanKeys.add(`${r.recurringItemId}|${r.occurrenceDate}`);
    } else if (
      (r.status === "missed" || r.status === "dismissed") &&
      r.recurringItemId &&
      r.occurrenceDate
    ) {
      missedPlanKeys.add(`${r.recurringItemId}|${r.occurrenceDate}`);
    }
  }

  type Item = { date: string; amount: number; matched: boolean };
  const items: Item[] = [];
  // Parallel list of labeled expense events surfaced to the chart. We only
  // include entries that ACTUALLY drag the balance down (negative amount,
  // post-anchor, not already matched out by a real txn) so the markers line
  // up with dips on the projected line.
  const expenseEvents: Array<{
    date: string;
    label: string;
    amount: number;
    itemId: string;
    // (#650) Original (pre-drag) date the plan was scheduled for. When
    // `originalDate !== date`, this event was dragged forward by the
    // pre-snapshot drag-to-today rule. The forecast tooltip uses this
    // to distinguish "still-pending plans pulled onto today" from
    // "bills naturally due today" so the "Pending plans dragging
    // this day" list isn't polluted with normal due-today bills.
    originalDate: string;
  }> = [];
  for (const ev of events) {
    const origKey = `${ev.itemId}|${ev.date}`;
    const rawEffectiveDate = rescheduledByKey.get(origKey) ?? ev.date;
    const matched = matchedPlanKeys.has(origKey);
    if (matched) continue;
    // (#480) Skipped occurrences must NOT contribute to the projection
    // (chart line, lowest, ending balance, expenseEvents markers).
    if (skippedPlanKeys.has(origKey)) continue;
    // Plans the user explicitly marked missed/dismissed are likewise
    // dropped — the user has acknowledged they won't post.
    if (missedPlanKeys.has(origKey)) continue;
    // (#666) BANK SNAPSHOT IS THE TRUTH: events dated STRICTLY before
    // the snapshot are dropped. The bank balance already reflects
    // them — even if the auto-matcher didn't write a `matched`
    // resolution row (e.g. because the real transaction posted
    // outside the +/- 3 day / +/- $1 window). This is what suppresses
    // the phantom Mortgage/HELOC/etc. occurrences that come out of
    // the prior-month expansion lookback but don't appear in the
    // user's planned-items register.
    if (snapshotISO && rawEffectiveDate < snapshotISO) continue;
    // (#681) Past-due unresolved EXPENSE pendings — only those that
    // are on or after the snapshot AND on or before today — drag the
    // projection to today+1. Day-0 still equals the bank snapshot
    // (no double-counting today), but the expense continues to weigh
    // on tomorrow until the user marks it matched/missed/skipped or
    // it gets matched to a real bank transaction. Past-due INCOME is
    // dropped: a not-yet-landed paycheck shouldn't inflate tomorrow
    // by hopping onto it, and it must not land on day-0 either, or
    // day-0 would exceed the bank snapshot.
    if (rawEffectiveDate <= dragCutoffISO) {
      if (ev.amount < 0) {
        items.push({ date: dragTargetISO, amount: ev.amount, matched: false });
        expenseEvents.push({
          date: dragTargetISO,
          label: ev.label,
          amount: ev.amount,
          itemId: ev.itemId,
          originalDate: rawEffectiveDate,
        });
      }
      continue;
    }
    let effectiveDate = rawEffectiveDate;
    if (!snapshotISO && effectiveDate < fromISO) {
      // No-snapshot fallback for non-drag cases (income, or windows
      // that don't include today): surface PRE-WINDOW pending plans
      // as a day-0 dip rather than silently shrinking startingBalance.
      effectiveDate = fromISO;
    }
    items.push({ date: effectiveDate, amount: ev.amount, matched: false });
    if (ev.amount < 0) {
      expenseEvents.push({
        date: effectiveDate,
        label: ev.label,
        amount: ev.amount,
        itemId: ev.itemId,
        originalDate: rawEffectiveDate,
      });
    }
  }
  for (const t of txns) {
    if (t.occurredOn <= anchorISO) continue;
    items.push({
      date: t.occurredOn,
      amount: Number(t.amount) || 0,
      matched: matchedTxnIds.has(t.id),
    });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Roll the balance forward from anchor up to (but not including) fromDate
  // so `startingBalance` reflects what the bank should be on the chart's
  // first day.
  let bal = startBalanceAtAnchor;
  for (const it of items) {
    if (it.date >= fromISO) break;
    bal = Math.round((bal + it.amount) * 100) / 100;
  }
  const startingBalance = bal;

  // Build daily series in [fromDate, toDate] and gather window stats.
  const totalDays = Math.round((to.getTime() - fromDateOnly.getTime()) / 86_400_000) + 1;
  const daily: Array<{ date: string; balance: string }> = [];
  let lowest = startingBalance;
  let lowestDate: string | null = null;
  let projectedIncome = 0;
  let projectedExpenses = 0;
  let acceptedImpact = 0;

  let cursor = 0;
  // Skip items before window (already applied above)
  while (cursor < items.length && items[cursor].date < fromISO) cursor++;

  for (let i = 0; i < totalDays; i++) {
    const d = addDays(fromDateOnly, i);
    const dISO = fmtISO(d);
    while (cursor < items.length && items[cursor].date <= dISO) {
      const it = items[cursor];
      bal = Math.round((bal + it.amount) * 100) / 100;
      if (it.amount > 0) projectedIncome += it.amount;
      else projectedExpenses += -it.amount;
      if (it.matched) acceptedImpact += it.amount;
      cursor++;
    }
    if (bal < lowest) {
      lowest = bal;
      lowestDate = dISO;
    }
    daily.push({ date: dISO, balance: r2(bal) });
  }
  const endingBalance = bal;
  const endingDate = toISO;

  const headroom = Math.max(0, lowest - cashBuffer);
  let status: CashSignal["status"];
  if (snapshotBalance == null) status = "no_data";
  else if (lowest >= cashBuffer + 200) status = "ready";
  else if (lowest >= cashBuffer) status = "tight";
  else status = "not_yet";

  return {
    bankToday: r2(startBalanceAtAnchor),
    lowestProjected: r2(lowest),
    lowestDate,
    cashBuffer: r2(cashBuffer),
    status,
    maxSafeExtra: r2(headroom),
    snapshotAt: snapshotAt ? snapshotAt.toISOString() : null,
    snapshotSource: settings?.bankSnapshotSource ?? null,
    horizonDays: daysAhead,
    fromDate: fromISO,
    toDate: toISO,
    startingBalance: r2(startingBalance),
    endingBalance: r2(endingBalance),
    endingDate,
    projectedIncome: r2(projectedIncome),
    projectedExpenses: r2(projectedExpenses),
    acceptedImpact: r2(acceptedImpact),
    daily,
    events: expenseEvents
      .filter((e) => e.date >= fromISO && e.date <= toISO)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((e) => ({
        date: e.date,
        label: e.label,
        amount: r2(e.amount),
        itemId: e.itemId,
        originalDate: e.originalDate,
      })),
  };
}

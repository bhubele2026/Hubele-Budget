import { and, eq, gt, gte, inArray, lte } from "drizzle-orm";
import {
  db,
  debtsTable,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  avalancheSettingsTable,
} from "@workspace/db";
import { resolveSnapshotAccount } from "./resolveSnapshotAccount";
import { inForecastWhere } from "./forecastInclusion";
import { householdDayOf, householdTodayDate } from "./householdClock";
import { isInSnapshot } from "@workspace/avalanche-core";
import {
  addDays,
  expandItem,
  fmtISO,
  nextBusinessDay,
  parseISO,
  type CashEvent,
} from "./cashSignal";

type RecurringRow = typeof recurringItemsTable.$inferSelect;

/** A real checking row after the snapshot anchor. */
export type LedgerActual = {
  kind: "actual";
  date: string;
  amount: number;
  /** A `matched` resolution points at this row. */
  matched: boolean;
  txnId: string;
};

/** A planned occurrence (recurring item, debt minimum, avalanche extra) still weighing on the curve. */
export type LedgerPlan = {
  kind: "plan";
  eventKind: CashEvent["kind"];
  /** The date it lands on the curve: after any reschedule, and after the past-due drag. */
  date: string;
  /** The (rescheduled) date it was due, before any drag. */
  originalDate: string;
  amount: number;
  itemId: string;
  label: string;
  /**
   * Present when the curve moved the plan off its due date:
   * - `dragged_past_due`: past-due and unresolved, so it lands on the next business day (#681/#751);
   * - `pre_window_on_first_day`: no snapshot, and due before the window, so it lands on the window's first day.
   */
  assumption?: "dragged_past_due" | "pre_window_on_first_day";
};

export type LedgerItem = LedgerActual | LedgerPlan;

export type ForecastLedger = {
  daysAhead: number;
  cashBuffer: number;
  fromDateOnly: Date;
  to: Date;
  fromISO: string;
  toISO: string;
  todayISO: string;
  anchorISO: string;
  snapshotISO: string | null;
  snapshotAt: Date | null;
  snapshotSource: string | null;
  snapshotBalance: number | null;
  /** The snapshot balance, or the starting balance when there is no snapshot. */
  startBalanceAtAnchor: number;
  /**
   * The snapshot rolled forward through today's checking rows (the anchor alone without a snapshot).
   * ⚠️ Unrounded: callers format it to cents.
   */
  bankToday: number;
  /**
   * Every plan and actual row, sorted by date (stable: plans before actuals on a day, each in build order).
   * ⚠️ Plans can fall OUTSIDE `[fromISO, toISO]` (a drag target past `toISO`, a plan dated before `fromISO`);
   * actuals are capped at `toISO`. Consumers window the items themselves.
   */
  items: LedgerItem[];
};

/**
 * ⭐ THE FORECAST LEDGER — everything the cash curve is made of, before any of
 * it is summed.
 *
 * Extracted verbatim from `computeCashSignal` (PR4a), which now only walks these
 * items into the daily series. `forecastLedger.golden.integration.test.ts` pins
 * the full `computeCashSignal` output recorded before the extraction.
 *
 * Anchored on the bank snapshot when present:
 *   - A checking row counts unless the snapshot already holds it (PR4b,
 *     `isInSnapshot`): rows dated before the snapshot day; snapshot-day rows
 *     that reached the ledger before the balance was read; and Plaid rows that
 *     existed at the read and are dated up to five days after it.
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
export async function buildForecastLedger(
  householdId: string,
  ownerUserId: string,
  opts: {
    horizonDays?: number;
    fromDate?: string;
  } = {},
): Promise<ForecastLedger> {
  const [settings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  const cashBuffer = Number(settings?.cashBuffer ?? 500) || 0;
  const daysAhead = opts.horizonDays ?? settings?.daysAhead ?? 90;

  const today = new Date();
  // The household's today (America/Chicago), as a server-local midnight Date so
  // the local-field arithmetic below stays right on a UTC server.
  const todayDateOnly = householdTodayDate(today);
  const fromDateOnly = opts.fromDate ? parseISO(opts.fromDate) : todayDateOnly;
  const fromISO = fmtISO(fromDateOnly);
  const to = addDays(fromDateOnly, daysAhead);
  const toISO = fmtISO(to);

  const snapshotBalance = settings?.bankSnapshotBalance != null
    ? Number(settings.bankSnapshotBalance)
    : null;
  const snapshotAt = settings?.bankSnapshotAt ?? null;
  // The calendar day the snapshot was taken on, in the household's timezone —
  // a snapshot at 9pm Central belongs to that day, not to tomorrow in UTC.
  const snapshotISO = snapshotAt ? householdDayOf(snapshotAt) : null;

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
  // (#751) Drag target is the next BUSINESS day so a Friday past-due
  // doesn't dump onto Saturday (no posting). Weekend rolls to Monday.
  const dragTargetISO = fmtISO(nextBusinessDay(todayDateOnly));
  // Past-due cutoff: any pending plan whose effective date is on or
  // before MAX(snapshot, today) is considered past-due. We compare
  // against the later of the two so a snapshot dated yesterday and a
  // pending plan dated today both qualify.
  const dragCutoffISO =
    snapshotISO && snapshotISO > todayISO ? snapshotISO : todayISO;
  // (#803) Cap how far back the drag-forward reaches. Plans older
  // than DRAG_LOOKBACK_DAYS before today are NOT dragged forward —
  // they're zombies (the user forgot, the schedule drifted, the
  // mapping rule is stale) and are simply dropped from the cash
  // projection; the Review page is where the user resolves them.
  // Without this cap the chart spikes downward every time an
  // ancient unresolved plan gets carried onto today+1.
  const DRAG_LOOKBACK_DAYS = 14;
  const dragFloorISO = fmtISO(addDays(todayDateOnly, -DRAG_LOOKBACK_DAYS));
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
  // (#687) Synthetic events (debt minimums for debts WITHOUT a linked
  // recurring item, and the "Avalanche extra payment" series) are
  // expanded from the SAME `expandStart` as real recurring items.
  // The Forecast Pending register also lists them (forecast.ts uses
  // identical `expandDebtMin`/`expandAvalancheExtra` from the prior
  // month), so if cashSignal anchors them later than the register
  // does, plans visible as "Pending plan" rows go missing from the
  // chart's drag tooltip — exactly the user's complaint about a
  // Synchrony debt-min on the snapshot date being absent while
  // Verizon/PlayStation showed up.
  //
  // The earlier (#667) anchor at snapshot+1 was meant to prevent
  // phantom pre-snapshot drag for synthetic items, but the (#666)
  // "strictly before snapshot is dropped" rule below already handles
  // that uniformly for real and synthetic events, and the (#681)
  // drag is bounded at today so there's no infinite phantom dip.
  const syntheticExpandStart = expandStart;
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
  // account_id. Forecast is bank-only and scoped to this single account —
  // legacy `forecastFlag = true` rows on Amex / other depository accounts must
  // be filtered out at read time.
  //
  // ⚠️ The pointer this reads can be null or dangling, which used to freeze the
  // balance on every screen at once. `resolveSnapshotAccount` recovers the
  // account from what the snapshot remembers; see the file header for why a
  // wrong guess would be worse than a stale number.
  const snapshotAccount = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: settings?.bankSnapshotAccountId ?? null,
    bankSnapshotMask: settings?.bankSnapshotMask ?? null,
  });
  const configuredCheckingExternalId = snapshotAccount.externalId;

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

  // ⭐ ONE SET OF ACTUAL ROWS FOR BOTH `bankToday` AND THE CURVE (PR4a).
  //
  // These used to be two queries over two row sets that happened to agree:
  //   - "Bank today" = snapshot rolled forward through the real ledger, the
  //     same derivation the Chase page uses (anchor + every checking-scoped
  //     txn dated strictly after the anchor day through today — pending
  //     included, no forecast_flag filter). The raw snapshot only advances on
  //     a manual Sync/Refresh, so without this roll-forward the tile drifts
  //     from the bank as webhook-synced transactions keep landing.
  //   - The curve: actual checking activity through today belongs in the
  //     opening balance regardless of review flags, and only future
  //     transactions require forecastFlag — one rule for the curve, the Review
  //     bundle and the badge: `inForecast`.
  // `inForecast` keeps every row dated on or before today, so the rows the roll
  // needed were always a subset of the curve's. ⚠️ The upper bound is the LATER
  // of the window's end and today: `bankToday` rolls through today even when
  // the chart's window ends before it (golden case "a window that ends before
  // today").
  //
  // Without a snapshot there is no roll: `bankToday` is the starting balance,
  // and the curve takes only forecast-flagged rows after today.
  //
  // ⭐ WHICH ROWS THE SNAPSHOT ALREADY HOLDS — ONE RULE, APPLIED HERE ONLY (PR4b).
  // A calendar day is not enough: the balance is read at an INSTANT, so a row
  // dated on the snapshot day can land after the read, and a Plaid row dated a
  // few days ahead can already be inside it (a pending authorisation). With a
  // snapshot the query therefore reads the snapshot day too, and
  // `isInSnapshot` compares each row's `created_at` with the read. Because
  // `bankToday` and the curve take their rows from this one loop, they cannot
  // disagree about it.
  const actualUpperISO = toISO > todayISO ? toISO : todayISO;
  const actualRowsAll = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        snapshotISO
          ? inForecastWhere(todayISO)
          : eq(transactionsTable.forecastFlag, true),
        snapshotISO
          ? gte(transactionsTable.occurredOn, anchorISO)
          : gt(transactionsTable.occurredOn, anchorISO),
        lte(transactionsTable.occurredOn, actualUpperISO),
      ),
    );
  let bankToday = startBalanceAtAnchor;
  const actuals: LedgerActual[] = [];
  // Defensive only: `transactions.plaid_transaction_id` is unique.
  const seenPlaidIds = new Set<string>();
  for (const t of actualRowsAll) {
    if (
      snapshotISO &&
      snapshotAt &&
      isInSnapshot(
        { occurredOn: t.occurredOn, createdAt: t.createdAt, plaidAccountId: t.plaidAccountId ?? null },
        snapshotAt,
        snapshotISO,
      )
    ) {
      continue;
    }
    if (!isBankRow(t.source, t.plaidAccountId ?? null)) continue;
    if (t.plaidTransactionId) {
      if (seenPlaidIds.has(t.plaidTransactionId)) continue;
      seenPlaidIds.add(t.plaidTransactionId);
    }
    const amount = Number(t.amount) || 0;
    if (snapshotISO && t.occurredOn <= todayISO) bankToday += amount;
    if (t.occurredOn <= toISO) {
      actuals.push({ kind: "actual", date: t.occurredOn, amount, matched: false, txnId: t.id });
    }
  }

  // Get matched-resolutions to suppress double-count of plan items already paid for by a txn.
  //
  // (#687) PLAN-KEY suppression is account-agnostic. A `matched`
  // resolution means the user (or auto-matcher) has accepted that
  // the plan is paid — even if the matching transaction sits on a
  // non-Chase account (e.g. Amex). The bank snapshot already
  // reflects the resulting Chase balance whichever account the
  // payment came from (#666). Re-projecting these plans against
  // the snapshot double-counts and produces phantom "Pending
  // plans dragging this day" entries that the user never sees in
  // their planned-items register.
  //
  // TXN-LEVEL dedup, on the other hand, must stay Chase-only —
  // `matchedTxnIds` is consulted when iterating Chase bank
  // transactions, and a non-Chase txn id never appears there anyway.
  // Keep the `matchedTxnBankSet` lookup for that narrower purpose.
  const resolutionsAll = await db
    .select()
    .from(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, householdId));
  // A moved bill can originate outside the expansion window. Recover that
  // occurrence before applying resolutions so moving it into view cannot
  // silently erase the payment from the cash curve.
  const eventKeys = new Set(events.map(e => `${e.itemId}|${e.date}`));
  for (const r of resolutionsAll) {
    if (r.status !== "rescheduled" || !r.recurringItemId || !r.occurrenceDate || !r.rescheduledTo || r.rescheduledTo > toISO) continue;
    const key = `${r.recurringItemId}|${r.occurrenceDate}`;
    if (eventKeys.has(key)) continue;
    const day = parseISO(r.occurrenceDate);
    const recurringItem = recurring.find(item => item.id === r.recurringItemId);
    const recovered = recurringItem ? expandItem(recurringItem, day, day) : [
      ...debtsList.flatMap(d => expandDebtMin(d, linkedRecurringByDebt.get(d.id) ?? null, day, day)),
      ...expandAvalancheExtra(debtsList, manualExtra, day, day, todayDateOnly),
    ];
    for (const event of recovered) {
      if (event.itemId !== r.recurringItemId || eventKeys.has(`${event.itemId}|${event.date}`)) continue;
      events.push(event);
      eventKeys.add(`${event.itemId}|${event.date}`);
    }
  }

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
  for (const r of resolutionsAll) {
    if (r.status === "matched") {
      // (#687) Plan-key suppression: account-agnostic.
      if (r.recurringItemId && r.occurrenceDate) {
        matchedPlanKeys.add(`${r.recurringItemId}|${r.occurrenceDate}`);
      }
      // Txn-level dedup: Chase-only — a non-Chase matched txn id
      // never appears among the actual rows anyway, so we'd never
      // collide, but keep the explicit guard so the intent is clear.
      if (r.matchedTxnId && matchedTxnBankSet.has(r.matchedTxnId)) {
        matchedTxnIds.add(r.matchedTxnId);
      }
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

  const plans: LedgerPlan[] = [];
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
    //
    // (#688) Narrow exception: a pending past-due EXPENSE dated
    // EXACTLY the day before a fresh bank snapshot may still be
    // unposted at the bank — especially on weekends or right after
    // a manual / auto Plaid refresh. Without this exception,
    // refreshing the bank balance on day D silently swallows any
    // day-(D-1) still-pending bill from the chart projection, even
    // though the register surfaces it as "Pending plan" and the
    // user expects it to drag forward to day+1. We only widen the
    // window by ONE day so older pre-snapshot phantoms (the
    // Mortgage/HELOC scenario (#666) was designed to suppress) stay
    // suppressed.
    if (snapshotISO && rawEffectiveDate < snapshotISO) {
      const oneDayBeforeSnap = fmtISO(addDays(parseISO(snapshotISO), -1));
      const stillEligibleForDrag =
        ev.amount < 0 &&
        rawEffectiveDate >= oneDayBeforeSnap &&
        rawEffectiveDate <= dragCutoffISO;
      if (!stillEligibleForDrag) continue;
    }
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
      // (#803) Drop drag-forward for ancient past-due plans — see
      // dragFloorISO above; they're resolved on the Review page, not
      // dragged here. Income was already dropped just below.
      if (rawEffectiveDate < dragFloorISO) continue;
      if (ev.amount < 0) {
        plans.push({
          kind: "plan",
          eventKind: ev.kind,
          date: dragTargetISO,
          originalDate: rawEffectiveDate,
          amount: ev.amount,
          itemId: ev.itemId,
          label: ev.label,
          assumption: "dragged_past_due",
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
    plans.push({
      kind: "plan",
      eventKind: ev.kind,
      date: effectiveDate,
      originalDate: rawEffectiveDate,
      amount: ev.amount,
      itemId: ev.itemId,
      label: ev.label,
      ...(effectiveDate !== rawEffectiveDate
        ? { assumption: "pre_window_on_first_day" as const }
        : {}),
    });
  }

  for (const a of actuals) a.matched = matchedTxnIds.has(a.txnId);
  const items: LedgerItem[] = [...plans, ...actuals];
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    daysAhead,
    cashBuffer,
    fromDateOnly,
    to,
    fromISO,
    toISO,
    todayISO,
    anchorISO,
    snapshotISO,
    snapshotAt,
    snapshotSource: settings?.bankSnapshotSource ?? null,
    snapshotBalance,
    startBalanceAtAnchor,
    bankToday,
    items,
  };
}

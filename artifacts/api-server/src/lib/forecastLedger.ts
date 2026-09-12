import { and, eq, inArray, gte, lte } from "drizzle-orm";
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
import { ledgerActualRowsWhere, toCashRow } from "./ledgerCashRows";
import { inForecastWhere } from "./forecastInclusion";
import { householdDayOf, householdTodayDate } from "./householdClock";
import { remapOrphanResolutions, type ResolutionSchedule } from "./resolutionRemap";
import {
  addDaysISO,
  classifyCashRows,
  isBankRow,
  MATCH_EARLY_DAYS,
  matchPlansToRows,
  plansPaidInFullByName,
  SUPERSEDE_MAX_DAYS,
  type PaidInFull,
  type MatchPlan,
  type MatchRow,
  type PlanRowMatch,
} from "@workspace/avalanche-core";
import {
  addDays,
  expandItem,
  fmtISO,
  isPastOneTime,
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
   * (PR6) The date resolutions are keyed on: the occurrence's own date, before any
   * reschedule. For a moved bill `originalDate` is the moved-to date and this is
   * the date it was moved from — Mark missed / Skip / match must send THIS.
   */
  occurrenceDate: string;
  /**
   * Present when the curve moved the plan off its due date:
   * - `overdue_assumed_unpaid` (PR6): due in [today−14, today), unresolved, and no
   *   bank row confidently paid it, so it lands on the next business day;
   * - `due_today_not_posted` (PR6): due today (or, with a snapshot dated after
   *   today, up to the snapshot day) and unresolved, so it lands on the next
   *   business day and day 0 still equals the bank;
   * - `overdue_remainder_assumed_unpaid` (PR6 review): overdue, a bank row paid
   *   part of it (see `overdueAssumedPaid`), and only the unpaid remainder (over
   *   $1) lands on the next business day;
   * - `dragged_past_due`: the pre-PR6 drag of a weekly-cadence expense due BEFORE
   *   today (`keepsPreSnapshotRule`, until PR8); due today it is
   *   `due_today_not_posted` like any other plan;
   * - `pre_window_on_first_day`: no snapshot, and due before the window, so it lands on the window's first day.
   */
  assumption?:
    | "overdue_assumed_unpaid"
    | "overdue_remainder_assumed_unpaid"
    | "due_today_not_posted"
    | "dragged_past_due"
    | "pre_window_on_first_day";
};

/**
 * (PR6) An unresolved plan kept OFF the curve but never dropped silently: an
 * expense overdue by more than 14 days (`overdueOutsideForecast`), or income that
 * has not arrived (`incomeNotArrived`, tag `income_not_arrived`).
 */
export type LedgerListedPlan = {
  /** `<itemId>|<occurrenceDate>` — the resolution key, and `CashSignal.matches[].planKey`. */
  planKey: string;
  itemId: string;
  occurrenceDate: string;
  /** The date it was due: after any reschedule. */
  dueDate: string;
  /** Signed: negative is money out. A `partial` plan lists its remainder. */
  amount: number;
  label: string;
  /** Whole days from `dueDate` to today. */
  daysOverdue: number;
};

/**
 * (PR6 review) An overdue plan the forecast treats as PAID because of a bank row:
 * a non-ambiguous pair of any confidence, or, for a debt's minimum, a payment of
 * at least the minimum that names the card (`card_payment`) or that the user
 * tagged to that debt (`debt_tag`). Listed so it is never silent, and so the user
 * can confirm or reject the pair.
 */
export type LedgerAssumedPaidPlan = {
  planKey: string;
  itemId: string;
  occurrenceDate: string;
  dueDate: string;
  label: string;
  daysOverdue: number;
  /** Signed, like the plan. */
  planAmount: number;
  txnId: string;
  /** Signed, like the row. */
  txnAmount: number;
  /** "high" | "medium" | "low" (the pair's), "card_payment", or "debt_tag". */
  confidence: string;
  /**
   * Signed; 0 when the row paid it all (or within $1). On the curve only while
   * the plan is at most 14 days overdue (`overdue_remainder_assumed_unpaid`).
   */
  unpaidRemainder: number;
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
  /**
   * (PR5) Plans a bank row probably paid — suggestions, never written. Each one
   * took its plan off the curve (`items`); the row itself still counts.
   */
  matches: PlanRowMatch[];
  /** (PR6) Expenses overdue by more than 14 days: not on the curve, listed. Sorted by due date. */
  overdueOutsideForecast: LedgerListedPlan[];
  /** (PR6) Income due before today that has not arrived: not on the curve, listed. Sorted by due date. */
  incomeNotArrived: LedgerListedPlan[];
  /** (PR6 review) Overdue expenses a bank row is taken to have paid. Sorted by due date. */
  overdueAssumedPaid: LedgerAssumedPaidPlan[];
};

/** (PR6) How far back an overdue expense still drags onto the curve (#803's floor). */
export const DRAG_LOOKBACK_DAYS = 14;

/** Resolution statuses that close a plan occurrence for the curve. */
const CLOSING_STATUSES: ReadonlySet<string> = new Set(["matched", "skipped", "missed", "dismissed"]);

/**
 * ⚠️ (PR6, temporary — PR8 deletes this) Weekly-cadence EXPENSES keep the
 * pre-PR6 rule: the pre-snapshot drop (#666) with its one-day exception (#688),
 * and the drag as it was. The Weekly Spend reserve is a plain weekly bill that no
 * bank row ever pays, so the overdue rule would drag up to two weeks of it onto
 * one day. PR8 replaces the funding bills with Amex payoff events.
 */
export function keepsPreSnapshotRule(
  item: { frequency: string } | undefined,
  amount: number,
): boolean {
  return !!item && amount < 0 && (item.frequency === "weekly" || item.frequency === "biweekly");
}

/**
 * ⭐ THE FORECAST LEDGER — everything the cash curve is made of, before any of
 * it is summed.
 *
 * Extracted verbatim from `computeCashSignal` (PR4a), which now only walks these
 * items into the daily series. `forecastLedger.golden.integration.test.ts` pins
 * the full `computeCashSignal` output recorded before the extraction.
 *
 * Anchored on the bank snapshot when present (what each row adds is
 * `classifyCashRows`, PR4e — the same rule "Why this number?" and the Sync's
 * reconciliation use):
 *   - A checking row counts unless the snapshot already holds it (PR4b,
 *     `isInSnapshot`): rows dated before the snapshot day; snapshot-day rows,
 *     unless the institution's own time shows they happened after the read;
 *     and Plaid charges the ledger already had at the read, dated up to five
 *     days after it.
 *   - A pending row its posted row replaced (PR4c, `pairPendingWithPosted`)
 *     never counts; the posted row counts only what the snapshot did not
 *     already hold of the pair.
 *   - ⭐ (PR6) OVERDUE BILLS ARE ASSUMED UNPAID — EVIDENCE, NOT THE SNAPSHOT DATE.
 *     The pre-snapshot drop (#666) and its one-day exception (#688) are gone:
 *     a Sync stamps the snapshot "now", so the drop hid every unpaid bill due
 *     before the last Sync. In order, a plan occurrence is:
 *       1. resolved (matched / skipped / missed / dismissed; a `partial` keeps
 *          its remainder) → as the resolution says;
 *       2. ⭐ (PR6 review) PAID ON EVIDENCE, once due: a non-ambiguous pair of
 *          ANY confidence (PR5) to a checking row dated on or before today (never
 *          a row the user tagged to a different debt than the plan's), or, for a
 *          debt minimum, a payment of at least the minimum that names the card or
 *          (debt tag) that the user tagged to that debt → off the curve and
 *          listed in `overdueAssumedPaid`; an unpaid
 *          remainder over $1 still drags (`overdue_remainder_assumed_unpaid`).
 *          ⚠️ Accepted risk: an unrelated row of the same amount within 3 days
 *          hides an unpaid bill — one plan per row, and always listed.
 *          A plan due AFTER today still leaves the curve only on an `offCurve` pair;
 *       3. an expense due in [today−14, today) with no such evidence → the next
 *          business day, `overdue_assumed_unpaid`;
 *          due today → the next business day, `due_today_not_posted`, so day 0
 *          still equals the bank;
 *          older than 14 days → `overdueOutsideForecast`, off the curve;
 *          income due before today → `incomeNotArrived`, off the curve;
 *       4. otherwise on its own (rescheduled) date.
 *     Occurrences dated before their item existed (anchor date, else created
 *     date; a debt's created date for its minimum) are never overdue.
 *     ⚠️ Weekly-cadence expenses keep the old rule until PR8
 *     (`keepsPreSnapshotRule`).
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
  // without this cap the chart spikes downward every time an
  // ancient unresolved plan gets carried onto today+1. (PR6) They are
  // no longer dropped silently: an expense lands in
  // `overdueOutsideForecast`, off the curve.
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
  const expandStartISO = fmtISO(expandStart);
  // (PR6 review, M2) The off-curve lists reach back to the first of last month and
  // no further, whatever the snapshot day or the window (a January snapshot used
  // to list back to January).
  const listFromISO = fmtISO(priorMonthStart);

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
    // (PR6) A one-time bill dated before today no longer links its debt: before
    // PR6 it was archived by then (see `isPastOneTime`).
    if (r.debtId && r.active === "true" && !isPastOneTime(r, todayISO) && !linkedRecurringByDebt.has(r.debtId)) {
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
  const { expandDebtMin, expandAvalancheExtra, resolutionScheduleLookup, AVALANCHE_EXTRA_EVENT_ITEM_ID } =
    await import("./debtMinSchedule");
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

  // (PR6) Each item's schedule — to map a resolution a schedule edit orphaned
  // (`remapOrphanResolutions`) — and the first day an occurrence can belong to it.
  const recurringById = new Map(recurring.map((r) => [r.id, r] as const));
  const debtById = new Map(debtsList.map((d) => [d.id, d] as const));
  const scheduleOf: (itemId: string) => ResolutionSchedule | null =
    resolutionScheduleLookup(recurring, debtsList, linkedRecurringByDebt);
  // The anchor date, else the day the item was created; a debt minimum starts
  // on the debt's created day. (PR6 review, M1) The Avalanche extra starts on the
  // day its settings were last saved: setting a $500 extra on 05-05 must not drag
  // a 04-30 payment nobody scheduled. ⚠️ Saving the settings again (raising the
  // extra) moves that start to the save day.
  const itemStartISO = (itemId: string): string | null => {
    const r = recurringById.get(itemId);
    if (r) return r.anchorDate ?? householdDayOf(r.createdAt);
    if (itemId.startsWith("debt:")) {
      const d = debtById.get(itemId.slice("debt:".length));
      return d ? householdDayOf(d.createdAt) : null;
    }
    if (itemId === AVALANCHE_EXTRA_EVENT_ITEM_ID) {
      return avaSettingsRow?.updatedAt ? householdDayOf(avaSettingsRow.updatedAt) : null;
    }
    return null;
  };
  const beforeItemExisted = (ev: CashEvent): boolean => {
    const start = itemStartISO(ev.itemId);
    return start != null && ev.date < start;
  };
  const keepsOldRule = (ev: CashEvent): boolean =>
    keepsPreSnapshotRule(recurringById.get(ev.itemId), ev.amount);

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
  // A calendar day is not enough: the balance is read at an INSTANT. A
  // snapshot-day row can have happened after the read, and a Plaid charge dated
  // a few days ahead can already be inside it (a posted row re-keyed from its
  // pending row keeps the pending row's `created_at`). With a snapshot the
  // query therefore reads the snapshot day too, and `isInSnapshot` decides each
  // row — see there for why `created_at` never decides the snapshot day.
  // Because `bankToday` and the curve take their rows from this one loop, they
  // cannot disagree about it.
  const actualUpperISO = toISO > todayISO ? toISO : todayISO;
  // (PR4c) With a snapshot the query reaches SUPERSEDE_MAX_DAYS before the
  // anchor, where the pending half of a pair can sit. See `ledgerActualRowsWhere`.
  const actualRowsAll = await db
    .select()
    .from(transactionsTable)
    .where(
      ledgerActualRowsWhere({
        householdId,
        snapshotDay: snapshotISO,
        todayISO,
        upperISO: actualUpperISO,
      }),
    );
  let bankToday = startBalanceAtAnchor;
  const actuals: LedgerActual[] = [];
  // ⭐ WHAT EACH ROW ADDS — `classifyCashRows` (PR4e), the one rule shared with
  // "Why this number?" and the Sync's reconciliation. Moved verbatim from here:
  //   - held by the snapshot (PR4b, `isInSnapshot`) → 0;
  //   - not on the snapshot's account (`isBankRow`) → 0;
  //   - ⭐ A PENDING ROW ITS POSTED ROW REPLACED COUNTS ONCE (PR4c). Normally the
  //     sync re-keys the pending row onto its posted row, so they are one row.
  //     When that link is missing both rows sit here and the charge would count
  //     twice. `pairPendingWithPosted` pairs them (heuristic; see there). The
  //     pending half never counts. What the posted half adds (PR4c review):
  //       posted and pending both held by the snapshot       → 0 (the balance has it)
  //       pending CHARGE with evidence it was in the balance → posted − pending (the tip)
  //       otherwise                                          → posted, in full
  //     A held posted row whose pending half is NOT held still counts: it reached
  //     the ledger after that pending half and is dated on or after it, so it
  //     cannot be inside a balance the pending half was not. Pending deposits
  //     never leave only a difference — `available` does not hold them.
  //   - a repeated plaid transaction id → 0 (defensive only: the id is unique).
  // Rows that count are summed into `bankToday` and become actuals in the order
  // the query returned them, as before the move.
  const cash = classifyCashRows(actualRowsAll.map(toCashRow), {
    anchor: snapshotISO && snapshotAt ? { at: snapshotAt, day: snapshotISO } : null,
    accountExternalId: configuredCheckingExternalId,
    todayISO,
  });
  for (const r of cash.rows) {
    if (!r.counts) continue;
    if (snapshotISO && r.occurredOn <= todayISO) bankToday += r.contribution;
    if (r.occurredOn <= toISO) {
      actuals.push({ kind: "actual", date: r.occurredOn, amount: r.contribution, matched: false, txnId: r.id });
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
  const resolutionsRead = await db
    .select()
    .from(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, householdId));
  // (PR6) A resolution a schedule edit orphaned follows its bill to the item's
  // occurrence in the same period. Read-only; the web register maps the same way.
  const resolutionsAll = remapOrphanResolutions(resolutionsRead, scheduleOf);
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
  const resolvedTxnAmount = new Map<string, number>();
  if (matchedIds.length > 0) {
    const matchedTxns = await db
      .select({
        id: transactionsTable.id,
        source: transactionsTable.source,
        plaidAccountId: transactionsTable.plaidAccountId,
        amount: transactionsTable.amount,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          inArray(transactionsTable.id, matchedIds),
        ),
      );
    for (const t of matchedTxns) {
      resolvedTxnAmount.set(t.id, Number(t.amount) || 0);
      if (isBankRow(t.source, t.plaidAccountId ?? null, configuredCheckingExternalId)) {
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
    } else if (r.status === "partial") {
      // (PR5) A partial confirmation accepts the row like a match; its plan's
      // remainder stays scheduled (plans loop below).
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
  // (PR6) Before PR6 the Past-due card and the chart tooltip sent a moved bill's
  // moved-to date as its occurrence, so their Mark missed / Skip / match landed on
  // a key the curve never read (the register did read it). Such a resolution
  // still closes the moved occurrence — unless that date is an occurrence of the
  // item in its own right, whose resolution it is.
  const closingKeys = new Set<string>();
  for (const r of resolutionsAll) {
    if (CLOSING_STATUSES.has(r.status) && r.recurringItemId && r.occurrenceDate) {
      closingKeys.add(`${r.recurringItemId}|${r.occurrenceDate}`);
    }
  }
  const closedAtMovedDate = (ev: CashEvent, planDate: string): boolean => {
    if (planDate === ev.date || !closingKeys.has(`${ev.itemId}|${planDate}`)) return false;
    const day = parseISO(planDate);
    return !(scheduleOf(ev.itemId)?.occurrences(day, day) ?? []).includes(planDate);
  };

  // ⭐ "PROBABLY PAID" (PR5). A planned payment a bank row probably paid leaves
  // the curve — the row already counts, so keeping the plan too would count the
  // bill twice (a $150 bill paid at $173 would weigh −$323). Read-only: nothing
  // is written; the user confirms ("matched" / "partial") or rejects
  // ("not_match") on the Forecast page. `bankToday` is final above and never
  // moves here.
  //   - Plans: unresolved occurrences dated today−45 .. today+10 (after any
  //     reschedule), from the same expansion the curve uses (it reaches back to
  //     the first of last month). Older occurrences are candidates so they
  //     compete for the rows that paid them.
  //   - Rows: checking rows dated today−59 .. today, from their own read (rows
  //     the snapshot holds are fine candidates), counted by the cash-row rule,
  //     and not claimed by any resolution other than "Not this". A posted row
  //     whose replaced pending row is claimed counts as claimed.
  //   - `matchPlansToRows` (avalanche-core) pairs them one to one.
  //   - ⚠️ (PR5 review) ONLY a pair marked `offCurve` — the payee's name as a
  //     word in the bank row, not ambiguous, within max($25, 10%) — takes its
  //     plan off the curve. Every other pair is a suggestion: the plan still
  //     counts, so an unconfirmed guess never overstates projected cash. A later
  //     occurrence also stays on the curve when an earlier occurrence of the same
  //     item that no named pair paid is due on or before the row: the row may be
  //     that earlier bill, paid late.
  const notMatchPairs = new Set<string>();
  const partialTxnByKey = new Map<string, string>();
  const claimedTxnIds = new Set<string>();
  for (const r of resolutionsAll) {
    if (r.status === "not_match") {
      if (r.recurringItemId && r.occurrenceDate && r.matchedTxnId) {
        notMatchPairs.add(`${r.recurringItemId}|${r.occurrenceDate}#${r.matchedTxnId}`);
      }
      continue;
    }
    // (One-time bill move) A `needs_review` / `needs_review_partial` pair is in none of the key sets above,
    // so its plan is unresolved and weighs on the curve by the usual rules. It
    // still holds its row: that row waits for the user's answer on the pair and is
    // not offered to another plan meanwhile.
    if (r.matchedTxnId) claimedTxnIds.add(r.matchedTxnId);
    if (r.status === "partial" && r.recurringItemId && r.occurrenceDate && r.matchedTxnId) {
      partialTxnByKey.set(`${r.recurringItemId}|${r.occurrenceDate}`, r.matchedTxnId);
    }
  }
  const planMatchFromISO = addDaysISO(todayISO, -45);
  const planMatchToISO = addDaysISO(todayISO, 10);
  const rowMatchFromISO = addDaysISO(todayISO, -59);
  const matchPlans: MatchPlan[] = [];
  // (PR6 review, M2) Overdue occurrences older than the matching window above
  // (before today−45, back to the first of last month) pair for LISTING only, so a
  // paid bill is never listed as overdue. Those pairs never reach `matches`.
  const listingPlans: MatchPlan[] = [];
  const listRowFromISO = addDaysISO(listFromISO, -MATCH_EARLY_DAYS);
  const rowReadFromISO = listRowFromISO < rowMatchFromISO ? listRowFromISO : rowMatchFromISO;
  for (const ev of events) {
    const key = `${ev.itemId}|${ev.date}`;
    if (
      matchedPlanKeys.has(key) ||
      skippedPlanKeys.has(key) ||
      missedPlanKeys.has(key) ||
      partialTxnByKey.has(key)
    ) {
      continue;
    }
    const planDate = rescheduledByKey.get(key) ?? ev.date;
    if (planDate > planMatchToISO) continue;
    const inMatchWindow = planDate >= planMatchFromISO;
    const forListing = !inMatchWindow && planDate >= listFromISO && planDate <= dragCutoffISO && !keepsOldRule(ev);
    if (!inMatchWindow && !forListing) continue;
    if (closedAtMovedDate(ev, planDate)) continue;
    // (PR6) An occurrence from before its item existed is never due, so it never
    // competes for a row (nor holds back a later occurrence's pair).
    if (planDate <= dragCutoffISO && !keepsOldRule(ev) && beforeItemExisted(ev)) continue;
    const plan: MatchPlan = { key, itemId: ev.itemId, occurrenceDate: ev.date, date: planDate, amount: ev.amount, label: ev.label };
    if (inMatchWindow) matchPlans.push(plan);
    else listingPlans.push(plan);
  }
  let matches: PlanRowMatch[] = [];
  let listingMatches: PlanRowMatch[] = [];
  let cardPayments: PaidInFull[] = [];
  // Pairs that count as overdue evidence: non-ambiguous, and never a row tagged to another debt.
  let evidencePairs: PlanRowMatch[] = [];
  if (matchPlans.length > 0 || listingPlans.length > 0) {
    const candidateRowsAll = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          inForecastWhere(todayISO),
          gte(transactionsTable.occurredOn, addDaysISO(rowReadFromISO, -SUPERSEDE_MAX_DAYS)),
          lte(transactionsTable.occurredOn, addDaysISO(todayISO, SUPERSEDE_MAX_DAYS)),
        ),
      );
    const candidateCashRows = candidateRowsAll.map(toCashRow);
    const classified = classifyCashRows(candidateCashRows, {
      anchor: null,
      accountExternalId: configuredCheckingExternalId,
      todayISO,
    });
    const matchRows: MatchRow[] = [];
    const listingRows: MatchRow[] = [];
    classified.rows.forEach((o, i) => {
      const row = candidateCashRows[i]!;
      if (!o.counts) return;
      if (row.occurredOn < rowReadFromISO || row.occurredOn > todayISO) return;
      if (claimedTxnIds.has(row.id) || (o.replacedId && claimedTxnIds.has(o.replacedId))) return;
      // (PR6 second review) PR7's card-payment signals travel with the row, for
      // `plansPaidInFullByName`: only a real card payment pays a card's minimum.
      // (Debt tag) So does the user's debt tag (PR7 rule 2) — ⚠️ (review M2) only on
      // a Plaid row on the checking account. `POST /debts/:id/payments` writes a
      // manual row tagged to the debt ("Payment — Chase Sapphire") for a payment the
      // bank also shows as its own row; counting that tag let one payment pay two
      // minimums (the log paid Sapphire by tag, the bank debit Freedom by name). A
      // manual row's tag is ignored here, so the row is read exactly as before the tag
      // rule. (`o.counts` already keeps out Plaid rows on other accounts.)
      const full = candidateRowsAll[i]!;
      const bankTag =
        full.debtId && row.plaidAccountId && row.plaidAccountId === configuredCheckingExternalId ? full.debtId : null;
      const candidate: MatchRow = {
        txnId: row.id,
        occurredOn: row.occurredOn,
        amount: row.amount,
        description: row.description,
        isExternalCardPayment: full.isExternalCardPayment === true,
        pfcDetailed: full.pfcDetailed ?? null,
        debtId: bankTag,
      };
      if (row.occurredOn >= listRowFromISO) listingRows.push(candidate);
      if (row.occurredOn >= rowMatchFromISO) matchRows.push(candidate);
    });
    matches = matchPlansToRows(matchPlans, matchRows, notMatchPairs);
    // ⭐ (Debt tag) A ROW THE USER TAGGED TO ONE DEBT IS NEVER A PAYMENT OF ANOTHER
    // DEBT'S PLAN — a `debt:` minimum, or a recurring bill linked to a debt — even
    // when the matcher paired them ("CHASE ONLINE PAYMENT" −45 tagged to Chase
    // Freedom, a day after a $40 Chase Sapphire minimum). Such a pair (`tagConflict`):
    //   - stays in `matches` as a suggestion, but (review M1) is never `offCurve`: a
    //     row tagged to Freedom must not both pay Freedom's overdue minimum by tag
    //     and take Sapphire's upcoming minimum off the curve;
    //   - is not overdue evidence, and doesn't count as a named pair for the
    //     earlier-unpaid rule below;
    //   - doesn't use up its row, which stays free to pay its own debt by tag.
    // Pairs whose row carries no tag, and plans with no debt, are untouched.
    const planDebtId = (itemId: string): string | null =>
      itemId.startsWith("debt:") ? itemId.slice("debt:".length) : (recurringById.get(itemId)?.debtId ?? null);
    const rowDebtById = new Map([...matchRows, ...listingRows].map((r) => [r.txnId, r.debtId ?? null] as const));
    const tagConflict = (m: PlanRowMatch): boolean => {
      const rowDebt = rowDebtById.get(m.txnId) ?? null;
      const planDebt = planDebtId(m.planItemId);
      return !!rowDebt && !!planDebt && rowDebt !== planDebt;
    };
    // (PR5 review) A later occurrence never leaves the curve on a row dated on or
    // after an earlier occurrence of the same item that no row paid.
    // (PR5 second review) Only a pair carrying the payee's name counts as paying an
    // occurrence: a coincidental nameless "low" pair never marks last month paid.
    const pairedKeys = new Set(
      matches.filter((m) => m.confidence !== "low" && !tagConflict(m)).map((m) => m.planKey),
    );
    const unpaidByItem = new Map<string, string[]>();
    for (const p of matchPlans) {
      if (pairedKeys.has(p.key)) continue;
      const list = unpaidByItem.get(p.itemId) ?? [];
      list.push(p.occurrenceDate);
      unpaidByItem.set(p.itemId, list);
    }
    const rowDateById = new Map(matchRows.map((r) => [r.txnId, r.occurredOn] as const));
    matches = matches.map((m) => {
      if (!m.offCurve) return m;
      if (tagConflict(m)) return { ...m, offCurve: false };
      const rowDate = rowDateById.get(m.txnId) ?? "";
      const earlierUnpaid = (unpaidByItem.get(m.planItemId) ?? []).some(
        (d) => d < m.planDate && d <= rowDate,
      );
      return earlierUnpaid ? { ...m, offCurve: false } : m;
    });
    const isEvidence = (m: PlanRowMatch): boolean => !m.ambiguous && !tagConflict(m);
    // (Debt tag, review M1) One row pays at most once: a row whose pair takes its
    // plan off the curve (`offCurve`) or counts as overdue evidence is used up.
    // (PR6 review, M2) The older overdue occurrences pair with the rows the pass
    // above left unpaired — for the lists only (listing pairs never leave the curve,
    // so only their evidence uses a row).
    const usedRows = new Set(matches.filter((m) => m.offCurve || isEvidence(m)).map((m) => m.txnId));
    if (listingPlans.length > 0) {
      listingMatches = matchPlansToRows(
        listingPlans,
        listingRows.filter((r) => !usedRows.has(r.txnId)),
        notMatchPairs,
      );
      for (const m of listingMatches) if (isEvidence(m)) usedRows.add(m.txnId);
    }
    // (PR6 review, H1-R4) A debt minimum already due is paid by a payment of at
    // least the minimum even when no pair was found ($40 due, $812.40 paid): a card
    // payment naming the card, or (debt tag) a row the user tagged to that debt.
    // Overdue evidence only.
    const pairedKeys2 = new Set([...matches, ...listingMatches].filter(isEvidence).map((m) => m.planKey));
    const dueMinimums = [...matchPlans, ...listingPlans]
      .filter((p) => p.itemId.startsWith("debt:") && p.date <= dragCutoffISO && !pairedKeys2.has(p.key))
      .map((p) => ({ ...p, debtId: planDebtId(p.itemId) }));
    if (dueMinimums.length > 0) {
      cardPayments = plansPaidInFullByName(
        dueMinimums,
        listingRows.filter((r) => !usedRows.has(r.txnId)),
        notMatchPairs,
      );
    }
    evidencePairs = [...matches, ...listingMatches].filter(isEvidence);
  }
  // Only confident pairs take a plan off the curve; the rest are suggestions.
  const probablyPaidKeys = new Set(matches.filter((m) => m.offCurve).map((m) => m.planKey));
  // ⭐ (PR6 review, H1) EVIDENCE THAT AN OVERDUE PLAN WAS PAID: a non-ambiguous pair
  // of any confidence (never a row tagged to another debt), or, for a debt
  // minimum, a card payment naming the card or a checking row tagged to that debt.
  // Read only for plans due on or before today (the plans loop); a plan due later
  // still needs `offCurve` (never set on a pair whose row is tagged to another debt).
  const paidByKey = new Map<string, { txnId: string; txnAmount: number; confidence: string }>();
  for (const m of evidencePairs) {
    paidByKey.set(m.planKey, { txnId: m.txnId, txnAmount: m.txnAmount, confidence: m.confidence });
  }
  for (const c of cardPayments) {
    if (!paidByKey.has(c.planKey)) {
      paidByKey.set(c.planKey, { txnId: c.txnId, txnAmount: c.txnAmount, confidence: c.evidence });
    }
  }

  const plans: LedgerPlan[] = [];
  const overdueOutsideForecast: LedgerListedPlan[] = [];
  const incomeNotArrived: LedgerListedPlan[] = [];
  const overdueAssumedPaid: LedgerAssumedPaidPlan[] = [];
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
    // (PR6) A pre-PR6 Mark missed / Skip / match sent on the moved-to date.
    if (closedAtMovedDate(ev, rawEffectiveDate)) continue;
    // (PR5) A partial confirmation leaves only the unpaid remainder scheduled.
    let planAmount = ev.amount;
    const partialTxn = partialTxnByKey.get(origKey);
    if (partialTxn) {
      const paid = resolvedTxnAmount.get(partialTxn);
      if (paid != null) {
        const remainder = Math.round((ev.amount - paid) * 100) / 100;
        if (Math.abs(remainder) <= 1 || Math.sign(remainder) !== Math.sign(ev.amount)) continue;
        planAmount = remainder;
      }
    }
    // ⚠️ (PR6, until PR8) WEEKLY-CADENCE EXPENSES KEEP THE PRE-PR6 RULE
    // (`keepsPreSnapshotRule`): (#666) a plan dated before the snapshot is
    // dropped, except (#688) an expense dated the day before it.
    const oldRule = keepsOldRule(ev);
    // (PR5) A plan a bank row probably paid (`offCurve`) is off the curve until the
    // user confirms or rejects the suggestion; the row already counts. This holds
    // for a plan due after today, and for weekly-cadence expenses at any date.
    // (PR6 review) A plan already due uses the evidence rule below instead.
    if ((rawEffectiveDate > dragCutoffISO || oldRule) && probablyPaidKeys.has(origKey)) continue;
    if (oldRule && snapshotISO && rawEffectiveDate < snapshotISO) {
      const oneDayBeforeSnap = fmtISO(addDays(parseISO(snapshotISO), -1));
      const stillEligibleForDrag =
        ev.amount < 0 &&
        rawEffectiveDate >= oneDayBeforeSnap &&
        rawEffectiveDate <= dragCutoffISO;
      if (!stillEligibleForDrag) continue;
    }
    // ⭐ (PR6) DUE ON OR BEFORE TODAY (or the snapshot day, when that is later) AND
    // UNRESOLVED (handled above). Nothing lands on today, so day 0 equals the bank:
    //   - (PR6 review) PAID ON EVIDENCE — a non-ambiguous pair of any confidence,
    //     or a card payment for a debt minimum → off the curve, `overdueAssumedPaid`;
    //     a remainder over $1 drags, `overdue_remainder_assumed_unpaid`;
    //   - otherwise, expense due in [today−14, today) → next business day, `overdue_assumed_unpaid`;
    //   - expense due today → next business day, `due_today_not_posted`;
    //   - expense older than 14 days (#803's floor) → `overdueOutsideForecast`;
    //   - income due before today → `incomeNotArrived`; due today → off the curve,
    //     as before. A paycheck that has not landed never raises the curve.
    if (rawEffectiveDate <= dragCutoffISO) {
      const dueBeforeToday = rawEffectiveDate < todayISO;
      if (oldRule) {
        if (rawEffectiveDate < dragFloorISO) continue;
        plans.push({
          kind: "plan",
          eventKind: ev.kind,
          date: dragTargetISO,
          originalDate: rawEffectiveDate,
          occurrenceDate: ev.date,
          amount: planAmount,
          itemId: ev.itemId,
          label: ev.label,
          assumption: dueBeforeToday ? "dragged_past_due" : "due_today_not_posted",
        });
        continue;
      }
      // Never due: an occurrence from before its item existed (weekly/biweekly
      // expansion walks back past the anchor, semimonthly ignores it, a debt
      // minimum starts on the debt's created day, the Avalanche extra on the day
      // its settings were saved). (PR6 review, M2) Nothing due before the first
      // of last month is dragged or listed.
      if (beforeItemExisted(ev) || rawEffectiveDate < listFromISO) continue;
      const daysOverdue = Math.round(
        (todayDateOnly.getTime() - parseISO(rawEffectiveDate).getTime()) / 86_400_000,
      );
      const listed: LedgerListedPlan = {
        planKey: origKey,
        itemId: ev.itemId,
        occurrenceDate: ev.date,
        dueDate: rawEffectiveDate,
        amount: planAmount,
        label: ev.label,
        daysOverdue,
      };
      const paid = paidByKey.get(origKey);
      if (ev.amount >= 0) {
        // (PR6 review, M2) A deposit that paired with the paycheck arrived, name or not.
        if (ev.amount > 0 && dueBeforeToday && !paid) incomeNotArrived.push(listed);
        continue;
      }
      if (paid) {
        // ⭐ (PR6 review, H1) Paid for the curve. Only what the row did not cover drags.
        const remainder = Math.max(
          0,
          Math.round((Math.abs(planAmount) - Math.abs(paid.txnAmount)) * 100) / 100,
        );
        overdueAssumedPaid.push({
          planKey: origKey,
          itemId: ev.itemId,
          occurrenceDate: ev.date,
          dueDate: rawEffectiveDate,
          label: ev.label,
          daysOverdue,
          planAmount,
          txnId: paid.txnId,
          txnAmount: paid.txnAmount,
          confidence: paid.confidence,
          unpaidRemainder: remainder > 1 ? -remainder : 0,
        });
        if (remainder > 1 && rawEffectiveDate >= dragFloorISO) {
          plans.push({
            kind: "plan",
            eventKind: ev.kind,
            date: dragTargetISO,
            originalDate: rawEffectiveDate,
            occurrenceDate: ev.date,
            amount: -remainder,
            itemId: ev.itemId,
            label: ev.label,
            assumption: "overdue_remainder_assumed_unpaid",
          });
        }
        continue;
      }
      if (rawEffectiveDate < dragFloorISO) {
        overdueOutsideForecast.push(listed);
        continue;
      }
      plans.push({
        kind: "plan",
        eventKind: ev.kind,
        date: dragTargetISO,
        originalDate: rawEffectiveDate,
        occurrenceDate: ev.date,
        amount: planAmount,
        itemId: ev.itemId,
        label: ev.label,
        assumption: dueBeforeToday ? "overdue_assumed_unpaid" : "due_today_not_posted",
      });
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
      occurrenceDate: ev.date,
      amount: planAmount,
      itemId: ev.itemId,
      label: ev.label,
      ...(effectiveDate !== rawEffectiveDate
        ? { assumption: "pre_window_on_first_day" as const }
        : {}),
    });
  }

  // Due date, then label, then key. ⚠️ The key embeds a random item id, so two
  // plans due the same day must be told apart by label first, or their order
  // changes from one read to the next (the golden "ties" entry caught it).
  type Sortable = { dueDate: string; label: string; planKey: string };
  const byDueDate = (a: Sortable, b: Sortable): number =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1
      : a.label < b.label ? -1 : a.label > b.label ? 1
        : a.planKey < b.planKey ? -1 : a.planKey > b.planKey ? 1 : 0;
  overdueOutsideForecast.sort(byDueDate);
  incomeNotArrived.sort(byDueDate);
  overdueAssumedPaid.sort(byDueDate);

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
    matches,
    overdueOutsideForecast,
    incomeNotArrived,
    overdueAssumedPaid,
  };
}

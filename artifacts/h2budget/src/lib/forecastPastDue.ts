import type { PlanLine } from "./forecastMatch";

/**
 * ⭐ (PR6) THE PAST-DUE CARD AND THE CHART TOOLTIP ACT ON THE OCCURRENCE KEY.
 *
 * Resolutions are keyed on `<itemId>|<occurrenceDate>`, the occurrence's own
 * date. For a MOVED bill the cash signal's `originalDate` is the moved-to date,
 * and before PR6 the card and the tooltip sent that as the occurrence — so Mark
 * missed / Skip / match on a moved-then-overdue bill wrote a key the curve never
 * read, and nothing moved. The cash signal now carries `occurrenceDate`; these
 * builders put it where the page's handlers read it (`PlanLine.originalDate`,
 * which `onMarkMissed` and `matchInboxToPlan` send as `occurrenceDate`).
 *
 * Pure: moved out of `pages/forecast.tsx` unchanged apart from the key.
 */

/** The shape of `CashSignal.events[]` this module reads. */
export type SignalEvent = {
  date: string;
  label: string;
  amount: string;
  itemId?: string;
  originalDate?: string;
  occurrenceDate?: string;
};

export type DayEvent = {
  label: string;
  amount: number;
  itemId?: string;
  /**
   * (#650) True iff the cash signal pulled this event forward onto its day. The
   * tooltip keeps "Dragged onto this day" to those; bills naturally due that day
   * go under their own heading.
   */
  dragged: boolean;
  /** The (moved-to) date it was due, before any drag. Shown to the user. */
  originalDate?: string;
  /** The resolution key date. Sent by every action. */
  occurrenceDate?: string;
};

export type DraggingPlanRow = {
  itemId: string;
  label: string;
  amount: number;
  /** The (moved-to) date it was due. Shown as "Due …" and used in test ids. */
  originalDate: string;
  /** The resolution key date. */
  occurrenceDate: string;
  effectiveDate: string;
};

/** The date an action on this event must send: the occurrence, never the moved-to date. */
export function occurrenceDateOf(e: { date: string; originalDate?: string; occurrenceDate?: string }): string {
  return e.occurrenceDate ?? e.originalDate ?? e.date;
}

/** Expense events by the day they weigh on, largest outflow first. */
export function buildEventsByDate(events: SignalEvent[]): Map<string, DayEvent[]> {
  const map = new Map<string, DayEvent[]>();
  for (const e of events) {
    const amt = Number(e.amount);
    if (!Number.isFinite(amt) || amt >= 0) continue;
    const slot = map.get(e.date) ?? [];
    const orig = e.originalDate;
    slot.push({
      label: e.label,
      amount: amt,
      itemId: e.itemId,
      dragged: !!orig && orig !== e.date,
      originalDate: orig,
      occurrenceDate: occurrenceDateOf(e),
    });
    map.set(e.date, slot);
  }
  for (const [, list] of map) list.sort((a, b) => a.amount - b.amount);
  return map;
}

/** (#683) Plans the cash signal carried forward off their due date, oldest due first. */
export function buildDraggingPlans(events: SignalEvent[]): DraggingPlanRow[] {
  const rows: DraggingPlanRow[] = [];
  for (const e of events) {
    const orig = e.originalDate;
    if (!orig || orig === e.date) continue;
    const amt = Number(e.amount);
    if (!Number.isFinite(amt) || amt >= 0) continue;
    rows.push({
      itemId: e.itemId ?? "",
      label: e.label,
      amount: amt,
      originalDate: orig,
      occurrenceDate: occurrenceDateOf(e),
      effectiveDate: e.date,
    });
  }
  rows.sort((a, b) =>
    a.originalDate < b.originalDate ? -1 : a.originalDate > b.originalDate ? 1 : a.amount - b.amount,
  );
  return rows;
}

/** The register line the Past-due card's actions receive. */
export function draggingPlanLine(row: DraggingPlanRow): PlanLine {
  return {
    kind: "plan",
    date: row.effectiveDate,
    itemId: row.itemId,
    label: row.label,
    amount: row.amount,
    status: "pending_plan",
    originalDate: row.occurrenceDate,
  };
}

/** The register line the tooltip's Mark missed receives. */
export function tooltipPlanLine(b: DayEvent & { itemId: string }, rawDate: string): PlanLine {
  return {
    kind: "plan",
    itemId: b.itemId,
    label: b.label,
    amount: b.amount,
    date: rawDate,
    originalDate: occurrenceDateOf({ date: rawDate, originalDate: b.originalDate, occurrenceDate: b.occurrenceDate }),
    status: "pending_plan",
  };
}

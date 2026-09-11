/**
 * ⭐ (PR6) A RESOLUTION FOLLOWS ITS BILL WHEN THE SCHEDULE IS EDITED — read-only.
 *
 * Resolutions are keyed on `<itemId>|<occurrenceDate>`. `PATCH /recurring-items/:id`
 * overwrites the schedule and never touches them, so moving a bill's due day from
 * the 14th to the 20th after the 14th was matched leaves the match on a date the
 * bill no longer has, and the 20th appears as a second, unpaid bill.
 *
 * Nothing is written. At read time, a resolution whose date is not an occurrence
 * of its item moves to the item's occurrence in the same period:
 *   - monthly, quarterly, annual (and debt minimums, which are monthly): the
 *     occurrence in the same calendar month;
 *   - weekly, biweekly, semimonthly: the nearest occurrence within half a period
 *     (3, 7 and 7 days); an exact tie maps nowhere.
 * It moves only when that occurrence has no resolution of its own (any status,
 * "Not this" included) and no earlier orphan claimed it. Every resolution at the
 * orphaned date moves together, so a rejection ("not_match") follows its bill the
 * same way a match does. One-time bills and inactive items never map.
 *
 * The ledger and the `/forecast` bundle (the web register) both call this, so the
 * curve and the register agree on which occurrence a resolution belongs to.
 */

export type ResolutionSchedule = {
  /** `recurring_items.frequency`, or "monthly" for a debt minimum. */
  cadence: string;
  /** The item's occurrence dates (YYYY-MM-DD) in [from, to], both inclusive. */
  occurrences: (from: Date, to: Date) => string[];
};

type Keyed = {
  recurringItemId: string | null;
  occurrenceDate: string | null;
  status?: string;
  rescheduledTo?: string | null;
};

const SAME_MONTH_CADENCES: ReadonlySet<string> = new Set(["monthly", "quarterly", "annual"]);
/** Half a period, in whole days: the furthest an orphan may sit from the occurrence it maps to. */
export const HALF_PERIOD_DAYS: Readonly<Record<string, number>> = {
  weekly: 3,
  biweekly: 7,
  semimonthly: 7,
};

function dayOf(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shift(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function daysBetween(a: string, b: string): number {
  return Math.round((dayOf(b).getTime() - dayOf(a).getTime()) / 86_400_000);
}

/** The occurrence an orphaned date maps to, or null (see the file header). */
export function occurrenceInSamePeriod(date: string, schedule: ResolutionSchedule): string | null {
  const day = dayOf(date);
  if (SAME_MONTH_CADENCES.has(schedule.cadence)) {
    const occ = schedule.occurrences(
      new Date(day.getFullYear(), day.getMonth(), 1),
      new Date(day.getFullYear(), day.getMonth() + 1, 0),
    );
    return occ.length === 1 ? occ[0]! : null;
  }
  const half = HALF_PERIOD_DAYS[schedule.cadence];
  if (half == null) return null;
  const occ = schedule.occurrences(shift(day, -half), shift(day, half));
  let best: string | null = null;
  let bestGap = Infinity;
  let tie = false;
  for (const o of occ) {
    const gap = Math.abs(daysBetween(date, o));
    if (gap < bestGap) {
      best = o;
      bestGap = gap;
      tie = false;
    } else if (gap === bestGap) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * Returns the resolutions with orphaned occurrence dates moved (copies; the input
 * is not mutated). Resolutions without an item or a date pass through unchanged.
 */
export function remapOrphanResolutions<R extends Keyed>(
  resolutions: R[],
  scheduleOf: (itemId: string) => ResolutionSchedule | null,
): R[] {
  const ownKeys = new Set<string>();
  // (PR6 review, H2) A date the item was MOVED to is not an orphan. Before PR6
  // the Past-due card and the tooltip wrote a moved bill's Mark missed / match /
  // Move on its moved-to date; treating that date as an orphan would carry the
  // answer onto next month's bill (April 28 moved to 05-02, a 05-02 "matched"
  // landing on May 28). The ledger's `closedAtMovedDate` reads it instead.
  const movedToKeys = new Set<string>();
  for (const r of resolutions) {
    if (r.recurringItemId && r.occurrenceDate) ownKeys.add(`${r.recurringItemId}|${r.occurrenceDate}`);
    if (r.status === "rescheduled" && r.recurringItemId && r.rescheduledTo) {
      movedToKeys.add(`${r.recurringItemId}|${r.rescheduledTo}`);
    }
  }
  // Earliest orphan first, so the result never depends on read order.
  const sources = [...ownKeys].sort((a, b) => {
    const da = a.slice(a.lastIndexOf("|") + 1);
    const dbb = b.slice(b.lastIndexOf("|") + 1);
    return da < dbb ? -1 : da > dbb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const claimed = new Set<string>();
  const targetBySource = new Map<string, string>();
  for (const key of sources) {
    const cut = key.lastIndexOf("|");
    const itemId = key.slice(0, cut);
    const date = key.slice(cut + 1);
    if (movedToKeys.has(key)) continue;
    const schedule = scheduleOf(itemId);
    if (!schedule) continue;
    const day = dayOf(date);
    if (schedule.occurrences(day, day).includes(date)) continue;
    const target = occurrenceInSamePeriod(date, schedule);
    if (!target) continue;
    const targetKey = `${itemId}|${target}`;
    if (ownKeys.has(targetKey) || claimed.has(targetKey)) continue;
    claimed.add(targetKey);
    targetBySource.set(key, target);
  }
  if (targetBySource.size === 0) return resolutions;
  return resolutions.map((r) => {
    if (!r.recurringItemId || !r.occurrenceDate) return r;
    const target = targetBySource.get(`${r.recurringItemId}|${r.occurrenceDate}`);
    return target ? { ...r, occurrenceDate: target } : r;
  });
}

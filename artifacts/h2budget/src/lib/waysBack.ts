import { addDaysISO } from "@workspace/avalanche-core/householdTime";
import { fmtMoney } from "@/lib/money";

/**
 * Words for the "way back" from a week that is over its limit (F7). Ported from
 * the frozen h2 app (`today/WaysBackSheet.tsx` `fmtCents`/`errorWords`,
 * `today/words.ts` `weekdayName`). Nothing here works out a money figure: whole
 * cents arrive from `GET /money/ways-back`; this only formats them.
 */

/** Whole cents from the API, as money. Formatting only. */
export const fmtCents = (cents: number | null | undefined): string =>
  fmtMoney(cents == null ? null : cents / 100);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function weekdayName(iso: string): string {
  return DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()] ?? "";
}

export function errorWords(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  return status === 403 ? "Only the household owner can do this." : "Couldn't save that. Try again.";
}

/**
 * The carry-over the household chose, in words, for the week an Allowances
 * card is showing. `adjustment` is the spine's `position.weekAdjustment`
 * (signed two-decimal dollars, never positive; `weekStart` the Sunday it
 * lowers). Null when it does not touch the week shown or the week after it.
 */
export function carryOverLine(
  adjustment: { amount: string; weekStart: string } | null | undefined,
  shownWeekStart: string,
  currentWeekStart: string,
): string | null {
  if (!adjustment) return null;
  const n = Number(adjustment.amount);
  if (!Number.isFinite(n) || n >= 0) return null;
  const lower = fmtMoney(Math.abs(n));
  if (adjustment.weekStart === shownWeekStart) {
    return shownWeekStart === currentWeekStart
      ? `This week starts ${lower} lower (you chose this)`
      : `That week started ${lower} lower (you chose this)`;
  }
  if (adjustment.weekStart === addDaysISO(shownWeekStart, 7)) {
    return `Next week starts ${lower} lower (you chose this)`;
  }
  return null;
}

/**
 * ⭐ A MISSING AMOUNT IS "—", NEVER "$0.00".
 *
 * `formatCurrency` (`lib/utils.ts`) paints null, undefined and anything
 * unreadable as "$0.00" — the most dangerous figure a money screen can show,
 * because a zero that was never received looks exactly like a real one
 * (CLAUDE.md §3: missing balance fields stay blank, never zero). `fmtMoney`
 * is the replacement for new panels: for every readable amount it prints
 * exactly what `formatCurrency` prints (dollars and cents), and for anything
 * else it prints `MISSING`.
 *
 * `{ whole: true }` is the h2 app's whole-dollar form ("$1,235"), rounded half
 * away from zero through integer cents, for screens folded in from h2.
 *
 * (C0) Ported from the frozen h2 app (`artifacts/h2/src/lib/money.ts`) with
 * its tests; the cents default is this app's. Code computes every figure —
 * these only format one.
 */
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export const MISSING = "—";

/** A money value from the API (string or number) as a finite number, or null. */
export function toAmount(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whole dollars, rounded half away from zero via integer cents. */
export function wholeDollars(amount: number): number {
  const cents = Math.round(Math.abs(amount) * 100);
  const dollars = Math.floor((cents + 50) / 100);
  return amount < 0 && dollars !== 0 ? -dollars : dollars;
}

/**
 * "$1,234.50" (or "$1,235" with `whole`) — or "—" when there is no amount.
 * Accepts the API's money strings. Never prints a negative zero.
 */
export function fmtMoney(
  amount: string | number | null | undefined,
  opts: { whole?: boolean } = {},
): string {
  const n = toAmount(amount);
  if (n == null) return MISSING;
  if (opts.whole) return USD_WHOLE.format(wholeDollars(n));
  const shown = USD.format(n);
  return shown === "-$0.00" ? "$0.00" : shown;
}

/** The exact value a figure stands for, to the cent ("1234.56"), for `<data value>`. */
export function centsValue(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

/**
 * ⭐ MONEY ON SCREEN IS WHOLE DOLLARS.
 *
 * The owner's standing preference is "no cents": every figure renders rounded
 * half-up to the dollar (half away from zero, so −$2.50 shows −$3, the same
 * magnitude as $2.50). Cents appear only inside detail sheets, later.
 *
 * Rounding goes through integer cents first, so a value that arrives as the
 * string "1234.50" never meets binary-float noise on the way to $1,235.
 *
 * A missing amount is "—", never "$0". A zero that was never received is the
 * most dangerous figure a money screen can paint.
 */
const USD = new Intl.NumberFormat("en-US", {
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

/** "$1,235" — or "—" when there is no amount. */
export function fmtMoney(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return MISSING;
  return USD.format(wholeDollars(amount));
}

/** The exact value a figure stands for, to the cent ("1234.56"), for `<data value>`. */
export function centsValue(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

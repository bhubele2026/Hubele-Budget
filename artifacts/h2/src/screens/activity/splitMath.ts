/**
 * The split sheet's arithmetic, in whole cents so no float noise reaches the
 * remainder line. It only gates the Save button and signs what is typed; the
 * server checks the parts against the charge again and is the authority.
 */
const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** "12.5" -> 1250. Null for anything that is not a plain amount (empty, "1.234", "abc"). */
export function parseCents(input: string): number | null {
  const m = AMOUNT.exec(input.trim());
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -cents : cents;
}

/** 1250 -> "12.50". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** The parent's size in cents, ignoring its sign (the sheet works in magnitudes). */
export function chargeCents(amount: string): number {
  const c = parseCents(amount);
  return c == null ? 0 : Math.abs(c);
}

/** A typed magnitude carries the charge's own sign: "-18.40" parent, "10" part -> "-10.00". */
export function signedAmount(parentAmount: string, cents: number): string {
  return `${parentAmount.trim().startsWith("-") ? "-" : ""}${formatCents(cents)}`;
}

export interface SplitPart {
  categoryId: string;
  amount: string;
}

export interface SplitState {
  sumCents: number;
  /** Charge minus the parts so far. Positive: still to assign. Negative: over. */
  remainingCents: number;
  /** The parts add up to the charge exactly. */
  balanced: boolean;
  /** Balanced, at least two parts, every part positive and filed. Save may enable. */
  ready: boolean;
}

export function splitState(totalCents: number, parts: readonly SplitPart[]): SplitState {
  const cents = parts.map((p) => parseCents(p.amount));
  const sumCents = cents.reduce<number>((s, c) => s + (c ?? 0), 0);
  const remainingCents = totalCents - sumCents;
  const balanced = remainingCents === 0;
  const ready =
    balanced &&
    parts.length >= 2 &&
    parts.length <= 20 &&
    parts.every((p, i) => p.categoryId !== "" && (cents[i] ?? 0) > 0);
  return { sumCents, remainingCents, balanced, ready };
}

import { toCents, r2, type Detector, type Finding, type RecentRow } from "../types";

// duplicate_charge: two posted outflows with the same merchant signature and
// amounts within one cent, at most 72 h apart, different ids, neither undone
// by a refund (an inflow of the same signature and amount in the window).
// Consecutive rows only, so three identical rows read as two pairs. Guard: an
// amount under $5 is a coffee, not a double charge.

export const DUPLICATE_WINDOW_MS = 72 * 3600 * 1000;
export const DUPLICATE_AMOUNT_TOLERANCE_CENTS = 1;
export const DUPLICATE_MIN_DOLLARS = 5;

export const detectDuplicateCharge: Detector = (facts) => {
  const rows = facts.recentRows.filter((r) => r.signature !== "");
  const refunds = rows.filter((r) => r.amount > 0);
  const refunded = (sig: string, cents: number): boolean =>
    refunds.some((r) => r.signature === sig && Math.abs(toCents(r.amount) - cents) <= DUPLICATE_AMOUNT_TOLERANCE_CENTS);

  const bySig = new Map<string, RecentRow[]>();
  for (const r of rows) {
    if (r.amount >= 0 || -r.amount < DUPLICATE_MIN_DOLLARS) continue;
    const g = bySig.get(r.signature);
    if (g) g.push(r);
    else bySig.set(r.signature, [r]);
  }

  const out: Finding[] = [];
  for (const [sig, group] of bySig) {
    group.sort((a, b) => a.whenMs - b.whenMs || a.id.localeCompare(b.id));
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1]!;
      const b = group[i]!;
      if (a.id === b.id) continue;
      if (b.whenMs - a.whenMs > DUPLICATE_WINDOW_MS) continue;
      const ac = toCents(-a.amount);
      const bc = toCents(-b.amount);
      if (Math.abs(ac - bc) > DUPLICATE_AMOUNT_TOLERANCE_CENTS) continue;
      if (refunded(sig, ac) || refunded(sig, bc)) continue;
      const [first, second] = [a.id, b.id].sort();
      out.push({
        kind: "duplicate_charge",
        dedupeKey: `duplicate_charge:${first}.${second}:pair`,
        severity: "watch",
        confidence: "estimate",
        payload: {
          txnIds: [a.id, b.id],
          amount: r2(bc / 100),
          dates: [a.date, b.date],
          hoursApart: Math.round(((b.whenMs - a.whenMs) / 3600000) * 10) / 10,
        },
      });
    }
  }
  return out;
};

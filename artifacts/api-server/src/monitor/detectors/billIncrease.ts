import { toCents, r2, type Detector, type Finding } from "../types";

// bill_increase: an active bill whose latest paid amount is more than 10%
// above the median of the previous (at least 3) amounts AND more than $5 more.
// Integer-cents arithmetic, so the boundary is exact.

export const BILL_MIN_PREVIOUS = 3;
export const BILL_MAX_PREVIOUS = 6;
export const BILL_INCREASE_RATIO = 1.1;
export const BILL_INCREASE_MIN_DOLLARS = 5;

/** Median in cents (a half-cent when the count is even). */
export function medianCents(cents: number[]): number {
  const s = [...cents].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const detectBillIncrease: Detector = (facts) => {
  const out: Finding[] = [];
  for (const bill of facts.bills) {
    if (!bill.active || bill.debtLinked) continue;
    // Newest first; a confirmed match outranks a pair of the same day.
    const [latest, ...rest] = [...bill.payments].sort(
      (a, b) => b.date.localeCompare(a.date) || Number(a.source !== "matched") - Number(b.source !== "matched"),
    );
    if (!latest) continue;
    const previous = rest.slice(0, BILL_MAX_PREVIOUS);
    if (previous.length < BILL_MIN_PREVIOUS) continue;
    const latestC = toCents(latest.amount);
    const medianC = medianCents(previous.map((p) => toCents(p.amount)));
    // latest > 1.10 × median  <=>  latest × 10 > median × 11 (exact in cents).
    if (!(latestC * 10 > medianC * 11)) continue;
    if (!(latestC - medianC > BILL_INCREASE_MIN_DOLLARS * 100)) continue;
    out.push({
      kind: "bill_increase",
      dedupeKey: `bill_increase:${bill.itemId}:${latestC}`,
      severity: "watch",
      confidence: latest.source === "matched" ? "confirmed" : "estimate",
      payload: {
        itemId: bill.itemId,
        txnId: latest.txnId,
        paidOn: latest.date,
        latest: r2(latestC / 100),
        median: r2(medianC / 100),
        increase: r2((latestC - medianC) / 100),
        previousCount: previous.length,
      },
    });
  }
  return out;
};

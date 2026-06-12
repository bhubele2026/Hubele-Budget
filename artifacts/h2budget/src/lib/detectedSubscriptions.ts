import type { Transaction } from "@workspace/api-client-react";

// Find likely subscriptions by their spending fingerprint: the same merchant
// charging a near-constant amount on a regular cadence. Works off raw
// transactions, so it catches subscriptions the user never set up as a
// recurring item (which the Subscriptions card otherwise can't see).

export interface DetectedSub {
  merchant: string;
  cadence: string;
  /** Typical per-charge amount. */
  typical: number;
  annual: number;
  count: number;
  lastDate: string;
  confidence: "high" | "medium" | "low";
  amountVaries: boolean;
}

const DAY = 86_400_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyCadence(
  medianGapDays: number,
): { label: string; perYear: number } | null {
  if (medianGapDays >= 5 && medianGapDays <= 9) return { label: "weekly", perYear: 52 };
  if (medianGapDays >= 12 && medianGapDays <= 17) return { label: "biweekly", perYear: 26 };
  if (medianGapDays >= 26 && medianGapDays <= 35) return { label: "monthly", perYear: 12 };
  if (medianGapDays >= 58 && medianGapDays <= 64) return { label: "every 2 months", perYear: 6 };
  if (medianGapDays >= 85 && medianGapDays <= 95) return { label: "quarterly", perYear: 4 };
  if (medianGapDays >= 350 && medianGapDays <= 380) return { label: "yearly", perYear: 1 };
  return null;
}

export function detectSubscriptionsFromTransactions(
  txns: readonly Transaction[] | undefined,
): DetectedSub[] {
  const byMerchant = new Map<string, { dates: string[]; amounts: number[] }>();
  for (const t of txns ?? []) {
    const amt = Number(t.amount) || 0;
    if (amt >= 0 || t.isTransfer) continue; // expenses only, skip transfers
    const name = (t.displayName || t.description || "Unknown").trim();
    const g = byMerchant.get(name) ?? { dates: [], amounts: [] };
    g.dates.push(t.occurredOn.slice(0, 10));
    g.amounts.push(Math.abs(amt));
    byMerchant.set(name, g);
  }

  const hits: DetectedSub[] = [];
  for (const [merchant, g] of byMerchant) {
    if (g.dates.length < 2) continue;
    const dates = [...g.dates].sort();
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(
        (new Date(`${dates[i]}T00:00:00Z`).getTime() -
          new Date(`${dates[i - 1]}T00:00:00Z`).getTime()) /
          DAY,
      );
    }
    const cadence = classifyCadence(median(gaps));
    if (!cadence) continue;

    const typical = median(g.amounts);
    const lo = Math.min(...g.amounts);
    const hi = Math.max(...g.amounts);
    const spread = typical > 0 ? (hi - lo) / typical : 1;
    if (spread > 0.6) continue; // too variable to be a subscription
    const stable = spread <= 0.25;

    hits.push({
      merchant,
      cadence: cadence.label,
      typical: Math.round(typical * 100) / 100,
      annual: Math.round(typical * cadence.perYear * 100) / 100,
      count: g.dates.length,
      lastDate: dates[dates.length - 1],
      confidence:
        g.dates.length >= 3 && stable
          ? "high"
          : g.dates.length >= 3 || stable
            ? "medium"
            : "low",
      amountVaries: !stable,
    });
  }

  hits.sort((a, b) => b.annual - a.annual);
  return hits;
}

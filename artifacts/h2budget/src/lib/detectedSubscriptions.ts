import type { Transaction } from "@workspace/api-client-react";

// Find anything that KEEPS RECURRING by its spending fingerprint: the same
// merchant charging a near-constant amount on a regular cadence. Works off
// raw transactions, so it catches recurring charges the user never set up as
// a recurring item. Heavy on logic — merchant normalization (so "PlayStation
// Network", "PLAYSTATION NTWK*1234" and "Sony PlayStation" collapse into one),
// same-day dedupe, cadence classification with tolerance, regularity scoring,
// a predicted next-charge date, and a monthly-equivalent cost.

export interface DetectedSub {
  merchant: string;
  cadence: string;
  /** Typical per-charge amount. */
  typical: number;
  /** Monthly-equivalent cost (so weekly/quarterly/yearly are comparable). */
  monthly: number;
  annual: number;
  count: number;
  firstDate: string;
  lastDate: string;
  /** Predicted next charge date (ISO), or null if cadence is unknown. */
  nextDate: string | null;
  confidence: "high" | "medium" | "low";
  amountVaries: boolean;
  /** Whether the cadence is consistent (low gap variance). */
  regular: boolean;
}

const DAY = 86_400_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyCadence(
  medianGapDays: number,
): { label: string; perYear: number; days: number } | null {
  // Wider, gap-friendly windows — real billing dates drift a few days.
  if (medianGapDays >= 5 && medianGapDays <= 9)
    return { label: "weekly", perYear: 52, days: 7 };
  if (medianGapDays >= 12 && medianGapDays <= 18)
    return { label: "biweekly", perYear: 26, days: 14 };
  if (medianGapDays >= 25 && medianGapDays <= 38)
    return { label: "monthly", perYear: 12, days: 30 };
  if (medianGapDays >= 55 && medianGapDays <= 70)
    return { label: "every 2 months", perYear: 6, days: 61 };
  if (medianGapDays >= 80 && medianGapDays <= 100)
    return { label: "quarterly", perYear: 4, days: 91 };
  if (medianGapDays >= 160 && medianGapDays <= 200)
    return { label: "twice a year", perYear: 2, days: 182 };
  if (medianGapDays >= 330 && medianGapDays <= 400)
    return { label: "yearly", perYear: 1, days: 365 };
  return null;
}

// Recurring charges that are BILLS / DEBT / life expenses — NOT consumer
// subscriptions. A subscription is a service (streaming, meal kits, software,
// a gym, a membership). A mortgage, car payment, loan, insurance, utility,
// phone, tuition, gas, or groceries is a recurring bill — exclude them.
const NOT_A_SUBSCRIPTION =
  /loan|mortgage|heloc|lending|leasing|\blease\b|servicing|credit\s*union|payroll|insur|utilit|electric|\bwater\b|sewer|tuition|univ|college|\btax(es)?\b|\bhoa\b|escrow|\brent\b|car\s*payment|card\s*payment|verizon|at&t|t-?mobile|comcast|xfinity|spectrum|cricket|kwik\s*trip|casey|speedway|shell|exxon|mobil|chevron|marathon|\bbp\b|holiday\s*station|grocer|kroger|aldi|costco|hy-?vee|woodman|metro\s*market|festival\s*foods|pick\s*n\s*save|walmart|target|\bach\b|autopay|transfer|wells\s*fargo|capital\s*one|\bdiscover\b|synchrony|barclays|comenity|navient|nelnet|sofi|venmo|paypal|zelle|cash\s*app/i;

/**
 * Collapse a raw merchant string to a stable grouping key — strips trailing
 * store / reference numbers, `*TOKEN` fragments, common corporate suffixes and
 * punctuation, so trivially-different descriptions for the same service group
 * together (the root cause of the duplicate "PlayStation Network" rows).
 */
function normalizeMerchant(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/\*+\s*\w+/g, " "); // *XYZ ref tokens
  s = s.replace(/#?\s*\d[\d\-*]*\s*$/g, " "); // trailing store / ref numbers
  s = s.replace(/\b(inc|llc|ltd|co|corp|usa|com|net|org|the)\b\.?/g, " ");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function isoPlusDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`).getTime() + days * DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Add one month, clamping the day so e.g. Jan 31 → Feb 28. */
function isoPlusMonth(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(y, m, Math.min(d, lastDay)));
  return target.toISOString().slice(0, 10);
}

export function detectSubscriptionsFromTransactions(
  txns: readonly Transaction[] | undefined,
  categoryNameOf?: (id: string | null | undefined) => string | null,
): DetectedSub[] {
  const groups = new Map<
    string,
    { dates: string[]; amounts: number[]; names: Map<string, number> }
  >();
  for (const t of txns ?? []) {
    const amt = Number(t.amount) || 0;
    if (amt >= 0 || t.isTransfer) continue; // expenses only, skip transfers
    const rawName = (t.displayName || t.description || "Unknown").trim();
    const cat = categoryNameOf?.(t.categoryId) ?? "";
    if (NOT_A_SUBSCRIPTION.test(rawName) || NOT_A_SUBSCRIPTION.test(cat))
      continue;
    const key = normalizeMerchant(rawName);
    if (!key) continue;
    const g = groups.get(key) ?? {
      dates: [] as string[],
      amounts: [] as number[],
      names: new Map<string, number>(),
    };
    g.dates.push(t.occurredOn.slice(0, 10));
    g.amounts.push(Math.abs(amt));
    g.names.set(rawName, (g.names.get(rawName) ?? 0) + 1);
    groups.set(key, g);
  }

  const hits: DetectedSub[] = [];
  for (const [, g] of groups) {
    if (g.dates.length < 2) continue;
    const dates = [...g.dates].sort();

    // Gaps between consecutive charges, skipping same-day duplicates (a single
    // charge sometimes posts twice) so they don't poison the cadence.
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const gap =
        (new Date(`${dates[i]}T00:00:00Z`).getTime() -
          new Date(`${dates[i - 1]}T00:00:00Z`).getTime()) /
        DAY;
      if (gap >= 1) gaps.push(gap);
    }
    if (gaps.length === 0) continue;

    const medGap = median(gaps);
    const cadence = classifyCadence(medGap);
    if (!cadence) continue;

    // Regularity — how tightly the gaps cluster around the median.
    const gapDev = median(gaps.map((x) => Math.abs(x - medGap)));
    const regular = gapDev <= Math.max(3, medGap * 0.2);

    const typical = median(g.amounts);
    const lo = Math.min(...g.amounts);
    const hi = Math.max(...g.amounts);
    const spread = typical > 0 ? (hi - lo) / typical : 1;
    if (spread > 0.65) continue; // too variable to be recurring
    const stable = spread <= 0.2;

    // Display name = the most frequently-seen original spelling.
    const merchant =
      [...g.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unknown";

    const last = dates[dates.length - 1];
    const nextDate =
      cadence.label === "monthly"
        ? isoPlusMonth(last)
        : isoPlusDays(last, cadence.days);

    const n = g.dates.length;
    hits.push({
      merchant,
      cadence: cadence.label,
      typical: Math.round(typical * 100) / 100,
      monthly: Math.round(((typical * cadence.perYear) / 12) * 100) / 100,
      annual: Math.round(typical * cadence.perYear * 100) / 100,
      count: n,
      firstDate: dates[0],
      lastDate: last,
      nextDate,
      confidence:
        n >= 3 && stable && regular
          ? "high"
          : n >= 3 || (stable && regular)
            ? "medium"
            : "low",
      amountVaries: !stable,
      regular,
    });
  }

  hits.sort((a, b) => b.annual - a.annual);
  return hits;
}

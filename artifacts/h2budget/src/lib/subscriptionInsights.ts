import type { RecurringItem, Transaction } from "@workspace/api-client-react";

// Mirrors the server's isTrueSubscription (api-server/src/lib/behaviorFacts.ts)
// so this list matches the "Subscriptions running" card: real recurring
// SERVICES (streaming / software / memberships), never fixed bills like
// mortgage / HELOC / insurance / utilities or variable spend like groceries.
const SUBSCRIPTION_CATEGORY_PATTERN = /subscription|streaming/i;
const SUBSCRIPTION_MERCHANT_PATTERN =
  /netflix|spotify|hulu|disney\+?|hbo|\bmax\b|peacock|paramount|youtube|prime\s*video|amazon\s*prime|apple\s*(tv|music|arcade|one)|itunes|icloud|google\s*(one|storage|play)|dropbox|adobe|microsoft\s*365|office\s*365|audible|kindle\s*unlimited|patreon|substack|peloton|planet\s*fitness|\bgym\b|fitness|xbox|game\s*pass|playstation\s*(plus|now)|nintendo\s*(online|switch\s*online)|crunchyroll|sling|fubo|espn\+?|nytimes|new\s*york\s*times|\bwsj\b|wall\s*street\s*journal|the\s*athletic|canva|notion|chatgpt|openai|grammarly|1password|lastpass/i;

const SUBSCRIPTION_FREQUENCIES = new Set([
  "monthly",
  "weekly",
  "biweekly",
  "yearly",
  "annual",
]);

export function isTrueSubscription(
  name: string,
  categoryName: string | null,
): boolean {
  if (categoryName && SUBSCRIPTION_CATEGORY_PATTERN.test(categoryName)) {
    return true;
  }
  return SUBSCRIPTION_MERCHANT_PATTERN.test(name ?? "");
}

// Annualized cost of a single charge given its cadence.
export function annualize(amount: number, frequency: string): number {
  switch (frequency) {
    case "yearly":
    case "annual":
      return amount;
    case "weekly":
      return amount * 52;
    case "biweekly":
      return amount * 26;
    case "monthly":
    default:
      return amount * 12;
  }
}

const STOPWORDS = new Set(["the", "and", "a", "an", "of", "my", "our"]);

// A short, lowercased needle used to match a subscription to its bank
// charges and to group likely duplicates. First non-stopword token of the
// name, length >= 3 (so "The Athletic" → "athletic", "Disney Bundle" →
// "disney", "HBO Max" → "hbo").
export function matchKey(name: string): string {
  const tokens = (name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return tokens[0] ?? (name ?? "").toLowerCase().trim();
}

export interface SubInsight {
  id: string;
  name: string;
  frequency: string;
  /** Per-charge amount (the recurring item's set amount). */
  amount: number;
  monthly: number;
  annual: number;
  lastChargeDate: string | null;
  lastChargeAmount: number | null;
  /** Set when the latest real charge is meaningfully higher than recorded. */
  priceChange: { from: number; to: number } | null;
  /** A recurring service we don't see a recent charge for. */
  noRecentCharge: boolean;
  /** Other subscription ids that look like the same service. */
  duplicateIds: string[];
}

export interface SubscriptionInsights {
  items: SubInsight[];
  count: number;
  monthlyTotal: number;
  annualTotal: number;
  priceIncreases: SubInsight[];
  duplicateGroups: SubInsight[][];
  noRecentCharge: SubInsight[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(aISO: string, b: Date): number {
  const a = new Date(`${aISO.slice(0, 10)}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// Soft "no recent charge" windows by cadence (charge interval + grace).
function staleAfterDays(frequency: string): number | null {
  switch (frequency) {
    case "weekly":
      return 21;
    case "biweekly":
      return 35;
    case "monthly":
      return 60;
    // Yearly cadence can legitimately have its last charge outside the
    // available history window, so we don't flag those as stale.
    default:
      return null;
  }
}

/**
 * Build subscription insights from the household's recurring items and a
 * (ideally ~1 year) transaction history. Pure — pass `today` in.
 *
 * - annual / monthly cost per subscription and in total
 * - price increases (latest real charge vs the earliest/recorded amount)
 * - likely duplicates (same service set up twice)
 * - "no recent charge" (a monthly/weekly service with no matching charge)
 *
 * Charge matching is heuristic (name token + amount in a sane band), so the
 * cost/duplicate signals are exact while price/stale signals are best-effort.
 */
export function computeSubscriptionInsights(
  recurringItems: readonly RecurringItem[] | undefined,
  txns: readonly Transaction[] | undefined,
  categoryNameOf: (id: string | null | undefined) => string | null,
  today: Date,
): SubscriptionInsights {
  const subsRaw = (recurringItems ?? []).filter(
    (r) =>
      r.active === "true" &&
      r.kind !== "income" &&
      r.kind !== "debt" &&
      !r.debtId &&
      SUBSCRIPTION_FREQUENCIES.has(r.frequency) &&
      isTrueSubscription(r.name, categoryNameOf(r.categoryId)),
  );

  const allTxns = txns ?? [];

  const items: SubInsight[] = subsRaw.map((r) => {
    const amount = Math.abs(Number(r.amount) || 0);
    const annual = annualize(amount, r.frequency);
    const monthly = annual / 12;
    const key = matchKey(r.name);

    // Candidate charges: description/merchant contains the name token AND the
    // amount sits in a sane band around the expected charge (so a $200 Amazon
    // order doesn't get mistaken for a $15 Prime sub).
    const lo = amount > 0 ? amount * 0.4 : 0;
    const hi = amount > 0 ? amount * 2.5 : Infinity;
    const charges = allTxns
      .filter((t) => {
        const hay = `${t.displayName ?? ""} ${t.description ?? ""}`.toLowerCase();
        if (!key || !hay.includes(key)) return false;
        const a = Math.abs(Number(t.amount) || 0);
        return a >= lo && a <= hi;
      })
      .map((t) => ({ date: t.occurredOn.slice(0, 10), amount: Math.abs(Number(t.amount) || 0) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const last = charges.length ? charges[charges.length - 1] : null;
    const lastChargeDate = last?.date ?? null;
    const lastChargeAmount = last?.amount ?? null;

    // Price increase: prefer charge-history evidence (earliest vs latest
    // charge); fall back to "latest charge vs the recorded amount".
    let priceChange: { from: number; to: number } | null = null;
    if (last) {
      const earliest = charges[0];
      const baseline = charges.length >= 2 ? earliest.amount : amount;
      if (last.amount > baseline + 0.5 && last.amount > baseline * 1.02) {
        priceChange = {
          from: Math.round(baseline * 100) / 100,
          to: Math.round(last.amount * 100) / 100,
        };
      }
    }

    const staleDays = staleAfterDays(r.frequency);
    const noRecentCharge =
      staleDays !== null &&
      (lastChargeDate === null || daysBetween(lastChargeDate, today) > staleDays);

    return {
      id: r.id,
      name: r.name,
      frequency: r.frequency,
      amount: Math.round(amount * 100) / 100,
      monthly: Math.round(monthly * 100) / 100,
      annual: Math.round(annual * 100) / 100,
      lastChargeDate,
      lastChargeAmount:
        lastChargeAmount === null ? null : Math.round(lastChargeAmount * 100) / 100,
      priceChange,
      noRecentCharge,
      duplicateIds: [],
    };
  });

  // Duplicate detection: group by match key; any key with > 1 item is a
  // likely double-subscribe.
  const byKey = new Map<string, SubInsight[]>();
  for (const it of items) {
    const k = matchKey(it.name);
    const arr = byKey.get(k) ?? [];
    arr.push(it);
    byKey.set(k, arr);
  }
  const duplicateGroups: SubInsight[][] = [];
  for (const group of byKey.values()) {
    if (group.length > 1) {
      duplicateGroups.push(group);
      const ids = group.map((g) => g.id);
      for (const g of group) g.duplicateIds = ids.filter((id) => id !== g.id);
    }
  }

  items.sort((a, b) => b.annual - a.annual);

  const monthlyTotal = items.reduce((s, i) => s + i.monthly, 0);
  const annualTotal = items.reduce((s, i) => s + i.annual, 0);

  return {
    items,
    count: items.length,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
    annualTotal: Math.round(annualTotal * 100) / 100,
    priceIncreases: items.filter((i) => i.priceChange),
    duplicateGroups,
    noRecentCharge: items.filter((i) => i.noRecentCharge),
  };
}

// (#851 — Behavior & Fun overhaul, Phase 1) Structured Behavior-tab facts.
//
// Builds the clean, personality-driven fact set the Phase 2 Behavior & Fun
// UI will render, on top of the SAME real-spend definition the Spending
// overhaul shipped (isRealSpend / cleanMerchant / spendAmount /
// TRACKING_START). Transfers, debt/card payments, reimbursements, and
// ignore-category rows are excluded so the storytelling view never shows
// "Online Transfer to SAV…" as a biggest splurge or a 3am transfer spike.
//
// Server-side only in this phase — no UI is wired to this yet. The output
// is a set of "fun observations a friend would notice", not analytics.
//
// NOTE: The keyword buckets below are HEURISTICS. They lean on substring
// matches against the cleaned merchant name plus a few stronger
// category-name signals. They are intentionally not 100% accurate; we
// review the prod JSON first, then iterate the filters in a follow-up.

import { and, eq, gte, lte } from "drizzle-orm";
import {
  db,
  transactionsTable,
  budgetCategoriesTable,
  recurringItemsTable,
} from "@workspace/db";
import { cleanMerchant } from "./merchantNameExtract";
import {
  isRealSpend,
  matchesTransferPattern,
  isExcludedCategoryName,
  spendAmount,
  type SpendContext,
  type SpendTxn,
} from "./spendingFilter";
import { TRACKING_START } from "./spendingFacts";
import { expandItem } from "./cashSignal";

// Re-export so callers can reach the floor without importing two modules.
export { TRACKING_START } from "./spendingFacts";

const DOW_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// --- Keyword buckets -------------------------------------------------------
// Lowercase substrings matched against the CLEANED merchant name. Stronger
// per-bucket rules (category-name signals, amount ceilings) are applied in
// matchesBucket(). These are heuristics, not an exhaustive taxonomy.
type Bucket =
  | "dining"
  | "amazon"
  | "coffee"
  | "gasStation"
  | "groceries"
  | "onlineShopping";

const KEYWORD_BUCKETS: Record<Bucket, readonly string[]> = {
  dining: [
    "restaurant",
    "grill",
    "pizza",
    "diner",
    "kitchen",
    "tavern",
    "bistro",
    "cantina",
    "chipotle",
    "mcdonald",
    "taco",
    "burger",
    "sushi",
    "panera",
    "subway",
    "wendy",
    "chick-fil",
    "chick fil",
    "doordash",
    "grubhub",
    "uber eats",
    "ubereats",
    "five guys",
    "noodles",
    "bar &",
    "pub",
  ],
  amazon: ["amazon", "amzn"],
  coffee: [
    "coffee",
    "starbucks",
    "dunkin",
    "caribou",
    "peet",
    "espresso",
    "latte",
    "cafe",
    "café",
    "biggby",
  ],
  gasStation: [
    "shell",
    "exxon",
    "mobil",
    "chevron",
    "kwik trip",
    "kwik star",
    "speedway",
    "marathon",
    "citgo",
    "sunoco",
    "casey",
    "bp ",
    "phillips 66",
    "circle k",
    "holiday stationstore",
  ],
  groceries: [
    "grocery",
    "aldi",
    "kroger",
    "costco",
    "trader joe",
    "whole foods",
    "safeway",
    "publix",
    "meijer",
    "hy-vee",
    "hyvee",
    "metro market",
    "festival foods",
    "pick n save",
    "supermarket",
  ],
  onlineShopping: [
    "amazon",
    "amzn",
    "ebay",
    "etsy",
    "walmart.com",
    "target.com",
    "shopify",
    "wayfair",
    "best buy",
    "temu",
    "shein",
    "(via paypal)",
  ],
};

// Apply the stronger per-bucket signals on top of the keyword match.
function matchesBucket(
  bucket: Bucket,
  merchant: string,
  categoryName: string | null,
  amount: number,
): boolean {
  const m = merchant.toLowerCase();
  const c = (categoryName ?? "").toLowerCase();
  const kw = KEYWORD_BUCKETS[bucket].some((k) => m.includes(k));
  switch (bucket) {
    case "dining":
      // Merchant OR category name signals dining.
      return kw || c.includes("dining");
    case "groceries":
      return kw || categoryName === "Groceries";
    case "gasStation":
      return kw || c.includes("gas") || c.includes("fuel");
    case "coffee":
      // A coffee run is a small purchase — guard against a $60 bag of beans
      // or a coffee-table furniture buy slipping into the streak math.
      return kw && amount < 15;
    case "amazon":
    case "onlineShopping":
      return kw; // merchant-match only
  }
}

// Categories that are "expected" recurring spend, NOT impulse buys.
const NON_IMPULSE_CATEGORY_NAMES: ReadonlySet<string> = new Set([
  "Groceries",
  "Gas, Maintenance & Parking",
  "Subscriptions",
  "Utilities",
  "Insurance",
  "Mortgage (Lakeview)",
  "Car Payments",
]);

// --- Output shape ----------------------------------------------------------
export interface DaysSinceEntry {
  days: number;
  lastDate: string;
  lastMerchant: string;
  lastAmount: number;
}

export interface StreakEntry {
  currentDays: number;
  longestDays: number;
  longestEndDate: string;
}

export interface TxnRef {
  amount: number;
  date: string;
  merchant: string;
  categoryName: string | null;
}

export interface BehaviorFacts {
  range: {
    start: string;
    end: string;
    daysCovered: number;
    trackingStart: string;
    floorApplied: boolean;
  };
  daysSinceLast: Record<Bucket, DaysSinceEntry | null>;
  streaks: {
    noDining: StreakEntry;
    coffeeFree: StreakEntry;
  };
  funFacts: {
    biggestSplurge: TxnRef | null;
    mostVisitedMerchant: {
      name: string;
      count: number;
      total: number;
      sampleCategoryName: string | null;
    } | null;
    quietestDay: { date: string; total: number; dayOfWeek: string } | null;
    mostExpensiveDay: { date: string; total: number; dayOfWeek: string } | null;
    impulseBuyCount: {
      count: number;
      total: number;
      exampleMerchants: string[];
    };
    subscriptionsCount: {
      count: number;
      monthlyTotal: number;
      topThree: { name: string; amount: number; frequency: string }[];
    };
    nextPaycheckCountdown: {
      days: number;
      paycheckLabel: string;
      expectedAmount: number;
      expectedDate: string;
    } | null;
  };
  hourlySpendingClock: { hour: number; total: number; count: number }[];
  dayOfWeekSpend: {
    dow: number;
    label: string;
    total: number;
    count: number;
    avgPerDay: number;
  }[];
  hallOfFame: {
    biggestExpense: TxnRef | null;
    biggestIncome: TxnRef | null;
  };
}

// --- Helpers ---------------------------------------------------------------
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) /
      86_400_000,
  );
}

function enumerateDates(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const span = daysBetween(fromIso, toIso);
  for (let i = 0; i <= span; i += 1) {
    const d = new Date(`${fromIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(isoDate(d));
  }
  return out;
}

// Compute a "no-X streak" from the set of days that DID have a matching txn.
// `currentDays` is the run ending today; `longestDays`/`longestEndDate` is the
// max run observed across [fromIso, todayIso]. The window is always the
// tracking window (trackingStart..today), independent of the requested range.
//
// Edge case (zero matching txns in the whole window): the general algorithm
// below naturally yields currentDays = longestDays = window length and
// longestEndDate = today, which is exactly the spec's intent (the spec calls
// this `daysCovered` assuming the default full-range request, where the
// tracking window and the requested range coincide).
function computeStreak(
  hitDays: Set<string>,
  fromIso: string,
  todayIso: string,
): StreakEntry {
  const days = enumerateDates(fromIso, todayIso);
  let longest = 0;
  let longestEnd = todayIso;
  let run = 0;
  for (const day of days) {
    if (hitDays.has(day)) {
      run = 0;
    } else {
      run += 1;
      if (run > longest) {
        longest = run;
        longestEnd = day;
      }
    }
  }

  // Trailing run ending today.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (hitDays.has(days[i])) break;
    current += 1;
  }

  return { currentDays: current, longestDays: longest, longestEndDate: longestEnd };
}

type BehaviorTxnRow = {
  occurredOn: string;
  occurredAt: string | null;
  description: string;
  amount: string;
  categoryId: string | null;
  isTransfer: boolean;
  isExternalCardPayment: boolean;
  source: string;
};

// Normalize the yearly/weekly/biweekly cadence into an equivalent monthly cost.
function monthlyNormalize(amount: number, frequency: string): number {
  switch (frequency) {
    case "yearly":
    case "annual":
      return amount / 12;
    case "weekly":
      return amount * 4.33;
    case "biweekly":
      return amount * 2.17;
    case "monthly":
    default:
      return amount;
  }
}

const SUBSCRIPTION_FREQUENCIES: ReadonlySet<string> = new Set([
  "monthly",
  "weekly",
  "biweekly",
  "yearly",
  "annual",
]);

// (#879 — Biggest Splurge: discretionary only) A "splurge" should reflect
// discretionary spend (shopping/dining/home-improvement/clothing/entertainment),
// never a fixed obligation like mortgage, HELOC, a loan, rent, insurance,
// utilities, taxes, or any debt/card payment. This pattern is matched against
// a category name, a category group name, or the raw transaction description.
export const FIXED_OBLIGATION_PATTERN =
  /mortgage|heloc|home\s*equity|\bloan\b|\brent\b|insurance|\btax(es)?\b|utilit|\bdebt\b|card\s*payment/i;

export interface SplurgeCategoryInfo {
  name: string;
  groupName: string;
  kind: string;
  sourceKind: string;
  excludeFromBudget: boolean;
}

// True when a category is a fixed obligation and therefore can never be the
// "biggest splurge". This is a splurge-only exclusion — it does NOT change the
// shared isRealSpend / spendAmount predicate that feeds other surfaces.
export function isNonDiscretionaryCategory(c: SplurgeCategoryInfo): boolean {
  if (c.sourceKind === "auto_bills" || c.sourceKind === "auto_debts") return true;
  if (c.kind === "income") return true;
  if (c.excludeFromBudget) return true;
  if (FIXED_OBLIGATION_PATTERN.test(c.name)) return true;
  if (FIXED_OBLIGATION_PATTERN.test(c.groupName)) return true;
  return false;
}

export async function buildBehaviorFacts(
  householdId: string,
  rangeStart?: string,
  rangeEnd?: string,
): Promise<BehaviorFacts> {
  const today = new Date();
  const todayIso = isoDate(today);
  const defaultEnd = todayIso;
  const back30 = new Date(today);
  back30.setUTCDate(back30.getUTCDate() - 30);
  const defaultStart = isoDate(back30);

  let start = rangeStart || defaultStart;
  const end = rangeEnd || defaultEnd;
  let floorApplied = false;
  if (start < TRACKING_START) {
    start = TRACKING_START;
    floorApplied = true;
  }

  const spanDays = daysBetween(start, end) + 1;
  const daysCovered = Number.isFinite(spanDays) ? Math.max(1, spanDays) : 1;

  // --- Context: categories + debt linkage --------------------------------
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      groupName: budgetCategoriesTable.groupName,
      debtId: budgetCategoriesTable.debtId,
      kind: budgetCategoriesTable.kind,
      sourceKind: budgetCategoriesTable.sourceKind,
      excludeFromBudget: budgetCategoriesTable.excludeFromBudget,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));

  const categoriesById = new Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >();
  const debtCategoryIds = new Set<string>();
  // (#879) Categories that can never win "biggest splurge" — fixed obligations.
  const splurgeExcludedCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId, kind: c.kind });
    if (c.debtId) debtCategoryIds.add(c.id);
    if (
      isNonDiscretionaryCategory({
        name: c.name,
        groupName: c.groupName,
        kind: c.kind,
        sourceKind: c.sourceKind,
        excludeFromBudget: c.excludeFromBudget,
      })
    ) {
      splurgeExcludedCategoryIds.add(c.id);
    }
  }
  const ctx: SpendContext = { categoriesById, debtCategoryIds };

  const catName = (id: string | null): string | null =>
    id ? categoriesById.get(id)?.name ?? null : null;

  // --- Range transactions (for range-bound facts) ------------------------
  const rangeTxns = (await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      occurredAt: transactionsTable.occurredAt,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      source: transactionsTable.source,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, start),
        lte(transactionsTable.occurredOn, end),
      ),
    )) as BehaviorTxnRow[];

  // --- Streak transactions (always trackingStart..today) -----------------
  // Streaks are anchored to the tracking start and "today", independent of
  // the requested window, so a narrow range can't fake a long streak.
  const streakTxns = (await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      occurredAt: transactionsTable.occurredAt,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      source: transactionsTable.source,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, TRACKING_START),
        lte(transactionsTable.occurredOn, todayIso),
      ),
    )) as BehaviorTxnRow[];

  // --- daysSinceLast ------------------------------------------------------
  const BUCKETS: Bucket[] = [
    "dining",
    "amazon",
    "coffee",
    "gasStation",
    "groceries",
    "onlineShopping",
  ];

  const daysSinceLast = {} as Record<Bucket, DaysSinceEntry | null>;
  for (const bucket of BUCKETS) daysSinceLast[bucket] = null;

  // --- Accumulators for fun facts / charts -------------------------------
  let biggestSplurge: TxnRef | null = null;
  let biggestIncome: TxnRef | null = null;

  const merchantCounts = new Map<
    string,
    { count: number; total: number; catCounts: Map<string, number> }
  >();
  const daily = new Map<string, number>();
  const dowTotals = new Array(7).fill(0) as number[];
  const dowCounts = new Array(7).fill(0) as number[];
  const hourBuckets = Array.from({ length: 24 }, () => ({ total: 0, count: 0 }));

  let impulseCount = 0;
  let impulseTotal = 0;
  const impulseMerchants: string[] = [];

  // Track the latest matching real-spend txn per bucket for daysSinceLast.
  const latestPerBucket = {} as Record<
    Bucket,
    { date: string; merchant: string; amount: number } | null
  >;
  for (const bucket of BUCKETS) latestPerBucket[bucket] = null;

  for (const t of rangeTxns) {
    const tx: SpendTxn = {
      amount: t.amount,
      source: t.source,
      isTransfer: t.isTransfer,
      categoryId: t.categoryId,
      description: t.description,
    };
    const merchant = cleanMerchant(t.description) || "Unknown";
    const cName = catName(t.categoryId);

    // Hall of Fame: biggest income. Income-kind category, not a transfer,
    // and not a bank-noise transfer string ("Online Transfer FROM SAV…").
    const cat = t.categoryId ? categoriesById.get(t.categoryId) : undefined;
    if (
      cat?.kind === "income" &&
      t.isTransfer === false &&
      !matchesTransferPattern(t.description) &&
      !isExcludedCategoryName(cat.name)
    ) {
      const mag = Math.abs(parseFloat(t.amount) || 0);
      if (mag > 0 && (!biggestIncome || mag > biggestIncome.amount)) {
        biggestIncome = {
          amount: round2(mag),
          date: t.occurredOn,
          merchant,
          categoryName: cName,
        };
      }
    }

    if (!isRealSpend(tx, ctx)) continue;
    const spend = spendAmount(tx);

    // daysSinceLast — keep the most recent matching txn per bucket.
    for (const bucket of BUCKETS) {
      if (matchesBucket(bucket, merchant, cName, spend)) {
        const cur = latestPerBucket[bucket];
        if (!cur || t.occurredOn > cur.date) {
          latestPerBucket[bucket] = {
            date: t.occurredOn,
            merchant,
            amount: round2(spend),
          };
        }
      }
    }

    // Biggest splurge — discretionary spend only (#879). Skip fixed-obligation
    // categories (mortgage/HELOC/loan/rent/insurance/utilities/taxes/debt/card
    // payment, bills/debts auto categories, excluded-from-budget), and skip any
    // row whose raw description matches the fixed-obligation pattern (a
    // description backstop for card payments / mortgage rows that slip a
    // discretionary-looking category), plus an explicit guard on the
    // isExternalCardPayment flag so a flagged card payment can never win
    // regardless of its category or description. Transfers and debt/card-payment
    // noise are already removed by isRealSpend above.
    const splurgeExcluded =
      t.isExternalCardPayment === true ||
      (t.categoryId !== null && splurgeExcludedCategoryIds.has(t.categoryId)) ||
      FIXED_OBLIGATION_PATTERN.test(t.description);
    if (!splurgeExcluded && (!biggestSplurge || spend > biggestSplurge.amount)) {
      biggestSplurge = {
        amount: round2(spend),
        date: t.occurredOn,
        merchant,
        categoryName: cName,
      };
    }

    // Most-visited merchant.
    const mc = merchantCounts.get(merchant) ?? {
      count: 0,
      total: 0,
      catCounts: new Map<string, number>(),
    };
    mc.count += 1;
    mc.total += spend;
    if (t.categoryId) {
      mc.catCounts.set(t.categoryId, (mc.catCounts.get(t.categoryId) ?? 0) + 1);
    }
    merchantCounts.set(merchant, mc);

    // Daily + day-of-week buckets.
    daily.set(t.occurredOn, (daily.get(t.occurredOn) ?? 0) + spend);
    const dow = new Date(`${t.occurredOn}T00:00:00Z`).getUTCDay();
    dowTotals[dow] += spend;
    dowCounts[dow] += 1;

    // Hourly clock. `occurredAt` is a timezone-aware timestamp; when a row
    // lacks it (manual / older imports), fall back to noon so it lands in a
    // neutral bucket rather than skewing the early-morning hours.
    let hour = 12;
    if (t.occurredAt) {
      const parsed = new Date(t.occurredAt);
      if (!Number.isNaN(parsed.getTime())) hour = parsed.getUTCHours();
    }
    hourBuckets[hour].total += spend;
    hourBuckets[hour].count += 1;

    // Impulse buys: small purchases outside the "expected recurring" set.
    if (spend < 20 && !(cName && NON_IMPULSE_CATEGORY_NAMES.has(cName))) {
      impulseCount += 1;
      impulseTotal += spend;
      if (impulseMerchants.length < 3 && !impulseMerchants.includes(merchant)) {
        impulseMerchants.push(merchant);
      }
    }
  }

  for (const bucket of BUCKETS) {
    const latest = latestPerBucket[bucket];
    daysSinceLast[bucket] = latest
      ? {
          days: daysBetween(latest.date, todayIso),
          lastDate: latest.date,
          lastMerchant: latest.merchant,
          lastAmount: latest.amount,
        }
      : null;
  }

  // --- Streaks (trackingStart..today) ------------------------------------
  const diningDays = new Set<string>();
  const coffeeDays = new Set<string>();
  for (const t of streakTxns) {
    const tx: SpendTxn = {
      amount: t.amount,
      source: t.source,
      isTransfer: t.isTransfer,
      categoryId: t.categoryId,
      description: t.description,
    };
    if (!isRealSpend(tx, ctx)) continue;
    const merchant = cleanMerchant(t.description) || "Unknown";
    const cName = catName(t.categoryId);
    const spend = spendAmount(tx);
    if (matchesBucket("dining", merchant, cName, spend)) diningDays.add(t.occurredOn);
    if (matchesBucket("coffee", merchant, cName, spend)) coffeeDays.add(t.occurredOn);
  }

  const streaks = {
    noDining: computeStreak(diningDays, TRACKING_START, todayIso),
    coffeeFree: computeStreak(coffeeDays, TRACKING_START, todayIso),
  };

  // --- Most-visited merchant ---------------------------------------------
  let mostVisitedMerchant: BehaviorFacts["funFacts"]["mostVisitedMerchant"] =
    null;
  for (const [name, v] of merchantCounts) {
    if (
      !mostVisitedMerchant ||
      v.count > mostVisitedMerchant.count ||
      (v.count === mostVisitedMerchant.count && v.total > mostVisitedMerchant.total)
    ) {
      let sampleCategoryId: string | null = null;
      let best = -1;
      for (const [cid, count] of v.catCounts) {
        if (count > best) {
          best = count;
          sampleCategoryId = cid;
        }
      }
      mostVisitedMerchant = {
        name,
        count: v.count,
        total: round2(v.total),
        sampleCategoryName: catName(sampleCategoryId),
      };
    }
  }

  // --- Quietest / most-expensive day -------------------------------------
  let quietestDay: BehaviorFacts["funFacts"]["quietestDay"] = null;
  let mostExpensiveDay: BehaviorFacts["funFacts"]["mostExpensiveDay"] = null;
  for (const [date, total] of daily) {
    if (total <= 0) continue;
    const dayOfWeek = DOW_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()];
    if (!quietestDay || total < quietestDay.total) {
      quietestDay = { date, total: round2(total), dayOfWeek };
    }
    if (!mostExpensiveDay || total > mostExpensiveDay.total) {
      mostExpensiveDay = { date, total: round2(total), dayOfWeek };
    }
  }

  // --- Charts -------------------------------------------------------------
  const hourlySpendingClock = hourBuckets.map((b, hour) => ({
    hour,
    total: round2(b.total),
    count: b.count,
  }));

  // Count how many of each weekday fall inside [start, end] for avgPerDay.
  const dowOccurrences = new Array(7).fill(0) as number[];
  for (const day of enumerateDates(start, end)) {
    dowOccurrences[new Date(`${day}T00:00:00Z`).getUTCDay()] += 1;
  }
  const dayOfWeekSpend = DOW_LABELS.map((label, dow) => ({
    dow,
    label,
    total: round2(dowTotals[dow]),
    count: dowCounts[dow],
    avgPerDay:
      dowOccurrences[dow] > 0 ? round2(dowTotals[dow] / dowOccurrences[dow]) : 0,
  }));

  // --- Subscriptions ------------------------------------------------------
  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));

  const subs = recurring.filter(
    (r) =>
      r.active === "true" &&
      r.kind !== "income" &&
      r.kind !== "debt" &&
      !r.debtId &&
      SUBSCRIPTION_FREQUENCIES.has(r.frequency),
  );
  let monthlyTotal = 0;
  const subRows = subs.map((r) => {
    const amount = Math.abs(Number(r.amount) || 0);
    const normalized = monthlyNormalize(amount, r.frequency);
    monthlyTotal += normalized;
    return { name: r.name, amount: round2(amount), frequency: r.frequency, normalized };
  });
  const topThree = [...subRows]
    .sort((a, b) => b.normalized - a.normalized)
    .slice(0, 3)
    .map(({ name, amount, frequency }) => ({ name, amount, frequency }));

  // --- Next paycheck countdown -------------------------------------------
  const incomeItems = recurring.filter(
    (r) => r.kind === "income" && r.active === "true",
  );
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 60);
  let nextPaycheck: BehaviorFacts["funFacts"]["nextPaycheckCountdown"] = null;
  for (const item of incomeItems) {
    const events = expandItem(item, today, horizon);
    for (const ev of events) {
      if (ev.date <= todayIso) continue; // strictly after today
      const days = daysBetween(todayIso, ev.date);
      if (!nextPaycheck || ev.date < nextPaycheck.expectedDate) {
        nextPaycheck = {
          days,
          paycheckLabel: ev.label,
          expectedAmount: round2(Math.abs(ev.amount)),
          expectedDate: ev.date,
        };
      }
    }
  }

  return {
    range: {
      start,
      end,
      daysCovered,
      trackingStart: TRACKING_START,
      floorApplied,
    },
    daysSinceLast,
    streaks,
    funFacts: {
      biggestSplurge,
      mostVisitedMerchant,
      quietestDay,
      mostExpensiveDay,
      impulseBuyCount: {
        count: impulseCount,
        total: round2(impulseTotal),
        exampleMerchants: impulseMerchants,
      },
      subscriptionsCount: {
        count: subs.length,
        monthlyTotal: round2(monthlyTotal),
        topThree,
      },
      nextPaycheckCountdown: nextPaycheck,
    },
    hourlySpendingClock,
    dayOfWeekSpend,
    hallOfFame: {
      // biggestExpense is an alias of biggestSplurge.
      biggestExpense: biggestSplurge,
      biggestIncome,
    },
  };
}

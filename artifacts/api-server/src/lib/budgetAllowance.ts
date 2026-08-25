// The allowance rollup for the Budget page.
//
// ⚠️ THE ALLOWANCE IS TRACKED, NOT PLANNED. Its money is already in the plan
// as the recurring items that fund it (`Weekly Spend`, `Monthly Spend`), so
// these figures are NEVER added to `planBySource.plannedTotal`. Counting the
// caps a second time is exactly the bug Brad found: "there is a 1800 weekly,
// but also weekly in dining and groceries".
//
// It moved server-side because the page used to derive it in the browser from
// a 200-row `/transactions` pull. `/transactions` orders `desc(occurred_on)`
// and cuts at the limit, so in a month with more than 200 rows the OLDEST rows
// were silently dropped and the card under-reported the spend without saying
// so (CLAUDE.md §2 — a capped pull discloses its cap).

/** A transaction's bucket by EXPLICIT SELECTION ONLY — mirrors the client's
 *  `effectiveBucket` (`h2budget/src/lib/weeklyBuckets.ts`) including its
 *  precedence. An unmarked expense is `null` and counts in NONE of the three;
 *  there is no auto-default. */
export const ALLOWANCE_BUCKETS = ["weekly", "monthly", "unplanned"] as const;
export type AllowanceBucketName = (typeof ALLOWANCE_BUCKETS)[number];

/** The weekly envelope's own breakdown — a partition of the weekly allowance,
 *  never spend on top of it. Mirrors `SUB_BUCKETS` on the client. */
export const WEEKLY_SUB_BUCKETS = [
  "groceries",
  "dining",
  "alcohol",
  "entertainment",
  "misc",
] as const;
export type WeeklySubBucketName = (typeof WEEKLY_SUB_BUCKETS)[number];

export interface AllowanceSubBucket {
  bucket: string;
  actual: string;
  count: number;
}

export interface AllowanceLine {
  bucket: AllowanceBucketName;
  /** The cap for the whole month. See `monthlyCapFor` for the basis. */
  planned: string;
  actual: string;
  count: number;
  /** Weekly only — the five sub-buckets. Empty for monthly/unplanned. */
  subBuckets: AllowanceSubBucket[];
}

export interface AllowanceRollup {
  lines: AllowanceLine[];
  planned: string;
  actual: string;
  /** Whole weeks-worth used to scale the weekly cap to the month. */
  weeksInMonth: string;
}

/** One aggregated row as the route's grouped query returns it. */
export interface AllowanceAggregateRow {
  bucket: string | null;
  subBucket: string | null;
  spend: string;
  cnt: string;
}

const money = (n: number): string => n.toFixed(2);
const numberOf = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * The weekly cap is stored per WEEK and the page shows a MONTH, so it is
 * scaled by how many weeks the month holds. `daysInMonth / 7` — the same basis
 * the page used before this moved server-side, kept identical on purpose so
 * the figure does not shift under him while the layout changes around it.
 *
 * ⚠️ Per-week overrides (`settings.preferences.weeklyAllowanceOverrides`) are
 * NOT applied here, matching the previous behaviour. Only the Allowances page
 * and the command centre honour them.
 */
export function monthlyCapFor(
  bucket: AllowanceBucketName,
  weeklyCap: number,
  monthlyCap: number,
  unplannedCap: number,
  daysInMonth: number,
): number {
  if (bucket === "weekly") return weeklyCap * (daysInMonth / 7);
  if (bucket === "monthly") return monthlyCap;
  return unplannedCap;
}

/**
 * Shape the grouped aggregate into the response. Pure — the route does the
 * SQL, this does the arrangement, and the tests exercise this half directly.
 */
export function buildAllowanceRollup(
  rows: readonly AllowanceAggregateRow[],
  caps: {
    weekly: string | number | null | undefined;
    monthly: string | number | null | undefined;
    unplanned: string | number | null | undefined;
  },
  daysInMonth: number,
): AllowanceRollup {
  const weeklyCap = numberOf(caps.weekly);
  const monthlyCap = numberOf(caps.monthly);
  const unplannedCap = numberOf(caps.unplanned);

  const totals = new Map<string, { spend: number; count: number }>();
  const subs = new Map<string, { spend: number; count: number }>();

  for (const r of rows) {
    if (!r.bucket) continue;
    const spend = numberOf(r.spend);
    const count = parseInt(r.cnt, 10) || 0;
    const t = totals.get(r.bucket) ?? { spend: 0, count: 0 };
    t.spend += spend;
    t.count += count;
    totals.set(r.bucket, t);
    if (r.bucket === "weekly") {
      // An unfiled weekly charge still belongs to the weekly envelope; it just
      // has no sub-bucket yet. It lands under "misc" so the five slices always
      // sum to the weekly total — a breakdown that does not add up to the
      // figure above it is worse than no breakdown.
      const key: string =
        r.subBucket && (WEEKLY_SUB_BUCKETS as readonly string[]).includes(r.subBucket)
          ? r.subBucket
          : "misc";
      const s = subs.get(key) ?? { spend: 0, count: 0 };
      s.spend += spend;
      s.count += count;
      subs.set(key, s);
    }
  }

  const lines: AllowanceLine[] = ALLOWANCE_BUCKETS.map((bucket) => {
    const t = totals.get(bucket) ?? { spend: 0, count: 0 };
    return {
      bucket,
      planned: money(
        monthlyCapFor(bucket, weeklyCap, monthlyCap, unplannedCap, daysInMonth),
      ),
      actual: money(t.spend),
      count: t.count,
      subBuckets:
        bucket === "weekly"
          ? WEEKLY_SUB_BUCKETS.map((sb) => {
              const s = subs.get(sb) ?? { spend: 0, count: 0 };
              return { bucket: sb, actual: money(s.spend), count: s.count };
            })
          : [],
    };
  });

  return {
    lines,
    planned: money(lines.reduce((a, l) => a + numberOf(l.planned), 0)),
    actual: money(lines.reduce((a, l) => a + numberOf(l.actual), 0)),
    weeksInMonth: (daysInMonth / 7).toFixed(2),
  };
}

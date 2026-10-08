import type { MoneyPosition } from "@workspace/avalanche-core";

// (AI-3) The proactive monitor's vocabulary. Every detector is a pure function
// of `MonitorFacts` and returns `Finding[]`; nothing here calls a model, a
// database or the clock. A finding carries REFS (ids) and FIGURES (numbers) —
// never a merchant string — so it is safe to log, to store and to hand to a
// model later.

export type FindingKind =
  | "bill_increase"
  | "category_acceleration"
  | "shortfall_before_income"
  | "duplicate_charge"
  | "goal_behind"
  | "limit_near"
  | "bank_stale";

export type FindingSeverity = "info" | "watch" | "high";
export type FindingConfidence = "estimate" | "confirmed";

export const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, watch: 1, high: 2 };

export interface Finding {
  kind: FindingKind;
  /** `kind:targetRef:periodBucket` — unique per household. */
  dedupeKey: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  /** Ids and numbers only. */
  payload: Record<string, unknown>;
}

/** One paid occurrence of a bill: a confirmed match (`matched`) or a tier-2 pair (`paired`). */
export interface BillPayment {
  date: string;
  /** Positive dollars. */
  amount: number;
  source: "matched" | "paired";
  txnId: string;
}

export interface BillFacts {
  itemId: string;
  active: boolean;
  /** Pays down a debt: a minimum that moves with the balance is not a "bill increase". */
  debtLinked: boolean;
  /** Newest first, at most 7. */
  payments: BillPayment[];
}

export interface CategoryFacts {
  categoryId: string;
  /** Month-to-date spend, dollars. */
  spentMtd: number;
  /** This month's budget line, dollars (0 = no line). */
  planned: number;
  /** Average of the trailing months' spend, dollars; null with no history. */
  trailingMonthlyAvg: number | null;
  /** A bill's category: paid in lumps on schedule, watched by bill_increase instead. */
  isBillCategory: boolean;
}

export interface RecentRow {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Epoch ms of the posting instant when known, else noon UTC of `date`. */
  whenMs: number;
  /** Signed dollars: outflows negative. */
  amount: number;
  /** `merchantSignature(description)` — compared, never stored or logged. */
  signature: string;
}

/** (PR-C) A goal as the goal_behind detector reads it: the row's figures and its current amount. */
export interface GoalFacts {
  goalId: string;
  kind: string;
  status: string;
  targetAmount: number | string | null;
  manualCurrentAmount: number | string;
  plaidAccountId: string | null;
  monthlyContribution: number | string;
  targetDate: string | null;
  reservedInChecking: boolean;
  /** Dollars: the backing account's balance or the typed amount; null when unknown. */
  current: number | string | null;
}

export interface MonitorFacts {
  householdId: string;
  todayISO: string;
  nowMs: number;
  position: MoneyPosition;
  freshness: {
    stale: boolean;
    staleReason: string | null;
    /** Hours since the bank last told us anything; null when unknown. */
    quietHours: number | null;
  };
  month: { start: string; end: string; daysInMonth: number; dayOfMonth: number; daysLeft: number };
  weekStart: string;
  categories: CategoryFacts[];
  bills: BillFacts[];
  /** Posted rows of the last 72 h (plus a day of slack), both directions, transfers excluded. */
  recentRows: RecentRow[];
  /** (PR-C) The household's non-archived goals; absent reads as none. */
  goals?: GoalFacts[];
}

export type Detector = (facts: MonitorFacts) => Finding[];

/** Round to cents. */
export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const toCents = (n: number): number => Math.round(n * 100);

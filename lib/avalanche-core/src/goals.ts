// ⭐ (PR-C) GOALS AND RESERVES — pure maths over the household's goal rows.
// No clock, no I/O, no model. Every sum is in whole cents.
//
//   reserve          a goal holds money back from "available" only while it is
//                    ACTIVE, `reservedInChecking`, and NOT backed by an account:
//                        reserve = max(0, manualCurrentAmount)
//                    A goal backed by a savings account never enters it — that
//                    money is not in checking. A negative amount never RAISES
//                    available ("the forecast may read low, never high").
//   goalsMonthly     Σ max(0, monthlyContribution) of ACTIVE goals: the
//                    weekly-limit derivation's "Goals" line.
//   current          the linked account's balance when an account backs the
//                    goal (null when that balance is unknown — never a false
//                    0), else the amount the household typed.
//   percent          ⌊current ÷ target × 100⌋, 0–100: rounded DOWN.
//   monthsToTarget   a RANGE at the contribution rate, never a date promise:
//                    n = ⌈remaining ÷ contribution⌉ contributions are needed;
//                    the next may land this month or next, so low = n − 1 and
//                    high = n. Null when the contribution is 0.
//   behind           an active goal with a target and a target date whose
//                    required pace beats the contribution by more than 20%:
//                        months left = days left × 12 ÷ 365
//                        required    = remaining ÷ months left
//                        behind  ⇔   required > contribution × 1.2
//                    compared in integers: remaining × 365 × 10 >
//                    contribution × 12 × 12 × days left. A target date today
//                    or past with money still to go is behind. Null when it
//                    cannot be judged (no target, no date, unknown current,
//                    not active) — absence is not evidence.

export const GOAL_KINDS = ["savings", "buffer", "sinking", "debt_payoff"] as const;
export const GOAL_STATUSES = ["active", "paused", "reached", "archived"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** behind ⇔ required pace > contribution × GOAL_BEHIND_NUM ÷ GOAL_BEHIND_DEN. */
export const GOAL_BEHIND_NUM = 12;
export const GOAL_BEHIND_DEN = 10;
/** months = days × 12 ÷ GOAL_DAYS_PER_YEAR. */
export const GOAL_DAYS_PER_YEAR = 365;

/** A goal row as the maths reads it (money as dollars, strings or numbers). */
export interface GoalMathRow {
  status: string;
  targetAmount: number | string | null;
  manualCurrentAmount: number | string;
  plaidAccountId: string | null;
  monthlyContribution: number | string;
  targetDate: string | null;
  reservedInChecking: boolean;
}

const cents = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const centsOrNull = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

function dayNumber(iso: string): number {
  return Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
}

/** What this goal holds back from available, in cents. */
export function goalReserveCents(g: GoalMathRow): number {
  if (g.status !== "active" || !g.reservedInChecking || g.plaidAccountId) return 0;
  return Math.max(0, cents(g.manualCurrentAmount));
}

/** The money position's `reservesHeld`, in cents. */
export function reservesHeldCents(goals: readonly GoalMathRow[]): number {
  let c = 0;
  for (const g of goals) c += goalReserveCents(g);
  return c;
}

/** The weekly-limit derivation's `goalsMonthly`, in cents. */
export function goalsMonthlyCents(goals: readonly GoalMathRow[]): number {
  let c = 0;
  for (const g of goals) {
    if (g.status !== "active") continue;
    c += Math.max(0, cents(g.monthlyContribution));
  }
  return c;
}

/** The goal's current amount in cents: the linked account's balance (null when unknown) or the typed amount. */
export function goalCurrentCents(g: GoalMathRow, accountBalance: number | string | null | undefined): number | null {
  if (g.plaidAccountId) return centsOrNull(accountBalance);
  return cents(g.manualCurrentAmount);
}

export interface GoalProgress {
  currentCents: number | null;
  /** max(0, target − current); null with no target or an unknown current. */
  remainingCents: number | null;
  /** Whole percent of the target, rounded down, 0–100; null when it cannot be read. */
  percent: number | null;
  /** The range of months to the target at the contribution rate; null when it cannot be reached at that rate. */
  monthsToTarget: { low: number; high: number } | null;
  /** Days from today to the target date (negative when past); null with no date. */
  daysLeft: number | null;
  /** remaining ÷ months left, rounded UP to the cent; the whole remaining when the date has come. */
  requiredMonthlyCents: number | null;
  behind: boolean | null;
}

export function goalProgress(g: GoalMathRow, currentCents: number | null, todayISO: string): GoalProgress {
  const target = centsOrNull(g.targetAmount);
  const contribution = Math.max(0, cents(g.monthlyContribution));
  const remaining = target === null || currentCents === null ? null : Math.max(0, target - currentCents);
  const percent =
    target === null || target <= 0 || currentCents === null
      ? null
      : Math.min(100, Math.max(0, Math.floor((currentCents * 100) / target)));

  let monthsToTarget: GoalProgress["monthsToTarget"] = null;
  if (remaining === 0) monthsToTarget = { low: 0, high: 0 };
  else if (remaining !== null && contribution > 0) {
    const n = Math.floor((remaining + contribution - 1) / contribution);
    monthsToTarget = { low: n - 1, high: n };
  }

  const daysLeft = g.targetDate ? dayNumber(g.targetDate) - dayNumber(todayISO) : null;
  let requiredMonthlyCents: number | null = null;
  if (remaining !== null && daysLeft !== null) {
    if (remaining === 0) requiredMonthlyCents = 0;
    else if (daysLeft <= 0) requiredMonthlyCents = remaining;
    else requiredMonthlyCents = Math.ceil((remaining * GOAL_DAYS_PER_YEAR) / (12 * daysLeft));
  }

  let behind: boolean | null = null;
  if (g.status === "active" && remaining !== null && daysLeft !== null) {
    if (remaining === 0) behind = false;
    else if (daysLeft <= 0) behind = true;
    else
      behind =
        remaining * GOAL_DAYS_PER_YEAR * GOAL_BEHIND_DEN > contribution * GOAL_BEHIND_NUM * 12 * daysLeft;
  }

  return { currentCents, remainingCents: remaining, percent, monthsToTarget, daysLeft, requiredMonthlyCents, behind };
}

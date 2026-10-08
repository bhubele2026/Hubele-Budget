// ⭐ (PR-H, owner decisions 7 and 12) THE ONE HOUSEHOLD MONEY MODEL — pure,
// dependency-free (see the package header): one household calculation, where
// bank balances, weekly spending, bills and debt payments fit together
// without counting money twice.
//
// Cash moves only through checking rows (`classifyCashRows`, `cashRows.ts`)
// and unresolved plans. Card rows never move cash; they size a future Amex
// payoff plan (`computeWeeklyPayoff`, `artifacts/api-server/src/lib/
// amexAnchor.ts`). `classifyMovement` gives every ledger row exactly ONE
// `coverage` (what the row is FOR) and ONE `timing` (which pool it moves
// through), so the three callers that currently each derive their own answer
// — the spine's spend windows, the Spending report, and the Budget allowance
// card — can be pointed at ONE classifier instead of three copies that drift.
//
// ⚠️ THIS MODULE CHANGES NO DISPLAYED FIGURE ON ITS OWN. It is exported and
// tested here, and `artifacts/api-server/src/lib/moneyContext.ts` loads what
// it needs, but nothing in production reads a figure from it yet (PR8r/PR10
// switch figures onto it) — see `docs/reviews/2026-09-14-household-money-core.md`
// for the parity proof and every class of row where its answer differs from
// what is displayed today.
//
// coverage — precedence, first match wins:
//   1. the core spending rule (`classifyOutflow`, called with
//      `reimbursableIsSpend: true` so ITS OWN reimbursable rule, which fires
//      before its card-pattern rules, cannot pre-empt steps 2-6 below) says
//      transfer / debt payment / card payment / income / excluded. Bank-noise
//      and an excluded category both fold into "excluded"/"transfer" the same
//      way the Spending report already folds them (`bank_noise` has always
//      landed in `excluded.transfersTotal`, beside real transfers);
//   2. a CONFIRMED bill match (`ctx.matchedTxnIds`) → bill_matched. A weekly or
//      monthly allowance flag on a matched row is IGNORED, not silently
//      dropped: `conflict: "flag_ignored_matched"`. An unplanned flag on a
//      matched row: `conflict: "unplanned_on_matched"`.
//      Or a TIER-2 PAIR (`ctx.tier2PairedTxnIds`) on a row with NO allowance
//      flag → bill_matched. A flagged row keeps its flag: a suggested pair
//      never overrides a user flag (plan section A, decision 12). The set is
//      injected; PR8r supplies it from the match tiers, and it defaults to
//      empty. (`reimbursable` is not an allowance flag, so an unflagged
//      reimbursable row on a tier-2 pair reads bill_matched, the same as it
//      does on a confirmed match.)
//   3. `reimbursable`        → reimbursable (PR-B2: ahead of every flag);
//   4. `unplanned_allowance` → unplanned;
//   5. `monthly_allowance`   → allowance_monthly;
//   6. `weekly_allowance`    → allowance_weekly;
//   7. otherwise             → needs_classification.
//
// ⭐ (PR-B2, the owner's rule of 2026-09-15: "a reimbursable charge is its own
// row") Step 3 outranks the flags: a row that is BOTH `reimbursable` and flagged
// reads `reimbursable`, never its flag's coverage — exactly what today's
// `classifyOutflow`-based rules (`spendingFacts.ts`, `budgetActuals.ts`) already
// do. Before PR-B2 the flags outranked it (plan section A's first order), and
// the "forward" parity mode counted such a row under its flag.
//
// An inflow (`classifyOutflow`'s "not_outflow": the row is not an outflow at
// all) is not covered by the outflow rule, so it is decided on its own
// footing: real income (`isRealIncome`) is `income`; (B6) a refund
// (`classifyRefund`, with `reimbursableIsSpend: true`) is `refund`, and
// `nets` names the coverage it takes money off — placed by steps 2-7 below
// exactly as a purchase with the same flags would be; every other inflow (a
// transfer in, a debt draw, an unmarked deposit) is `excluded`, as before.
// `allowanceTotals` does the netting: per account, inside a window, never
// below zero (docs/reviews/2026-10-08-b6-refunds.md).
//
// timing — which pool the row moves through:
//   - `checking`: the row is on the household's tracked checking account —
//     the SAME bank-row identity `classifyCashRows`/`isBankRow` use (this
//     module calls `isBankRow` directly), so a row this calls "checking" and
//     a row the cash ledger counts are always the same set. With no resolved
//     checking account no PLAID row is checking, but a manual row (no Plaid
//     account, source not a card) still is — exactly as the cash rule counts
//     it ("cash moves only through checking rows");
//   - `card`: the row is on the Amex ledger itself (`CARD_LEDGER_SOURCES`,
//     mirrored from `AMEX_TXN_SOURCES` in
//     `artifacts/api-server/src/lib/amexAnchor.ts` — avalanche-core cannot
//     import from api-server, so the two lists are pinned equal by
//     `artifacts/api-server/src/lib/moneyContext.test.ts`). It never moves
//     cash; it sizes a future Amex payoff plan;
//   - `none`: neither.
//
// ⚠️ NOT YET: section A's third timing, "via an Amex payoff on date Y" (a card
// row tied to the payoff that settles it), needs the payoff hooks
// (`everydayHooks`), which ship with PR8r. Until then a card row's timing is
// `card` with its own date.

import { isBankRow } from "./cashRows";
import { weekBounds } from "./householdTime";
import {
  CARD_LEDGER_SOURCES,
  classifyOutflow,
  classifyRefund,
  creditAmount,
  isRealIncome,
  spendAmount,
  type SpendContext,
  type SpendTxn,
} from "./spendingRule";

export const MOVEMENT_COVERAGES = [
  "transfer",
  "debt_payment",
  "card_payment",
  "bill_matched",
  "unplanned",
  "allowance_monthly",
  "allowance_weekly",
  "reimbursable",
  "needs_classification",
  "income",
  "excluded",
  // (B6) Money back on a spending account; `nets` says which coverage it reduces.
  "refund",
] as const;
export type MovementCoverage = (typeof MOVEMENT_COVERAGES)[number];

/**
 * (B6) The coverages a refund can net: the ones steps 2-7 place a purchase in.
 * A refund is never itself a transfer, debt payment, card payment, income or
 * excluded row — those credits are not refunds.
 */
export type RefundNets = Extract<
  MovementCoverage,
  "bill_matched" | "unplanned" | "allowance_monthly" | "allowance_weekly" | "reimbursable" | "needs_classification"
>;

/**
 * A precedence conflict this row had, reported rather than hidden. Both only
 * ever accompany `coverage: "bill_matched"` from a CONFIRMED match: a flag the
 * match outranked. (A tier-2 pair never outranks a flag, so it never conflicts.)
 */
export type MovementConflict = "flag_ignored_matched" | "unplanned_on_matched";

export type MovementTiming =
  | { kind: "checking"; date: string }
  | { kind: "card"; accountId: string; date: string }
  | { kind: "none" };

export interface MovementClassification {
  coverage: MovementCoverage;
  timing: MovementTiming;
  /** Present only when a lower-precedence signal on the row was overruled. */
  conflict?: MovementConflict;
  /** (B6) Present only on a `refund`: the coverage it takes money off. */
  nets?: RefundNets;
}

/**
 * Ledger-source values that are an Amex card's own rows, never cash. Mirrors
 * `AMEX_TXN_SOURCES` (`artifacts/api-server/src/lib/amexAnchor.ts`) — see the
 * file header for why this is a mirror, not an import, and where the two are
 * pinned equal.
 */
export { CARD_LEDGER_SOURCES };

/** The row `classifyMovement` reads: the core outflow fields, identity, and
 *  the three allowance flags. Every field required, same reasoning as
 *  `SpendTxn`: a caller that forgets one fails to compile instead of
 *  classifying with a silent default. */
export interface MovementRow extends SpendTxn {
  id: string;
  /** ISO date (`YYYY-MM-DD`), household-local. */
  occurredOn: string;
  plaidAccountId: string | null;
  unplannedAllowance: boolean;
  monthlyAllowance: boolean;
  weeklyAllowance: boolean;
}

export interface MovementContext extends SpendContext {
  /**
   * The household's tracked checking account: `isBankRow`'s third argument.
   * Null with no bank account resolved — then no Plaid row is checking, while a
   * manual row still is (see the file header).
   */
  checkingAccountExternalId: string | null;
  /**
   * Transaction ids with a CONFIRMED bill match: a `forecast_resolutions` row
   * with status `matched` or `partial` whose `matched_txn_id` is this row — or
   * the pending row this posted row replaced (the loader carries it across).
   */
  matchedTxnIds: ReadonlySet<string>;
  /**
   * Transaction ids a tier-2 match pairs with a bill (step 2's second half),
   * honoured only on a row with no allowance flag. Injected: PR8r supplies it
   * from the match tiers. Omitted = empty.
   */
  tier2PairedTxnIds?: ReadonlySet<string>;
}

function timingOf(row: MovementRow, ctx: MovementContext): MovementTiming {
  if (isBankRow(row.source, row.plaidAccountId, ctx.checkingAccountExternalId)) {
    return { kind: "checking", date: row.occurredOn };
  }
  const source = (row.source ?? "").toLowerCase();
  if ((CARD_LEDGER_SOURCES as readonly string[]).includes(source)) {
    return { kind: "card", accountId: row.plaidAccountId ?? row.source, date: row.occurredOn };
  }
  return { kind: "none" };
}

/**
 * ⭐ THE ONE ROW CLASSIFIER. See the file header for the full precedence and
 * timing rules. Exactly one `coverage`, exactly one `timing`, every time.
 */
export function classifyMovement(
  row: MovementRow,
  ctx: MovementContext,
): MovementClassification {
  const timing = timingOf(row, ctx);

  // Step 1: the core spending rule — `reimbursableIsSpend: true` so its OWN
  // rule 7 (reimbursable, which fires before its card-pattern rules 8-9)
  // cannot pre-empt this module's own precedence (steps 2-6 below). Only
  // transfer / debt payment / card payment / an outflow in an income category
  // / an excluded category / bank noise / "not an outflow" come back here;
  // everything else is "spend" for this module to place.
  const core = classifyOutflow(row, ctx, { reimbursableIsSpend: true });
  switch (core.kind) {
    case "transfer":
    case "bank_noise": // folds into "transfer" — exactly how the Spending report already buckets bank noise
      return { coverage: "transfer", timing };
    case "debt_payment":
      return { coverage: "debt_payment", timing };
    case "card_payment":
      return { coverage: "card_payment", timing };
    case "excluded_category":
      return { coverage: "excluded", timing };
    case "income":
      return { coverage: "income", timing };
    case "not_outflow":
      if (isRealIncome(row, ctx)) return { coverage: "income", timing };
      // (B6) A refund nets the coverage a purchase with its flags would have.
      if (classifyRefund(row, ctx, { reimbursableIsSpend: true })) {
        return { coverage: "refund", timing, nets: placeOf(row, ctx).coverage };
      }
      return { coverage: "excluded", timing };
    case "reimbursable": // unreachable: reimbursableIsSpend suppresses this
    case "spend":
      break;
  }
  return { ...placeOf(row, ctx), timing };
}

/** Steps 2-7: where a purchase (or, B6, the refund of one) is placed. */
function placeOf(
  row: MovementRow,
  ctx: MovementContext,
): { coverage: RefundNets; conflict?: MovementConflict } {
  // Step 2: a confirmed match beats every flag, and says which one it beat.
  if (ctx.matchedTxnIds.has(row.id)) {
    if (row.unplannedAllowance) {
      return { coverage: "bill_matched", conflict: "unplanned_on_matched" };
    }
    if (row.monthlyAllowance || row.weeklyAllowance) {
      return { coverage: "bill_matched", conflict: "flag_ignored_matched" };
    }
    return { coverage: "bill_matched" };
  }
  // …a tier-2 pair only where the household put no flag.
  const flagged = row.unplannedAllowance || row.monthlyAllowance || row.weeklyAllowance;
  if (!flagged && ctx.tier2PairedTxnIds?.has(row.id)) {
    return { coverage: "bill_matched" };
  }
  // ⭐ (PR-B2, the owner's rule of 2026-09-15) A REIMBURSABLE CHARGE IS ITS OWN ROW:
  // it comes ahead of every allowance flag, as `classifyOutflow`'s own rule 7 and
  // today's Spending report and Budget card already treat it. Before PR-B2 a
  // reimbursable row the household also flagged weekly counted against the week.
  if (row.reimbursable) return { coverage: "reimbursable" };
  if (row.unplannedAllowance) return { coverage: "unplanned" };
  if (row.monthlyAllowance) return { coverage: "allowance_monthly" };
  if (row.weeklyAllowance) return { coverage: "allowance_weekly" };
  return { coverage: "needs_classification" };
}

// ── (B6) Refunds net: per account, inside a window, never below zero ───────

/**
 * The account a row nets on: its Plaid account, else its ledger source (a
 * workbook Amex row, a manual row). A refund only ever nets spending on the
 * same account.
 */
export function netAccountOf(row: { plaidAccountId: string | null; source: string }): string {
  return row.plaidAccountId ?? `source:${row.source}`;
}

/**
 * One classified row as the allowance figures read it — the shape
 * `PositionWeekRow` (availableToSpend.ts) and `MetricsSpendRow` (metrics.ts)
 * already have, plus its account.
 */
export interface AllowanceRow {
  /** The coverage the row counts in; a refund carries the coverage it nets. */
  coverage: string;
  /** Signed dollars: + a purchase (`spendAmount`), − a refund (`creditAmount`). 0 for anything else. */
  spend: number | string;
  /** `netAccountOf(row)`. Absent: every such row nets on one shared account. */
  account?: string;
}

/** ⭐ (B6) A row as `allowanceTotals` reads it: a refund moves into the coverage it nets, with its credit negative. */
export function allowanceRowOf(
  row: MovementRow,
  m: MovementClassification,
): { coverage: MovementCoverage; spend: number; account: string } {
  const account = netAccountOf(row);
  if (m.coverage === "refund" && m.nets) return { coverage: m.nets, spend: -creditAmount(row), account };
  return { coverage: m.coverage, spend: spendAmount(row), account };
}

export interface AllowanceTotals {
  /** allowance_weekly + needs_classification: what counts against the weekly cap. */
  discretionaryCents: number;
  /** The not-yet-filed part of it (needs_classification). Never more than `discretionaryCents`. */
  unfiledCents: number;
  unplannedCents: number;
  monthlyCents: number;
}

const rowCents = (v: number | string): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * ⭐ (B6) THE WINDOW'S ALLOWANCE FIGURES, REFUNDS NETTED. The caller passes the
 * rows of ONE window (a household week, a month). On each account, a refund
 * takes its credit off the pool it nets, and no pool goes below zero:
 *
 *   the cap's pool  = weekly + unfiled  (one pool: both count against the cap)
 *   unplanned       = unplanned
 *   monthly         = monthly
 *
 *   discretionary_a = max(0, weekly_a + unfiled_a)
 *   unfiled_a       = min(discretionary_a, max(0, unfiled_a))
 *   unplanned_a     = max(0, unplanned_a),  monthly_a = max(0, monthly_a)
 *
 * and each figure is the sum over accounts. The cap's pool nets as ONE pool on
 * purpose: the card's payoff takes a refund off the card's charges whichever
 * flag it carries, and the hook's remaining allowance must give back exactly
 * that much, or the payoff would shrink while the room stayed put — reading
 * high (see the review note). With no refund every figure is the plain sum it
 * was before B6: a sum of non-negative amounts is never floored.
 */
export function allowanceTotals(rows: readonly AllowanceRow[]): AllowanceTotals {
  const by = new Map<string, { weekly: number; unfiled: number; unplanned: number; monthly: number }>();
  for (const r of rows) {
    const key = r.account ?? "";
    let a = by.get(key);
    if (!a) by.set(key, (a = { weekly: 0, unfiled: 0, unplanned: 0, monthly: 0 }));
    const c = rowCents(r.spend);
    if (r.coverage === "allowance_weekly") a.weekly += c;
    else if (r.coverage === "needs_classification") a.unfiled += c;
    else if (r.coverage === "unplanned") a.unplanned += c;
    else if (r.coverage === "allowance_monthly") a.monthly += c;
  }
  const out: AllowanceTotals = { discretionaryCents: 0, unfiledCents: 0, unplannedCents: 0, monthlyCents: 0 };
  for (const a of by.values()) {
    const disc = Math.max(0, a.weekly + a.unfiled);
    out.discretionaryCents += disc;
    out.unfiledCents += Math.min(disc, Math.max(0, a.unfiled));
    out.unplannedCents += Math.max(0, a.unplanned);
    out.monthlyCents += Math.max(0, a.monthly);
  }
  return out;
}

// ── The everyday plan (owner decision 7) ────────────────────────────────────

export interface AllowanceAmountSettings {
  weeklyAllowanceAmount: string | number | null | undefined;
  monthlyAllowanceAmount: string | number | null | undefined;
}

export interface EverydayPlan {
  /** This week's weekly-allowance cap, in cents. */
  weeklyCents: number;
  /** This month's monthly-allowance cap, in cents. */
  monthlyCents: number;
}

/** Dollars as the web reads them: `Number(v)`, and a value that is not a finite number is absent. */
function finiteDollars(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const toCents = (dollars: number): number => Math.round(dollars * 100);

/**
 * Is `iso` a week start on the household clock — a real `YYYY-MM-DD` date that
 * is the Sunday of its own Sunday–Saturday week (`weekBounds`)? An impossible
 * date ("2026-02-30") never equals the week start `weekBounds` computes for it.
 */
export function isHouseholdWeekStart(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && weekBounds(iso).start === iso;
}

/**
 * ⭐ THE EVERYDAY PLAN. `weeklyCents` is the per-week override for
 * `periodStartSunday` (`preferences.weeklyAllowanceOverrides["<Sunday
 * ISO>"]`) when one is set, else the standing `weeklyAllowanceAmount`. There
 * is no per-period monthly override yet, so `monthlyCents` is always the
 * standing `monthlyAllowanceAmount`.
 *
 * Parsed the way the Allowances page parses it (`allowances.tsx`: the
 * `weeklyOverrides` memo and the `planned` memo), so the server and that page
 * quote the same cap for the same week:
 *   - an override counts only when `Number(value)` is finite — "12abc", which
 *     the settings PUT schema accepts as a string, falls back to the standing
 *     amount instead of reading as $12;
 *   - the standing amounts are `Number(value)`, and 0 when that is not finite;
 *   - only a key that is a week start on the household clock
 *     (`isHouseholdWeekStart`) is an override. The web only ever looks a week
 *     up by its Sunday, so a key that is not one is never read there either;
 *     here, a `periodStartSunday` that is not a Sunday gets the standing amount.
 * ⚠️ `command-center.tsx`'s `weekView` reads an override with `Number(override)`
 * and no finite check, so for an unparsable override it shows NaN where
 * Allowances shows the standing amount. That page is not changed here.
 */
export function everydayPlan(
  periodStartSunday: string,
  settings: AllowanceAmountSettings,
  overrides?: Readonly<Record<string, string | number>> | null,
): EverydayPlan {
  const override =
    overrides && isHouseholdWeekStart(periodStartSunday)
      ? finiteDollars(overrides[periodStartSunday])
      : null;
  const weeklyDollars = override ?? finiteDollars(settings.weeklyAllowanceAmount) ?? 0;
  const monthlyDollars = finiteDollars(settings.monthlyAllowanceAmount) ?? 0;
  return { weeklyCents: toCents(weeklyDollars), monthlyCents: toCents(monthlyDollars) };
}

// ── (PR-B1) The everyday plan from `allowance_plans` rows ───────────────────

/** An `allowance_plans` row, as the plan reads it. */
export interface AllowancePlanRow {
  /** Null = the household's shared pool. A member's own plan is never the household's cap. */
  memberUserId: string | null;
  period: string;
  amount: string | number;
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
}

/**
 * The household pool's plan for `period` in effect for the week starting
 * `periodStartSunday`: of the rows that have started by the end of that week
 * (`effectiveFrom` ≤ its Saturday), the newest. So (lead's ruling on PR-B1 Q3)
 * a row effective on or before the week's Sunday governs the whole week, and a
 * change made mid-week with `effective_from` = today governs the week that
 * contains today — the whole of it, not from today on. Null when none has
 * started. Every writer dates a row on or before today (the classic settings
 * mirror uses the current week's Sunday), so a row never governs a week
 * before it was written.
 */
export function allowancePlanInEffect(
  periodStartSunday: string,
  plans: readonly AllowancePlanRow[],
  period: "weekly" | "monthly",
): AllowancePlanRow | null {
  const weekEnd = /^\d{4}-\d{2}-\d{2}$/.test(periodStartSunday)
    ? weekBounds(periodStartSunday).end
    : periodStartSunday;
  let best: AllowancePlanRow | null = null;
  for (const p of plans) {
    if (p.memberUserId != null || p.period !== period || p.effectiveFrom > weekEnd) continue;
    if (!best || p.effectiveFrom > best.effectiveFrom) best = p;
  }
  return best;
}

export interface EverydayPlanFromRows extends EverydayPlan {
  /**
   * Where `weeklyCents` came from: that week's override, a plan row, or
   * nothing (0). (Lead's ruling on PR-B1 Q2) A plan row of $0 is "nothing": a
   * $0 standing allowance means no cap was set, never a $0 cap. A per-week
   * override of 0 is still reported as the override (the money position reads
   * any $0 week as no cap).
   */
  weeklySource: "override" | "plan" | "none";
  monthlySource: "plan" | "none";
}

/**
 * ⭐ (PR-B1) `everydayPlan`, read from `allowance_plans` instead of the
 * settings row. Same parsing (`Number`, finite only), same per-week override
 * (`preferences.weeklyAllowanceOverrides`, honoured only on a week start), and
 * 0 where nothing is planned. Until settings is retired the backfill
 * (0040_allowance_plans.sql) makes the two agree for every household — pinned
 * by `everydayPlanFromRows.test.ts` and `allowancePlans.integration.test.ts`.
 */
export function everydayPlanFromRows(
  periodStartSunday: string,
  plans: readonly AllowancePlanRow[],
  overrides?: Readonly<Record<string, string | number>> | null,
): EverydayPlanFromRows {
  const override =
    overrides && isHouseholdWeekStart(periodStartSunday)
      ? finiteDollars(overrides[periodStartSunday])
      : null;
  const weekly = allowancePlanInEffect(periodStartSunday, plans, "weekly");
  const monthly = allowancePlanInEffect(periodStartSunday, plans, "monthly");
  const weeklyPlan = weekly ? finiteDollars(weekly.amount) : null;
  const monthlyPlan = monthly ? finiteDollars(monthly.amount) : null;
  const weeklyDollars = override ?? weeklyPlan ?? 0;
  return {
    weeklyCents: toCents(weeklyDollars),
    monthlyCents: toCents(monthlyPlan ?? 0),
    weeklySource: override != null ? "override" : weeklyPlan ? "plan" : "none",
    monthlySource: monthlyPlan ? "plan" : "none",
  };
}

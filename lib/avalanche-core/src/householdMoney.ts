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
// it needs, but nothing today reads a UI number from it — see
// `docs/reviews/2026-09-14-household-money-core.md` for the wiring plan and
// the rows where `classifyMovement`'s answer already differs from what today
// displays (a confirmed bill match, moved in PR8r/PR10).
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
//      matched row: `conflict: "unplanned_on_matched"`;
//   3. `unplanned_allowance` → unplanned;
//   4. `monthly_allowance`   → allowance_monthly;
//   5. `weekly_allowance`    → allowance_weekly;
//   6. `reimbursable`        → reimbursable;
//   7. otherwise             → needs_classification.
//
// ⚠️ Steps 3-5 outrank step 6 ON PURPOSE: a row that is BOTH `reimbursable`
// and flagged reads as its flag's coverage, never `reimbursable`. Today's
// `classifyOutflow`-based rules (`spendingFacts.ts`, `budgetActuals.ts`) do
// the opposite — a reimbursable row is excluded before any flag is even
// looked at — so this is a real, already-documented difference from what is
// displayed today (`artifacts/api-server/src/lib/spendingFacts.ts`'s and
// `budgetActuals.ts`'s "documented difference #2" tests), independent of the
// bill-match difference above.
//
// An inflow (`classifyOutflow`'s "not_outflow": the row is not an outflow at
// all) is not covered by the outflow rule, so it is decided on its own
// footing: real income (`isRealIncome`) is `income`; every other inflow
// (a transfer in, a refund, a debt draw) is `excluded` — the same inflows
// `buildSpendingFacts` already ignores when it sums income.
//
// timing — which pool the row moves through:
//   - `checking`: the row is on the household's tracked checking account —
//     the SAME bank-row identity `classifyCashRows`/`isBankRow` use (this
//     module calls `isBankRow` directly), so a row this calls "checking" and
//     a row the cash ledger counts are always the same set;
//   - `card`: the row is on the Amex ledger itself (`CARD_LEDGER_SOURCES`,
//     mirrored from `AMEX_TXN_SOURCES` in
//     `artifacts/api-server/src/lib/amexAnchor.ts` — avalanche-core cannot
//     import from api-server, so the two lists are pinned equal by
//     `artifacts/api-server/src/lib/moneyContext.test.ts`). It never moves
//     cash; it sizes a future Amex payoff plan;
//   - `none`: neither.

import { isBankRow } from "./cashRows";
import {
  classifyOutflow,
  isRealIncome,
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
] as const;
export type MovementCoverage = (typeof MOVEMENT_COVERAGES)[number];

/**
 * A precedence conflict this row had, reported rather than hidden. Both only
 * ever accompany `coverage: "bill_matched"`: a flag the confirmed match
 * outranked.
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
}

/**
 * Ledger-source values that are an Amex card's own rows, never cash. Mirrors
 * `AMEX_TXN_SOURCES` (`artifacts/api-server/src/lib/amexAnchor.ts`) — see the
 * file header for why this is a mirror, not an import, and where the two are
 * pinned equal.
 */
export const CARD_LEDGER_SOURCES = ["amex", "plaid:amex"] as const;

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
  /** The household's tracked checking account: `isBankRow`'s third argument. Null with no bank account resolved. */
  checkingAccountExternalId: string | null;
  /**
   * Transaction ids with a CONFIRMED bill match: a `forecast_resolutions` row
   * with status `matched` or `partial` whose `matched_txn_id` is this row.
   */
  matchedTxnIds: ReadonlySet<string>;
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
      return { coverage: isRealIncome(row, ctx) ? "income" : "excluded", timing };
    case "reimbursable": // unreachable: reimbursableIsSpend suppresses this
    case "spend":
      break;
  }

  if (ctx.matchedTxnIds.has(row.id)) {
    if (row.unplannedAllowance) {
      return { coverage: "bill_matched", timing, conflict: "unplanned_on_matched" };
    }
    if (row.monthlyAllowance || row.weeklyAllowance) {
      return { coverage: "bill_matched", timing, conflict: "flag_ignored_matched" };
    }
    return { coverage: "bill_matched", timing };
  }
  if (row.unplannedAllowance) return { coverage: "unplanned", timing };
  if (row.monthlyAllowance) return { coverage: "allowance_monthly", timing };
  if (row.weeklyAllowance) return { coverage: "allowance_weekly", timing };
  if (row.reimbursable) return { coverage: "reimbursable", timing };
  return { coverage: "needs_classification", timing };
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

function toCents(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * ⭐ THE EVERYDAY PLAN. `weeklyCents` is the per-week override for
 * `periodStartSunday` (`preferences.weeklyAllowanceOverrides["<Sunday
 * ISO>"]`) when one is set, else the standing `weeklyAllowanceAmount`. There
 * is no per-period monthly override yet, so `monthlyCents` is always the
 * standing `monthlyAllowanceAmount`.
 *
 * Moved verbatim from the client's own computation (`command-center.tsx`'s
 * `weekView`, `allowances.tsx`): `override != null ? Number(override) :
 * Number(settings?.weeklyAllowanceAmount) || 0`. Today only the web app reads
 * `weeklyAllowanceOverrides`; this is the first server-side reader
 * (`moneyContext.ts`), so the client and server cannot compute two different
 * caps for the same week.
 */
export function everydayPlan(
  periodStartSunday: string,
  settings: AllowanceAmountSettings,
  overrides?: Readonly<Record<string, string | number>> | null,
): EverydayPlan {
  const override = overrides ? overrides[periodStartSunday] : undefined;
  const weeklyCents =
    override != null ? toCents(override) : toCents(settings.weeklyAllowanceAmount);
  return { weeklyCents, monthlyCents: toCents(settings.monthlyAllowanceAmount) };
}

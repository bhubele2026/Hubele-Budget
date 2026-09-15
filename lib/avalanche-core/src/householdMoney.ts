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
//   3. `reimbursable`        → reimbursable;
//   4. `unplanned_allowance` → unplanned;
//   5. `monthly_allowance`   → allowance_monthly;
//   6. `weekly_allowance`    → allowance_weekly;
//   7. otherwise             → needs_classification.
//
// ⭐ (PR8r — the owner's answer 1 of 2026-09-15, "a reimbursable charge shows as
// its own row") REIMBURSABLE COMES BEFORE THE FLAGS. A row that is BOTH
// `reimbursable` and flagged reads `reimbursable` and never uses up an
// allowance: the answer today's `classifyOutflow`-based rules
// (`spendingFacts.ts`, `budgetActuals.ts`) already give, since they screen a
// reimbursable row before any flag is looked at. PR-H put the flags first and
// listed the difference as the class `reimbursable_flagged`; that class is
// gone. A confirmed match (step 2) still comes first: the bill is in the plan.
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
//     a row the cash ledger counts are always the same set. With no resolved
//     checking account no PLAID row is checking, but a manual row (no Plaid
//     account, source not a card) still is — exactly as the cash rule counts
//     it ("cash moves only through checking rows");
//   - `amex_payoff` (PR8r, section A's "via an Amex payoff on date Y"): the row
//     is on the Amex ledger AND on a card the everyday payoff hooks pay
//     (`ctx.amexPayoffCadence`: the household's Amex cards with no linked debt,
//     each with its billing cadence). It moves no cash on its own date; the
//     payoff that settles it does, on `payoffDate` — its period's payoff date
//     (`everydayPeriod.ts`): the Saturday of its Sunday–Saturday week on a
//     weekly card, the 1st of the next month on a monthly card;
//   - `card`: any other row on the Amex ledger (`CARD_LEDGER_SOURCES`, mirrored
//     from `AMEX_TXN_SOURCES` in `artifacts/api-server/src/lib/amexAnchor.ts` —
//     avalanche-core cannot import from api-server, so the two lists are pinned
//     equal by `artifacts/api-server/src/lib/moneyContext.test.ts`): a card
//     tracked as a debt, a workbook row with no Plaid account, or any card row
//     when no payoff cadence is handed in. It never moves cash here;
//   - `none`: neither.

import { isBankRow } from "./cashRows";
import { everydayPeriodOf } from "./everydayPeriod";
import { weekBounds } from "./householdTime";
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
 * ever accompany `coverage: "bill_matched"` from a CONFIRMED match: a flag the
 * match outranked. (A tier-2 pair never outranks a flag, so it never conflicts.)
 */
export type MovementConflict = "flag_ignored_matched" | "unplanned_on_matched";

export type MovementTiming =
  | { kind: "checking"; date: string }
  | { kind: "amex_payoff"; accountId: string; date: string; payoffDate: string }
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
  /**
   * (PR8r) External Amex account id → billing cadence, for the cards the everyday
   * payoff hooks pay (no linked debt). A card row on one of them has timing
   * `amex_payoff`. Omitted = no card row does.
   */
  amexPayoffCadence?: ReadonlyMap<string, "weekly" | "monthly">;
}

function timingOf(row: MovementRow, ctx: MovementContext): MovementTiming {
  if (isBankRow(row.source, row.plaidAccountId, ctx.checkingAccountExternalId)) {
    return { kind: "checking", date: row.occurredOn };
  }
  const source = (row.source ?? "").toLowerCase();
  if ((CARD_LEDGER_SOURCES as readonly string[]).includes(source)) {
    const cadence = row.plaidAccountId ? ctx.amexPayoffCadence?.get(row.plaidAccountId) : undefined;
    if (cadence && row.plaidAccountId) {
      return {
        kind: "amex_payoff",
        accountId: row.plaidAccountId,
        date: row.occurredOn,
        payoffDate: everydayPeriodOf(cadence, row.occurredOn).payoffDate,
      };
    }
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

  // Step 2: a confirmed match beats every flag, and says which one it beat.
  if (ctx.matchedTxnIds.has(row.id)) {
    if (row.unplannedAllowance) {
      return { coverage: "bill_matched", timing, conflict: "unplanned_on_matched" };
    }
    if (row.monthlyAllowance || row.weeklyAllowance) {
      return { coverage: "bill_matched", timing, conflict: "flag_ignored_matched" };
    }
    return { coverage: "bill_matched", timing };
  }
  // …a tier-2 pair only where the household put no flag.
  const flagged = row.unplannedAllowance || row.monthlyAllowance || row.weeklyAllowance;
  if (!flagged && ctx.tier2PairedTxnIds?.has(row.id)) {
    return { coverage: "bill_matched", timing };
  }
  // (PR8r, answer 1) A reimbursable charge is its own row, flagged or not.
  if (row.reimbursable) return { coverage: "reimbursable", timing };
  if (row.unplannedAllowance) return { coverage: "unplanned", timing };
  if (row.monthlyAllowance) return { coverage: "allowance_monthly", timing };
  if (row.weeklyAllowance) return { coverage: "allowance_weekly", timing };
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

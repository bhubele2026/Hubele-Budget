// ⭐ (PR-B2, owner decision 7) THE EVERYDAY HOOKS' SERVER LOADER — what each
// hook occurrence on the forecast is worth: the card payment it stands for.
// The rules themselves are pure and live in avalanche-core (`everydayHooks.ts`);
// this file only reads what those rules need and adds nothing to them.
//
// ⭐ (F1, owner's answers 2026-10-14) TWO MODELS, ONE SHAPE.
//
//   "obligations" (the default; `HOOK_OBLIGATIONS=off` turns it off)
//     incurred      `readCardPeriods` — each card's purchases − refunds in each
//                   hook period, by the payoff's own per-row rule (`cardRowOwed`:
//                   every coverage, "not mine" out, pending → posted once) — for
//                   the cards the household pays IN FULL at the hook's cadence
//                   (`cardPayoffMode.ts`; debt-linked or not, unresolved ones
//                   too), less the payments allocated to the period;
//     payments      `allocateHookPayments`, oldest obligation first, from: the
//                   checking rows no plan used that name the issuer, or that are
//                   tagged to an in_full card's debt; the payment credits on an
//                   in_full card's own ledger. A card credit and the checking row
//                   that sent it are ONE payment (same cents, the checking row
//                   from 5 days before to — F5 round 2 — 5 days after the
//                   credit, naming the issuer or tagged to the card's debt;
//                   round 3: or tagged to ANOTHER debt whose own card claimed it
//                   not — the card's ledger wins over the tag); a checking row
//                   that a DEBT-PLAN card's ledger shows it paid is that card's,
//                   never an in_full card's. (F5 round 2) A payment pays a period's
//                   purchases made by its date (round 3: by the rows, a monthly
//                   period too; nothing before the window's first occurrence); a
//                   row a "matched" answer names pays its week first, the rest goes on;
//     balance cap   (F5 round 2) a card's carried + current unpaid never exceeds
//                   its live (Plaid) balance, rolled forward and less payments in
//                   flight: the excess is cut oldest first (`cappedCents`); (round
//                   3) which rows the balance held is decided by the instant —
//                   pending now or at the read, or stored after it;
//     carried       `hookOccurrenceAmounts`: earlier unpaid periods, moved into
//                   the latest occurrence already due;
//     allowanceLeft the plan in effect (`everydayPlanFromRows`, the week's
//                   override honoured; `weeklyCapCents` / `monthlyCapCents` — no
//                   plan row, a $0 row or a $0 override is NO PLAN): open period
//                   max(0, cap − spent); with no plan, the item's stored amount
//                   less the period's own purchases, never below 0; closed, 0.
//     Sized from the first of last month (the ledger's own plan window).
//
//   "card_band" (pre-F1; only with `HOOK_OBLIGATIONS=off`)
//     charges = `computeWeeklyPayoff`'s cards no debt row points at, + what is
//     left of the plan while open; no plan → the stored amount; a due payoff is
//     paid only by ONE checking row naming the issuer that covers it
//     (`payoffsPaidBy`); sized from the drag floor (today − 14).
//
//   spent  (both) the open period's rows, classified by `classifyMovement` with
//          the ledger's own tier-2 pairs — exactly as the money position sizes
//          `remainingWeek` (weekly: allowance_weekly + unfiled; monthly:
//          allowance_monthly), (B6) refunds netted per account by the same
//          `allowanceTotals`.
//
// ⚠️ READ-ONLY, like the ledger that calls it.

import { and, eq, inArray } from "drizzle-orm";
import { db, plaidAccountsTable, settingsTable } from "@workspace/db";
import {
  allocateHookPayments,
  capHookObligationsAtBalance,
  cardOwedNowCents,
  CARD_CREDIT_PAIR_BEFORE,
  pairCardPaymentCredits,
  allowanceRowOf,
  allowanceSpentCents,
  everydayPlanFromRows,
  hookOccurrenceAmounts,
  hookPeriodOf,
  monthlyCapCents,
  nextHookOccurrence,
  paymentNamesCardIssuer,
  payoffFor,
  payoffsPaidBy,
  readEverydayHooks,
  weeklyCapCents,
  type AllowancePlanRow,
  type CardBalanceRead,
  type CardBalanceRow,
  type DuePayoff,
  type EverydayHooks,
  type HookCadence,
  type HookObligation,
  type HookPaymentEvidence,
  type CardLedgerCredit,
  type Payoff,
} from "@workspace/avalanche-core";
import type { CardPayoffMode, CardPayoffModeView } from "./cardPayoffMode";
import type { CorrectionOverlay } from "./correctionOverlay";
import type { CardPeriod, CardPeriodsRead } from "./amexAnchor";
import type { AmexCardCadence } from "./amexCardCadence";
import { addDaysISO, householdDayOf } from "./householdClock";

export interface HookSettings {
  hooks: EverydayHooks;
  weeklyAllowanceOverrides: Record<string, string | number> | null;
  /** (F1) The owner's preferences as read, for the card roster and the payoff modes (one settings read). */
  preferences: unknown;
}

/** The owner's hooks and per-week overrides, read once. (S2) The settings amounts are no cap: not read. */
export async function readHookSettings(ownerUserId: string): Promise<HookSettings> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  const prefs = (s?.preferences as Record<string, unknown> | null | undefined) ?? null;
  const overrides = prefs?.weeklyAllowanceOverrides;
  return {
    hooks: readEverydayHooks(prefs),
    weeklyAllowanceOverrides:
      overrides && typeof overrides === "object" && !Array.isArray(overrides)
        ? (overrides as Record<string, string | number>)
        : null,
    preferences: prefs,
  };
}

export interface HookOccurrence {
  key: string;
  cadence: HookCadence;
  occurrenceDate: string;
  /** The hook item's own stored amount, in cents (≥ 0) — used only when the period has no plan. */
  storedCents: number;
  /** (S2) The hook item's name ("Weekly Spend"), for the reserve's label. */
  label?: string;
}

/** (F1) One card's part of an occurrence: its own period's purchases − refunds. */
export interface HookPayoffCard {
  accountId: string;
  name: string | null;
  mask: string | null;
  /** How the card is paid (null: not chosen yet — billed here like in_full). */
  mode: CardPayoffMode | null;
  cents: number;
}

export interface HookPayoff extends Payoff {
  /** (S2) The occurrence's hook, item, date and item name — what `hookReserves` serves. */
  cadence: HookCadence;
  itemId: string;
  occurrenceDate: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /**
   * (Round 2, lead's ruling) The period has NO plan — (S2) by the money
   * position's rule: no plan row in effect, a $0 row or a $0 override. (F1)
   * The allowance part is then the stored amount less the period's purchases
   * (open period); before F1 the whole occurrence was the stored amount.
   */
  fromStoredAmount: boolean;
  /**
   * (S3) What the open period has already spent from its allowance, in cents —
   * the figure `remainingCents` was sized from (`allowanceSpentCents`, the same
   * helper the period breakdown's `actual` is). Null for a period that is not
   * open, or has no allowance. Read by no figure; the parity tests read it.
   */
  spentCents: number | null;
  /** (F1) Which model sized it. */
  model: "obligations" | "card_band";
  /** (F1) The item's stored amount, cents. */
  storedCents: number;
  /** (F1) Its own period's purchases − refunds on the in_full cards, before payments (`chargesCents` too). */
  ownCents: number;
  /** (F1) Payments allocated to its own period. */
  paidCents: number;
  /** (F1) Own unpaid (ownCents − paidCents). */
  incurredCents: number;
  /** (F1) Earlier unpaid periods carried in, and which. */
  carriedCents: number;
  carriedFrom: Array<{ occurrenceDate: string; periodStart: string; periodEnd: string; cents: number }>;
  /** (F1) The occurrence date this one's unpaid was carried into, or null. */
  carriedTo: string | null;
  /** (F1) `remainingCents`, by its F1 name. */
  allowanceLeftCents: number;
  /** (F1) What lands on the curve before review answers: `amountCents` − `paidCents`. */
  curveCents: number;
  /** (F1) The payment that paid most of its own period (the evidence the forecast lists), or null. */
  evidence: { txnId: string; occurredOn: string; cents: number } | null;
  /**
   * ⭐ (F5 round 2) Every payment allocated to its own period and how much of
   * it, oldest first: the banking review places each payment against what it
   * actually paid. Card credits with no checking row carry the credit's id.
   */
  allocations: Array<{ txnId: string; occurredOn: string; cents: number }>;
  /**
   * (F5 round 2) Its own purchases the cards' balances show already paid
   * beyond the payments H2 sees (`capHookObligationsAtBalance`), cents. Off the
   * curve; `incurredCents` is net of it.
   */
  cappedCents: number;
  /** (F1) The in_full cards of its cadence, each with its own period's figure. */
  cards: HookPayoffCard[];
}

/** (F1) A checking row the hooks may read as a payment: counted, on checking, no plan used it. */
export interface HookCheckingPayment {
  txnId: string;
  occurredOn: string;
  /** Signed like the bank: a payment is negative. */
  amount: number;
  description: string | null;
  /** The debt the household tagged it to (a Plaid checking row only), or null. */
  debtId: string | null;
  /** (F5 round 2) Still pending on checking. */
  pending?: boolean;
}

/** (F1) Any counted checking outflow (used or not): the other half of a card's payment credit. */
export interface HookCheckingOutflow {
  txnId: string;
  occurredOn: string;
  cents: number;
  /** (F5 round 2) It names the card issuer (round 5: `paymentNamesCardIssuer`, abbreviations too): the pairing's issuer-name guard. */
  namesIssuer?: boolean;
  /** (F5 round 2) The debt the household tagged it to, or null. */
  debtId?: string | null;
  /** (F5 round 2) Still pending on checking. */
  pending?: boolean;
}

/** (F5 round 2) A row a Review "matched" answer tied to a hook occurrence. */
export interface HookMatchedRow {
  txnId: string;
  occurredOn: string;
  /** What the row paid, cents (> 0). */
  cents: number;
}

/** (F5 round 2) The card credits of a read, with each card's linked debts (the pairing's tag rule). */
export function cardLedgerCreditsOf(cards: Pick<HookCardsRead, "modes" | "cardRead">): CardLedgerCredit[] {
  const debtsOf = new Map(cards.modes.map((m) => [m.accountId, m.linkedDebtIds] as const));
  return cards.cardRead.paymentCredits.map((c) => ({ ...c, debtIds: debtsOf.get(c.accountId) ?? [] }));
}

/**
 * (F5 round 5) The debts linked to a card whose own ledger H2 reads — every card
 * of the roster, with credits in the window or not (the pairing's pass 2: a row
 * tagged to one of them that its card did not receive went elsewhere).
 */
export function cardLedgerDebtIdsOf(cards: Pick<HookCardsRead, "modes">): Set<string> {
  return new Set(cards.modes.flatMap((m) => m.linkedDebtIds));
}

/**
 * (F5 round 3) Each card's rows that were pending when its balance was read
 * (`plaid_accounts.liability_pending_txn_ids`, kept by the liability fetch).
 * (Round 4) Read by the instant only when the read came right after a
 * transactions sync of the card's item (`pendingAtRead`). (Round 6) Every
 * fetch keeps its list, with `liability_pending_after_sync` saying which kind
 * of read it was: a non-Sync read's list is `pendingAtOtherRead`, read for
 * payment credits and refunds only. None kept: both null, the day decides.
 */
async function readPendingAtRead(
  householdId: string,
  accountIds: readonly string[],
): Promise<Map<string, Pick<CardBalanceRead, "pendingAtRead" | "pendingAtOtherRead">>> {
  const out = new Map<string, Pick<CardBalanceRead, "pendingAtRead" | "pendingAtOtherRead">>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({ accountId: plaidAccountsTable.accountId, ids: plaidAccountsTable.liabilityPendingTxnIds, afterSync: plaidAccountsTable.liabilityPendingAfterSync })
    .from(plaidAccountsTable)
    .where(and(eq(plaidAccountsTable.householdId, householdId), inArray(plaidAccountsTable.accountId, [...accountIds])));
  for (const r of rows) {
    const ids = Array.isArray(r.ids) ? new Set(r.ids.filter((x): x is string => typeof x === "string")) : null;
    out.set(r.accountId, r.afterSync === true ? { pendingAtRead: ids, pendingAtOtherRead: null } : { pendingAtRead: null, pendingAtOtherRead: ids });
  }
  return out;
}

/** (F1) The plan a dry run asks about: written nowhere, read as if it were. */
export interface PlanOverride {
  period: "weekly" | "monthly";
  amount: string;
  effectiveFrom: string;
}

/** (F1) The model in force: obligations unless `HOOK_OBLIGATIONS=off` (read per call). */
export function hookObligationsModelOn(): boolean {
  return (process.env.HOOK_OBLIGATIONS ?? "").trim().toLowerCase() !== "off";
}

const toCents = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** The plan rows with a dry run's plan applied the way `setPlanFrom` would write it. */
export function planRowsWithOverride(rows: readonly AllowancePlanRow[], override: PlanOverride | null | undefined): AllowancePlanRow[] {
  if (!override) return [...rows];
  return [
    ...rows.filter((r) => !(r.memberUserId == null && r.period === override.period && r.effectiveFrom === override.effectiveFrom)),
    { memberUserId: null, period: override.period, amount: override.amount, effectiveFrom: override.effectiveFrom },
  ];
}

/**
 * (F5) The card periods a set of hook occurrences bills: one per distinct
 * period that has started by today. The loader and the ledger's card read
 * (`readHookCards`) ask for exactly these.
 */
export function hookCardPeriodsOf(occurrences: readonly HookOccurrence[], todayISO: string): CardPeriod[] {
  const periods = new Map<string, CardPeriod>();
  for (const o of occurrences) {
    const p = hookPeriodOf(o.cadence, o.occurrenceDate);
    if (p.start <= todayISO) periods.set(`${o.cadence}|${p.start}`, { cadence: o.cadence, ...p });
  }
  return [...periods.values()];
}

/** (F5) The Amex cards, how each is paid, and their per-period purchases and payment credits — read once. */
export interface HookCardsRead {
  roster: AmexCardCadence;
  modes: CardPayoffModeView[];
  cardRead: CardPeriodsRead;
  /** The window the payment credits were read over (null: none). */
  credits: { from: string; to: string } | null;
}

/**
 * ⭐ (F5) THE CARDS, READ ONCE, BEFORE THE MATCHER. The obligations model's
 * card read, moved out of `loadHookPayoffs` so the ledger can pair each card's
 * payment credits with the checking rows that sent them (`pairCardPaymentCredits`)
 * BEFORE the plan matcher and the debt-minimum rules run — they read that one
 * pairing, and so does the loader. `credits` may reach back further than the
 * hooks' own window: a debt minimum's billing cycle starts a month before it
 * is due. Read-only.
 */
export async function readHookCards(args: {
  householdId: string;
  ownerUserId: string;
  settings: HookSettings;
  periods: readonly CardPeriod[];
  credits: { from: string; to: string } | null;
  /** (Q1) A proposed fix's dry run: the card rows read with the columns it writes. */
  overlay?: CorrectionOverlay | null;
}): Promise<HookCardsRead> {
  const [{ readCardPeriods }, { discoverAmexCards }, { loadCardPayoffModes }] = await Promise.all([
    import("./amexAnchor"),
    import("./amexCardCadence"),
    import("./cardPayoffMode"),
  ]);
  const roster = await discoverAmexCards(args.householdId, args.ownerUserId, { preferences: args.settings.preferences });
  const [modes, cardRead] = await Promise.all([
    loadCardPayoffModes(args.householdId, args.ownerUserId, { preferences: args.settings.preferences, roster }),
    readCardPeriods(args.householdId, roster, args.periods, args.credits, { overlay: args.overlay ?? null }),
  ]);
  return { roster, modes, cardRead, credits: args.credits };
}

/**
 * ⭐ Each occurrence's payoff, keyed like the ledger's plans.
 * `tier2PairedTxnIds` are the ledger's own tier-2 off-curve pairs, so the
 * remaining allowance reads exactly as `GET /money/position`'s does.
 */
export async function loadHookPayoffs(args: {
  householdId: string;
  ownerUserId: string;
  todayISO: string;
  settings: HookSettings;
  occurrences: readonly HookOccurrence[];
  tier2PairedTxnIds: ReadonlySet<string>;
  /** (F1) Occurrences due now (effective date on or before the drag cutoff). */
  dueKeys?: ReadonlySet<string>;
  /**
   * (F1) Occurrences a Review answer settled. (F5) Answered matched only: a
   * missed / skipped / dismissed answer is `reserveClosedKeys`.
   */
  settledKeys?: ReadonlySet<string>;
  /**
   * ⭐ (F5) Occurrences answered missed / skipped / dismissed. In the obligations
   * model the answer closes the RESERVE (allowance left → 0); the purchases stay
   * owed, are paid by evidence and carry (core `hookOccurrenceAmounts`). The
   * pre-F1 model (kill switch) still reads them as settled.
   */
  reserveClosedKeys?: ReadonlySet<string>;
  /** (F1) Occurrences answered partial. */
  partialKeys?: ReadonlySet<string>;
  /**
   * ⭐ (F5 round 2) Occurrences answered "matched" WITH a row (obligations model):
   * the answer closes the reserve (the key is in `reserveClosedKeys`, never
   * `settledKeys`) and the row pays that occurrence FIRST — the rest of the row
   * pays the other weeks, and purchases the row did not cover stay owed.
   */
  matchedRows?: ReadonlyMap<string, HookMatchedRow>;
  /** (F1) Checking rows no plan used (the payment candidates). */
  checkingPayments?: readonly HookCheckingPayment[];
  /** (F1) Every counted checking outflow in the window (to pair card credits with). */
  checkingOutflows?: readonly HookCheckingOutflow[];
  /** (F1) A dry run's plan. */
  planOverride?: PlanOverride | null;
  /** (F5) The ledger's card read (`readHookCards`); read here when absent. */
  cards?: HookCardsRead | null;
  /** (F5) The ledger's one pairing of card credits with checking rows; computed here when absent. */
  creditPairs?: ReturnType<typeof pairCardPaymentCredits> | null;
  /** (Q1) A proposed fix's dry run: the allowance window (and the cards, when read here) as the fix leaves them. */
  overlay?: CorrectionOverlay | null;
}): Promise<Map<string, HookPayoff>> {
  const { householdId, ownerUserId, todayISO, settings, occurrences } = args;
  const out = new Map<string, HookPayoff>();
  if (occurrences.length === 0) return out;
  const obligationsModel = hookObligationsModelOn();

  const [{ computeWeeklyPayoff }, { loadAllowancePlans, planRowsOf }, { loadAllowanceWindow }, { TRACKING_START }] =
    await Promise.all([
      import("./amexAnchor"),
      import("./allowancePlans"),
      import("./moneyContext"),
      import("./spendingFacts"),
    ]);

  // One entry per distinct period.
  type Period = { cadence: HookCadence; start: string; end: string };
  const periods = new Map<string, Period>();
  for (const o of occurrences) {
    const p = hookPeriodOf(o.cadence, o.occurrenceDate);
    periods.set(`${o.cadence}|${p.start}`, { cadence: o.cadence, ...p });
  }
  // ⭐ (S2) The cap of each period: the plan in effect (the week's override
  // honoured), by the money position's own rule (`weeklyCapCents` /
  // `monthlyCapCents`). Null = no plan. (F1) A dry run's plan applies here only.
  const planRows = planRowsWithOverride(planRowsOf(await loadAllowancePlans(householdId)), args.planOverride);
  const capOf = (p: Period): number | null => {
    const plan = everydayPlanFromRows(p.start, planRows, settings.weeklyAllowanceOverrides);
    return p.cadence === "weekly" ? weeklyCapCents(plan) : monthlyCapCents(plan);
  };
  const caps = new Map<string, number | null>();
  for (const [id, p] of periods) caps.set(id, capOf(p));

  // Periods that have started; the open ones (with an allowance) read what they spent.
  const startedAll = [...periods.entries()].filter(([, p]) => p.start <= todayISO);
  const open = startedAll.filter(([id, p]) => p.end >= todayISO && caps.get(id) != null).map(([, p]) => p);

  // What the open periods have already spent from their allowance.
  const spent = new Map<string, number>();
  const spentRead = (async (): Promise<void> => {
    if (open.length === 0) return;
    const from = open.reduce((m, p) => (p.start < m ? p.start : m), open[0]!.start);
    const to = open.reduce((m, p) => (p.end > m ? p.end : m), open[0]!.end);
    const rangeStart = from < TRACKING_START ? TRACKING_START : from;
    // (S3) `loadAllowanceWindow` — the read the money position and the period
    // breakdown classify with (the same `loadMoneyContext` + `loadMovementRows`
    // + `classifyMovement` as before).
    const { movement } = await loadAllowanceWindow(householdId, { start: rangeStart, end: to }, { tier2PairedTxnIds: args.tier2PairedTxnIds, overlay: args.overlay ?? null });
    // (B6) `allowanceRowOf` + `allowanceTotals` — the money position's own
    // netting: a refund gives back exactly what the card's charges take off.
    const classified = movement.map(({ row, m }) => ({ date: row.occurredOn, row: allowanceRowOf(row, m) }));
    for (const p of open) {
      const lo = p.start < TRACKING_START ? TRACKING_START : p.start;
      // (S3) `allowanceSpentCents`: weekly → the cap's pool, monthly → monthly-flagged.
      const inPeriod = classified.filter((r) => r.date >= lo && r.date <= p.end).map((r) => r.row);
      spent.set(`${p.cadence}|${p.start}`, allowanceSpentCents(inPeriod, p.cadence));
    }
  })();

  const who = (o: HookOccurrence) => ({
    cadence: o.cadence,
    itemId: o.key.slice(0, o.key.lastIndexOf("|")),
    occurrenceDate: o.occurrenceDate,
    label: o.label ?? "",
  });

  if (!obligationsModel) {
    // ── "card_band" (pre-F1), kept whole behind the kill switch.
    const started = startedAll.filter(([id]) => caps.get(id) != null).map(([, p]) => p);
    const charges = new Map<string, number>();
    const chargesRead = Promise.all(
      started.map(async (p) => {
        // A weekly period is its Sunday; a monthly one is read through a day whose
        // Sunday is inside the month (the 7th), so the engine bills that month.
        const weekStart = p.cadence === "weekly" ? p.start : `${p.start.slice(0, 8)}07`;
        const payoff = await computeWeeklyPayoff(householdId, weekStart, ownerUserId, { allCoverages: true });
        const cents =
          p.cadence === "weekly"
            ? toCents(payoff.combinedWeekCharges)
            : payoff.cards.filter((c) => c.cadence === "monthly").reduce((s, c) => s + toCents(c.weekCharges), 0);
        charges.set(`${p.cadence}|${p.start}`, cents);
      }),
    );
    await Promise.all([chargesRead, spentRead]);
    // A due payoff is paid only by one checking row naming the issuer that covers it.
    const datesByItem = new Map<string, string[]>();
    for (const o of occurrences) {
      const id = who(o).itemId;
      datesByItem.set(id, [...(datesByItem.get(id) ?? []), o.occurrenceDate].sort());
    }
    const sized = new Map<string, Payoff & { fromStoredAmount: boolean; spentCents: number | null }>();
    for (const o of occurrences) {
      const p = hookPeriodOf(o.cadence, o.occurrenceDate);
      const id = `${o.cadence}|${p.start}`;
      const cap = caps.get(id) ?? null;
      if (cap == null) {
        const stored = Math.max(0, Math.round(o.storedCents));
        sized.set(o.key, { amountCents: stored, chargesCents: 0, remainingCents: 0, closed: p.end < todayISO, fromStoredAmount: true, spentCents: null });
        continue;
      }
      const payoff = payoffFor({ chargesCents: charges.get(id) ?? 0, capCents: cap, spentCents: spent.get(id) ?? 0, periodEnd: p.end, todayISO });
      sized.set(o.key, { ...payoff, fromStoredAmount: false, spentCents: spent.get(id) ?? null });
    }
    const duePayoffs: DuePayoff[] = [];
    for (const o of occurrences) {
      // (F5) The pre-F1 model reads every closing answer as settling the occurrence, as before.
      if (!args.dueKeys?.has(o.key) || args.settledKeys?.has(o.key) || args.reserveClosedKeys?.has(o.key) || args.partialKeys?.has(o.key)) continue;
      const dates = datesByItem.get(who(o).itemId) ?? [];
      const next = dates.find((d) => d > o.occurrenceDate) ?? nextHookOccurrence(o.cadence, o.occurrenceDate);
      duePayoffs.push({ key: o.key, occurrenceDate: o.occurrenceDate, nextOccurrenceDate: next, amountCents: sized.get(o.key)!.amountCents });
    }
    const rows = (args.checkingPayments ?? []).filter((r) => !r.debtId).map((r) => ({ txnId: r.txnId, occurredOn: r.occurredOn, amount: r.amount, description: r.description }));
    const paidBy = payoffsPaidBy(duePayoffs, rows);
    for (const o of occurrences) {
      const p = hookPeriodOf(o.cadence, o.occurrenceDate);
      const s = sized.get(o.key)!;
      const hit = paidBy.get(o.key);
      out.set(o.key, {
        ...who(o),
        ...s,
        periodStart: p.start,
        periodEnd: p.end,
        model: "card_band",
        storedCents: Math.max(0, Math.round(o.storedCents)),
        ownCents: s.chargesCents,
        paidCents: hit ? s.amountCents : 0,
        incurredCents: hit ? 0 : s.chargesCents,
        carriedCents: 0,
        carriedFrom: [],
        carriedTo: null,
        allowanceLeftCents: s.remainingCents,
        curveCents: hit ? 0 : s.amountCents,
        evidence: hit ? { txnId: hit.txnId, occurredOn: hit.occurredOn, cents: Math.round(-hit.amount * 100) } : null,
        allocations: hit ? [{ txnId: hit.txnId, occurredOn: hit.occurredOn, cents: s.amountCents }] : [],
        cappedCents: 0,
        cards: [],
      });
    }
    return out;
  }

  // ── "obligations" (F1).
  const sizedFrom = occurrences.reduce((m, o) => (o.occurrenceDate < m ? o.occurrenceDate : m), occurrences[0]!.occurrenceDate);
  const [cardsRead] = await Promise.all([
    args.cards ??
      readHookCards({
        householdId,
        ownerUserId,
        settings,
        periods: hookCardPeriodsOf(occurrences, todayISO),
        credits: sizedFrom <= todayISO ? { from: sizedFrom, to: todayISO } : null,
        overlay: args.overlay ?? null,
      }),
    spentRead,
  ]);
  const { modes, cardRead } = cardsRead;
  const modeOf = new Map(modes.map((m) => [m.accountId, m] as const));
  const inFull = modes.filter((m) => m.effectiveMode === "in_full");
  const inFullIds = new Set(inFull.map((m) => m.accountId));
  // A tag on an in_full card's debt (archived ones too) names that card.
  const cardOfDebt = new Map<string, string>();
  for (const m of inFull) for (const d of m.linkedDebtIds) cardOfDebt.set(d, m.accountId);

  // The obligations: each in_full card's own figure, per occurrence of its cadence.
  // (F5 round 2) Every occurrence whose period has started — the open one too —
  // with the period's rows by day: a payment pays a later period only for what was
  // already bought by its date (core `allocateHookPayments`).
  const ownByKey = new Map<string, HookPayoffCard[]>();
  const obligations: HookObligation[] = [];
  const cardRows = cardRead.rows ?? new Map<string, CardBalanceRow[]>();
  // (F5 round 3) The earliest sized occurrence of each cadence: a payment dated
  // before it paid the balance from before the window, never a purchase in it.
  const firstOccurrence: Partial<Record<HookCadence, string>> = {};
  for (const o of occurrences) {
    const f = firstOccurrence[o.cadence];
    if (f === undefined || o.occurrenceDate < f) firstOccurrence[o.cadence] = o.occurrenceDate;
  }
  for (const o of occurrences) {
    const p = hookPeriodOf(o.cadence, o.occurrenceDate);
    const perCard = cardRead.charges.get(`${o.cadence}|${p.start}`);
    const cards: HookPayoffCard[] = [];
    for (const m of inFull) {
      if (m.cadence !== o.cadence) continue;
      const cents = perCard?.get(m.accountId) ?? 0;
      cards.push({ accountId: m.accountId, name: m.name, mask: m.mask, mode: m.mode, cents });
      // Not settled (a matched answer with no row) nor partial: paid by evidence.
      // (F5) A missed / skipped answer does not settle it: its purchases stay owed.
      if (cents > 0 && p.start <= todayISO && !args.settledKeys?.has(o.key) && !args.partialKeys?.has(o.key)) {
        const rows = (cardRows.get(m.accountId) ?? []).filter((r) => r.on >= p.start && r.on <= p.end).map((r) => ({ on: r.on, cents: r.cents }));
        obligations.push({ key: o.key, cadence: o.cadence, occurrenceDate: o.occurrenceDate, periodEnd: p.end, accountId: m.accountId, cents, rows });
      }
    }
    ownByKey.set(o.key, cards);
  }

  // The payments. A card's payment credit and the checking row that sent it are
  // one payment — (F5) paired once (`pairCardPaymentCredits`, core), by the ledger
  // before its matcher when it read the cards, else here.
  const available = new Map((args.checkingPayments ?? []).map((r) => [r.txnId, r] as const));
  const matchedRows = args.matchedRows ?? new Map<string, HookMatchedRow>();
  const matchedTxnIds = new Set([...matchedRows.values()].map((r) => r.txnId));
  const pairedOutflow = new Set<string>();
  /** Checking rows that are a credit's other half: the card's balance already holds them. */
  const creditBacked = new Set<string>();
  const cardOfPairedRow = new Map<string, string>();
  const evidence: HookPaymentEvidence[] = [];
  const pairs =
    args.creditPairs ??
    pairCardPaymentCredits(cardLedgerCreditsOf(cardsRead), args.checkingOutflows ?? [], { ledgerDebtIds: cardLedgerDebtIdsOf(cardsRead), todayISO });
  for (const { credit: c, outflow: best } of pairs) {
    if (best) {
      pairedOutflow.add(best.txnId);
      creditBacked.add(best.txnId);
      cardOfPairedRow.set(best.txnId, c.accountId);
    }
    if (!inFullIds.has(c.accountId)) continue; // a debt-plan card's payment: its checking row (paired above) is that card's.
    // (F5 round 2) A credit a matched answer names itself is that answer's row (below).
    if (matchedTxnIds.has(c.txnId) || (best && matchedTxnIds.has(best.txnId))) continue;
    if (!best) {
      evidence.push({ txnId: c.txnId, occurredOn: c.occurredOn, cents: c.cents, accountId: c.accountId });
    } else if (available.has(best.txnId)) {
      evidence.push({ txnId: best.txnId, occurredOn: best.occurredOn < c.occurredOn ? best.occurredOn : c.occurredOn, cents: c.cents, accountId: c.accountId });
    }
    // Paired with a row a plan already used (or a review answer claimed): that money is accounted there.
  }
  for (const r of available.values()) {
    if (pairedOutflow.has(r.txnId)) continue;
    const cents = Math.round(-r.amount * 100);
    if (cents <= 0) continue;
    if (r.debtId) {
      const card = cardOfDebt.get(r.debtId);
      if (card) evidence.push({ txnId: r.txnId, occurredOn: r.occurredOn, cents, accountId: card });
      continue;
    }
    // (F5 round 6) The pairing's name test, abbreviations too ("AMERICAN EXP CO"): a
    // payment still on its way to its card pays its week and counts in flight for
    // the cap (round 5's strict name left it paying nothing and held it over).
    if (paymentNamesCardIssuer(r.description)) evidence.push({ txnId: r.txnId, occurredOn: r.occurredOn, cents, accountId: null });
  }
  // ⭐ (F5 round 2) A row a "matched" answer tied to a week pays that week first,
  // and the rest of it pays the other weeks — never thrown away. Its card is the
  // one whose ledger received it, when that card is paid in full.
  for (const [key, r] of matchedRows) {
    if (r.cents <= 0) continue;
    const card = cardOfPairedRow.get(r.txnId);
    evidence.push({ txnId: r.txnId, occurredOn: r.occurredOn, cents: r.cents, accountId: card && inFullIds.has(card) ? card : null, forKey: key });
  }
  const allocations = allocateHookPayments(obligations, evidence, { firstOccurrence });

  // ⭐ (F5 round 2) A CARD NEVER OWES MORE THAN ITS BALANCE (the owner: "cautious
  // but never over"). For each in_full card still owing here, the card's own
  // balance — the Amex anchor's answer for the card (`resolveAmexAnchor`), used
  // only when it is Plaid's live balance (`plaid`; a debt row's stored balance,
  // an archived card's above all, can be stale) — rolled forward to now (core
  // `cardOwedNowCents`): + purchases − refunds − payment credits OUTSIDE that
  // balance, less the payments allocated here that the card has not received at
  // all (a checking row with no card credit, pending or recent). (F5 round 3)
  // "Outside" (core `outsideCardBalanceRead`), one rule for purchases and credits:
  // pending now or dated after the read's day; and, (round 4) only when the read
  // came right after a sync of the card's item (the liability fetch kept the
  // pending ids), pending at the read or stored after it. (Round 5) A payment
  // credit stored after any other read, dated within the in-flight window, is
  // outside too (core `creditOutsideCardBalanceRead`): never over what the card
  // owes — a payment made after a debt's Refresh no longer comes back once its
  // card credit pairs. (Round 6) So is a refund, and — on such a read — a credit
  // or refund H2 held as pending at it (every fetch keeps its pending list now).
  // Unpaid above that is cut, oldest first (core `capHookObligationsAtBalance`). With no live
  // balance, or one read before the rows here begin, nothing is cut.
  const balanceCaps = new Map<string, number>();
  {
    const unpaidByCard = new Map<string, number>();
    const paidByOblig = new Map<string, number>();
    for (const a of allocations) paidByOblig.set(`${a.key}#${a.accountId}`, (paidByOblig.get(`${a.key}#${a.accountId}`) ?? 0) + a.cents);
    for (const o of obligations) {
      const left = o.cents - (paidByOblig.get(`${o.key}#${o.accountId}`) ?? 0);
      if (left > 0) unpaidByCard.set(o.accountId, (unpaidByCard.get(o.accountId) ?? 0) + left);
    }
    const owing = [...unpaidByCard.keys()];
    if (owing.length > 0) {
      const [{ resolveAmexAnchor }, pendingAtRead] = await Promise.all([import("./amexAnchorRead"), readPendingAtRead(householdId, owing)]);
      const anchors = await Promise.all(owing.map(async (accountId) => [accountId, await resolveAmexAnchor(householdId, ownerUserId, accountId)] as const));
      const evidenceById = new Map(evidence.map((e) => [e.txnId, e] as const));
      const creditIds = new Set(cardRead.paymentCredits.map((c) => c.txnId));
      const pendingOutflow = new Set((args.checkingOutflows ?? []).filter((o) => o.pending === true).map((o) => o.txnId));
      for (const [accountId, anchor] of anchors) {
        if (anchor.source !== "plaid" || anchor.amexEndingBalance == null || !Number.isFinite(anchor.amexEndingBalance)) continue;
        const asOfDay = householdDayOf(anchor.asOf);
        if (!cardRead.readFrom || asOfDay < cardRead.readFrom) continue;
        const inFlightFrom = addDaysISO(asOfDay, -CARD_CREDIT_PAIR_BEFORE);
        let inFlight = 0;
        for (const a of allocations) {
          if (a.accountId !== accountId) continue;
          const e = evidenceById.get(a.txnId);
          // A card credit, or the checking half of one: the credit's own rule reads it.
          if (!e || creditBacked.has(a.txnId) || creditIds.has(a.txnId)) continue;
          const pending = available.get(a.txnId)?.pending === true || pendingOutflow.has(a.txnId);
          if (pending || e.occurredOn >= inFlightFrom) inFlight += a.cents;
        }
        const credits: CardBalanceRow[] = cardRead.paymentCredits
          .filter((c) => c.accountId === accountId)
          .map((c) => ({ txnId: c.txnId, on: c.occurredOn, cents: c.cents, pending: c.pending === true, createdAt: c.createdAt ?? null }));
        balanceCaps.set(
          accountId,
          cardOwedNowCents(
            {
              balanceCents: Math.round(anchor.amexEndingBalance * 100),
              asOf: anchor.asOf,
              asOfDay,
              pendingAtRead: pendingAtRead.get(accountId)?.pendingAtRead ?? null,
              pendingAtOtherRead: pendingAtRead.get(accountId)?.pendingAtOtherRead ?? null,
            },
            cardRows.get(accountId) ?? [],
            credits,
            inFlight,
          ),
        );
      }
    }
  }
  const capped = capHookObligationsAtBalance(obligations, allocations, balanceCaps);
  const cappedByKey = new Map<string, number>();
  for (const c of capped) cappedByKey.set(c.key, (cappedByKey.get(c.key) ?? 0) + c.cents);

  const paidByKey = new Map<string, number>();
  const bestRow = new Map<string, { txnId: string; occurredOn: string; cents: number }>();
  const evidenceById = new Map(evidence.map((e) => [e.txnId, e] as const));
  const perKeyTxn = new Map<string, Map<string, number>>();
  for (const a of allocations) {
    paidByKey.set(a.key, (paidByKey.get(a.key) ?? 0) + a.cents);
    const m = perKeyTxn.get(a.key) ?? new Map<string, number>();
    m.set(a.txnId, (m.get(a.txnId) ?? 0) + a.cents);
    perKeyTxn.set(a.key, m);
  }
  for (const [key, m] of perKeyTxn) {
    let top: { txnId: string; cents: number } | null = null;
    for (const [txnId, cents] of m) {
      const e = evidenceById.get(txnId)!;
      if (!top || cents > top.cents || (cents === top.cents && e.occurredOn > evidenceById.get(top.txnId)!.occurredOn)) top = { txnId, cents };
    }
    const e = evidenceById.get(top!.txnId)!;
    bestRow.set(key, { txnId: e.txnId, occurredOn: e.occurredOn, cents: e.cents });
  }

  const amounts = hookOccurrenceAmounts(
    occurrences.map((o) => {
      const p = hookPeriodOf(o.cadence, o.occurrenceDate);
      const id = `${o.cadence}|${p.start}`;
      return {
        key: o.key,
        itemId: who(o).itemId,
        occurrenceDate: o.occurrenceDate,
        periodEnd: p.end,
        capCents: caps.get(id) ?? null,
        storedCents: Math.max(0, Math.round(o.storedCents)),
        spentCents: spent.get(id) ?? 0,
        ownCents: (ownByKey.get(o.key) ?? []).reduce((s, c) => s + c.cents, 0),
        paidCents: paidByKey.get(o.key) ?? 0,
        cappedCents: cappedByKey.get(o.key) ?? 0,
        due: args.dueKeys?.has(o.key) ?? false,
        settled: args.settledKeys?.has(o.key) ?? false,
        reserveClosed: args.reserveClosedKeys?.has(o.key) ?? false,
        partial: args.partialKeys?.has(o.key) ?? false,
      };
    }),
    todayISO,
  );
  const occByKey = new Map(occurrences.map((o) => [o.key, o] as const));
  for (const o of occurrences) {
    const p = hookPeriodOf(o.cadence, o.occurrenceDate);
    const id = `${o.cadence}|${p.start}`;
    const a = amounts.get(o.key)!;
    const cap = caps.get(id) ?? null;
    const ownCents = (ownByKey.get(o.key) ?? []).reduce((s, c) => s + c.cents, 0);
    out.set(o.key, {
      ...who(o),
      amountCents: a.amountCents,
      chargesCents: ownCents,
      remainingCents: a.allowanceLeftCents,
      closed: a.closed,
      periodStart: p.start,
      periodEnd: p.end,
      fromStoredAmount: cap == null,
      spentCents: cap != null && p.start <= todayISO && p.end >= todayISO ? (spent.get(id) ?? null) : null,
      model: "obligations",
      storedCents: Math.max(0, Math.round(o.storedCents)),
      ownCents,
      paidCents: a.paidCents,
      incurredCents: a.incurredCents,
      carriedCents: a.carriedCents,
      carriedFrom: a.carriedFrom.map((c) => {
        const from = occByKey.get(c.key)!;
        const fp = hookPeriodOf(from.cadence, from.occurrenceDate);
        return { occurrenceDate: c.occurrenceDate, periodStart: fp.start, periodEnd: fp.end, cents: c.cents };
      }),
      carriedTo: a.carriedTo ? occByKey.get(a.carriedTo)!.occurrenceDate : null,
      allowanceLeftCents: a.allowanceLeftCents,
      curveCents: a.curveCents,
      evidence: bestRow.get(o.key) ?? null,
      allocations: [...(perKeyTxn.get(o.key) ?? new Map<string, number>())]
        .map(([txnId, cents]) => ({ txnId, occurredOn: evidenceById.get(txnId)!.occurredOn, cents }))
        .sort((x, y) => (x.occurredOn < y.occurredOn ? -1 : x.occurredOn > y.occurredOn ? 1 : x.txnId < y.txnId ? -1 : 1)),
      cappedCents: a.cappedCents,
      cards: (ownByKey.get(o.key) ?? []).map((c) => ({ ...c, mode: modeOf.get(c.accountId)?.mode ?? null })),
    });
  }
  return out;
}

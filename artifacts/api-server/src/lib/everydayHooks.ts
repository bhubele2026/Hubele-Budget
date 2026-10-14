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
//                   from 5 days before to 2 days after the credit); a checking
//                   row that a DEBT-PLAN card's ledger shows it paid is that
//                   card's, never an in_full card's;
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

import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import {
  allocateHookPayments,
  allowanceRowOf,
  allowanceSpentCents,
  everydayPlanFromRows,
  hookOccurrenceAmounts,
  hookPeriodOf,
  monthlyCapCents,
  namesCardIssuer,
  nextHookOccurrence,
  payoffFor,
  payoffsPaidBy,
  readEverydayHooks,
  weeklyCapCents,
  type AllowancePlanRow,
  type DuePayoff,
  type EverydayHooks,
  type HookCadence,
  type HookObligation,
  type HookPaymentEvidence,
  type Payoff,
} from "@workspace/avalanche-core";
import type { CardPayoffMode } from "./cardPayoffMode";

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
}

/** (F1) Any counted checking outflow (used or not): the other half of a card's payment credit. */
export interface HookCheckingOutflow {
  txnId: string;
  occurredOn: string;
  cents: number;
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

/** Days a checking row may sit before (−) or after (+) the card's payment credit and still be the same payment. */
const CREDIT_PAIR_BEFORE = 5;
const CREDIT_PAIR_AFTER = 2;

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
  /** (F1) Occurrences answered matched / skipped / missed / dismissed. */
  settledKeys?: ReadonlySet<string>;
  /** (F1) Occurrences answered partial. */
  partialKeys?: ReadonlySet<string>;
  /** (F1) Checking rows no plan used (the payment candidates). */
  checkingPayments?: readonly HookCheckingPayment[];
  /** (F1) Every counted checking outflow in the window (to pair card credits with). */
  checkingOutflows?: readonly HookCheckingOutflow[];
  /** (F1) A dry run's plan. */
  planOverride?: PlanOverride | null;
}): Promise<Map<string, HookPayoff>> {
  const { householdId, ownerUserId, todayISO, settings, occurrences } = args;
  const out = new Map<string, HookPayoff>();
  if (occurrences.length === 0) return out;
  const obligationsModel = hookObligationsModelOn();

  const [{ computeWeeklyPayoff, readCardPeriods }, { loadAllowancePlans, planRowsOf }, { loadAllowanceWindow }, { TRACKING_START }, { discoverAmexCards }, { loadCardPayoffModes }] =
    await Promise.all([
      import("./amexAnchor"),
      import("./allowancePlans"),
      import("./moneyContext"),
      import("./spendingFacts"),
      import("./amexCardCadence"),
      import("./cardPayoffMode"),
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
    const { movement } = await loadAllowanceWindow(householdId, { start: rangeStart, end: to }, { tier2PairedTxnIds: args.tier2PairedTxnIds });
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
      if (!args.dueKeys?.has(o.key) || args.settledKeys?.has(o.key) || args.partialKeys?.has(o.key)) continue;
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
        cards: [],
      });
    }
    return out;
  }

  // ── "obligations" (F1).
  const roster = await discoverAmexCards(householdId, ownerUserId, { preferences: settings.preferences });
  const sizedFrom = occurrences.reduce((m, o) => (o.occurrenceDate < m ? o.occurrenceDate : m), occurrences[0]!.occurrenceDate);
  const startedPeriods = startedAll.map(([, p]) => p);
  const [modes, cardRead] = await Promise.all([
    loadCardPayoffModes(householdId, ownerUserId, { preferences: settings.preferences, roster }),
    readCardPeriods(householdId, roster, startedPeriods, sizedFrom <= todayISO ? { from: sizedFrom, to: todayISO } : null),
    spentRead,
  ]);
  const modeOf = new Map(modes.map((m) => [m.accountId, m] as const));
  const inFull = modes.filter((m) => m.effectiveMode === "in_full");
  const inFullIds = new Set(inFull.map((m) => m.accountId));
  // A tag on an in_full card's debt (archived ones too) names that card.
  const cardOfDebt = new Map<string, string>();
  for (const m of inFull) for (const d of m.linkedDebtIds) cardOfDebt.set(d, m.accountId);

  // The obligations: each in_full card's own figure, per occurrence of its cadence.
  const ownByKey = new Map<string, HookPayoffCard[]>();
  const obligations: HookObligation[] = [];
  for (const o of occurrences) {
    const p = hookPeriodOf(o.cadence, o.occurrenceDate);
    const perCard = cardRead.charges.get(`${o.cadence}|${p.start}`);
    const cards: HookPayoffCard[] = [];
    for (const m of inFull) {
      if (m.cadence !== o.cadence) continue;
      const cents = perCard?.get(m.accountId) ?? 0;
      cards.push({ accountId: m.accountId, name: m.name, mask: m.mask, mode: m.mode, cents });
      // Only an occurrence due and unanswered (nor partial) is paid by evidence.
      if (cents > 0 && args.dueKeys?.has(o.key) && !args.settledKeys?.has(o.key) && !args.partialKeys?.has(o.key)) {
        obligations.push({ key: o.key, cadence: o.cadence, occurrenceDate: o.occurrenceDate, accountId: m.accountId, cents });
      }
    }
    ownByKey.set(o.key, cards);
  }

  // The payments. A card's payment credit and the checking row that sent it are one payment.
  const outflows = [...(args.checkingOutflows ?? [])].sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.txnId < b.txnId ? -1 : 1));
  const available = new Map((args.checkingPayments ?? []).map((r) => [r.txnId, r] as const));
  const pairedOutflow = new Set<string>();
  const evidence: HookPaymentEvidence[] = [];
  const dayGap = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
  for (const c of cardRead.paymentCredits) {
    let best: HookCheckingOutflow | null = null;
    for (const r of outflows) {
      if (pairedOutflow.has(r.txnId) || r.cents !== c.cents) continue;
      const gap = dayGap(r.occurredOn, c.occurredOn);
      if (gap < -CREDIT_PAIR_BEFORE || gap > CREDIT_PAIR_AFTER) continue;
      if (!best || Math.abs(gap) < Math.abs(dayGap(best.occurredOn, c.occurredOn))) best = r;
    }
    if (best) pairedOutflow.add(best.txnId);
    if (!inFullIds.has(c.accountId)) continue; // a debt-plan card's payment: its checking row (paired above) is that card's.
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
    if (namesCardIssuer(r.description)) evidence.push({ txnId: r.txnId, occurredOn: r.occurredOn, cents, accountId: null });
  }
  const allocations = allocateHookPayments(obligations, evidence);
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
        due: args.dueKeys?.has(o.key) ?? false,
        settled: args.settledKeys?.has(o.key) ?? false,
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
      cards: (ownByKey.get(o.key) ?? []).map((c) => ({ ...c, mode: modeOf.get(c.accountId)?.mode ?? null })),
    });
  }
  return out;
}

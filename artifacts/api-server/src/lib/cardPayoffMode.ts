// ⭐ (F1) HOW EACH AMEX CARD IS PAID — "in full" or "on the debt plan".
//
// The owner, 2026-10-14:
//   - Platinum ••2007 (its debt row ARCHIVED): "We try to pay weekly for what we
//     spend, doesn't always happen" → paid IN FULL at its cadence; an unpaid
//     week stays owed until paid.
//   - Blue Cash ••1006 (an ACTIVE debt, minimum $143.05): paying it down —
//     minimum + extra; new purchases add to the balance, so the forecast must
//     NOT also reserve them → on the DEBT PLAN.
//
// Before F1 the everyday hooks billed a card only when NO debt row pointed at
// it (`computeWeeklyPayoff`'s `bandCards`, any status). An archived debt took
// the card out of the hook and paid nothing either (`debtMinSchedule.ts` emits
// a minimum for an ACTIVE debt only), so its purchases were paid by no event.
//
// The mode, per card (external Plaid `account_id`):
//   1. the owner's explicit choice, `settings.preferences.amexCardPayoffMode`
//      (server-owned; written only by `PUT /amex/cards/:accountId/payoff-mode`);
//   2. else a default from the card's linked debt rows
//      (`debts.plaid_account_id = plaid_accounts.id`, the link the payoff
//      engine already reads):
//        no debt row                          → in_full  (no_debt)
//        no ACTIVE one (archived / paid /
//          zero balance)                      → in_full  (debt_not_active)
//        an active one with an APR or a
//          minimum (revolving)                → debt_plan (debt_active)
//        an active one with neither           → UNRESOLVED (debt_terms_missing)
//   An explicit `debt_plan` with no active revolving debt behind it is
//   UNRESOLVED too (debt_plan_without_active_debt): nothing on the forecast
//   would pay its purchases.
//
// An unresolved card is billed by the hook like an in_full one (the forecast
// may read low, never high — no minimum pays it), and it holds the plan gate
// (`planSafety.ts`) until the owner chooses.
//
// ⚠️ READ-ONLY. No write here; no default is ever stored.

import { and, eq, inArray } from "drizzle-orm";
import { db, debtsTable, recurringItemsTable, settingsTable } from "@workspace/db";
import { readEverydayHooks, type HookCadence } from "@workspace/avalanche-core";
import { discoverAmexCards, type AmexCardCadence } from "./amexCardCadence";
import { hookObligationsModelOn } from "./everydayHooks";

export type CardPayoffMode = "in_full" | "debt_plan";
export type PayoffModeSource = "explicit" | "default";
export type PayoffModeReason =
  | "set_by_owner"
  | "no_debt"
  | "debt_not_active"
  | "debt_active"
  | "debt_terms_missing"
  | "debt_plan_without_active_debt";

/** The preference key (server-owned: `SERVER_OWNED_PREFERENCE_KEYS`). */
export const PAYOFF_MODE_PREF = "amexCardPayoffMode" as const;

/** A linked debt row, as the resolver reads it. */
export interface PayoffModeDebt {
  id: string;
  status: string | null;
  balance: string | number | null;
  apr: string | number | null;
  minPayment: string | number | null;
}

export interface PayoffModeAnswer {
  /** null = unresolved: the owner must choose (the plan gate holds). */
  mode: CardPayoffMode | null;
  source: PayoffModeSource;
  reason: PayoffModeReason;
  /** The linked debt the answer read (an active one first), or null. */
  debtId: string | null;
}

const num = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** A debt the payoff plan still pays: status active (null reads active) and a balance over half a cent. */
export function isActiveDebt(d: Pick<PayoffModeDebt, "status" | "balance">): boolean {
  return (d.status ?? "active") === "active" && num(d.balance) > 0.005;
}

/** Revolving: an APR or a minimum payment. */
const isRevolving = (d: PayoffModeDebt): boolean => num(d.apr) > 0 || num(d.minPayment) > 0;

/** Read one card's explicit choice from the preferences; anything else is "not set". */
export function explicitPayoffMode(preferences: unknown, accountId: string): CardPayoffMode | null {
  const prefs = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : {};
  const map = prefs[PAYOFF_MODE_PREF];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const v = (map as Record<string, unknown>)[accountId];
  return v === "in_full" || v === "debt_plan" ? v : null;
}

/**
 * ⭐ THE ONE RULE (pure). `explicit` is the owner's choice for the card (or
 * null); `linked` every debt row linked to the card's account.
 */
export function resolvePayoffMode(explicit: CardPayoffMode | null, linked: readonly PayoffModeDebt[]): PayoffModeAnswer {
  const active = linked.filter(isActiveDebt);
  const revolving = active.filter(isRevolving);
  const debtId = (revolving[0] ?? active[0] ?? linked[0])?.id ?? null;
  if (explicit === "in_full") return { mode: "in_full", source: "explicit", reason: "set_by_owner", debtId };
  if (explicit === "debt_plan") {
    return revolving.length > 0
      ? { mode: "debt_plan", source: "explicit", reason: "set_by_owner", debtId }
      : { mode: null, source: "explicit", reason: "debt_plan_without_active_debt", debtId };
  }
  if (linked.length === 0) return { mode: "in_full", source: "default", reason: "no_debt", debtId: null };
  if (active.length === 0) return { mode: "in_full", source: "default", reason: "debt_not_active", debtId };
  if (revolving.length > 0) return { mode: "debt_plan", source: "default", reason: "debt_active", debtId };
  return { mode: null, source: "default", reason: "debt_terms_missing", debtId };
}

/** One discovered Amex card and how it is paid. */
export interface CardPayoffModeView extends PayoffModeAnswer {
  /** External Plaid `account_id`. */
  accountId: string;
  /** Internal `plaid_accounts.id`. */
  internalId: string;
  name: string | null;
  mask: string | null;
  cadence: "weekly" | "monthly";
  /** What the forecast bills the card as: the mode, or in_full while unresolved. */
  effectiveMode: CardPayoffMode;
  /** Every debt row linked to the card (any status). */
  linkedDebtIds: string[];
}

/**
 * Every discovered Amex card of the household with its payoff mode. Reads the
 * card roster (`discoverAmexCards`, unless handed one), the debts linked to
 * those cards, and the owner's preferences (unless handed them).
 */
export async function loadCardPayoffModes(
  householdId: string,
  ownerUserId: string,
  opts: { preferences?: unknown; roster?: AmexCardCadence } = {},
): Promise<CardPayoffModeView[]> {
  let preferences: unknown = opts.preferences;
  if (!("preferences" in opts)) {
    const [s] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerUserId));
    preferences = s?.preferences ?? null;
  }
  const roster = opts.roster ?? (await discoverAmexCards(householdId, ownerUserId, { preferences }));
  if (roster.cardRows.length === 0) return [];
  const internalIds = roster.cardRows.map((c) => c.internalId);
  const debts = await db
    .select({
      id: debtsTable.id,
      status: debtsTable.status,
      balance: debtsTable.balance,
      apr: debtsTable.apr,
      minPayment: debtsTable.minPayment,
      plaidAccountId: debtsTable.plaidAccountId,
    })
    .from(debtsTable)
    .where(and(eq(debtsTable.householdId, householdId), inArray(debtsTable.plaidAccountId, internalIds)));
  return roster.cardRows.map((c) => {
    const linked = debts.filter((d) => d.plaidAccountId === c.internalId);
    const answer = resolvePayoffMode(explicitPayoffMode(preferences, c.accountId), linked);
    return {
      ...answer,
      accountId: c.accountId,
      internalId: c.internalId,
      name: c.name,
      mask: c.mask,
      cadence: roster.cadenceFor(c.accountId),
      effectiveMode: answer.mode ?? "in_full",
      linkedDebtIds: linked.map((d) => d.id),
    };
  });
}

/** The cadences of the household's active hooks (an active, non-income item). */
export async function activeHookCadences(ownerUserId: string, preferences?: unknown): Promise<HookCadence[]> {
  let prefs = preferences;
  if (prefs === undefined) {
    const [s] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerUserId));
    prefs = s?.preferences ?? null;
  }
  const hooks = readEverydayHooks(prefs);
  const out: HookCadence[] = [];
  for (const [cadence, hook] of [
    ["weekly", hooks.weekly],
    ["monthly", hooks.monthly],
  ] as const) {
    if (!hook) continue;
    const [item] = await db
      .select({ active: recurringItemsTable.active, kind: recurringItemsTable.kind })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.id, hook.recurringItemId));
    if (item && item.active === "true" && item.kind !== "income") out.push(cadence);
  }
  return out;
}

/**
 * (F1) The debts whose `debt:` minimum the forecast and the Bills page leave
 * out, and which stay out of the avalanche simulation: those linked to a card
 * the owner set to `in_full` — and only when an active everyday hook of the
 * card's cadence exists to pay it (with no such hook the minimum stays: nothing
 * else on the forecast would pay the card). A DEFAULT in_full card has no
 * active debt (that is what makes it in_full), and an inactive debt already
 * emits no minimum and never enters the simulation — so only an explicit
 * choice can matter, and without one this answers the empty set without
 * reading the cards. With the obligations model off (`HOOK_OBLIGATIONS=off`)
 * the hooks do not bill such a card, so its minimum stays: the empty set.
 */
export async function loadInFullDebtIds(householdId: string, ownerUserId: string): Promise<Set<string>> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  return inFullDebtIdsFor(householdId, ownerUserId, s?.preferences ?? null);
}

/** `loadInFullDebtIds` for a caller that already read the owner's preferences. */
export async function inFullDebtIdsFor(householdId: string, ownerUserId: string, preferences: unknown): Promise<Set<string>> {
  if (!hookObligationsModelOn()) return new Set();
  const prefs = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : null;
  const map = prefs?.[PAYOFF_MODE_PREF];
  if (!map || typeof map !== "object" || !Object.values(map as Record<string, unknown>).includes("in_full")) return new Set();
  const cadences = await activeHookCadences(ownerUserId, prefs);
  if (cadences.length === 0) return new Set();
  const modes = await loadCardPayoffModes(householdId, ownerUserId, { preferences: prefs });
  return inFullDebtIdsOf(modes.filter((m) => cadences.includes(m.cadence)));
}

/** Every debt id linked to a card the owner (or the default) set to `in_full`. */
export function inFullDebtIdsOf(modes: readonly Pick<CardPayoffModeView, "mode" | "linkedDebtIds">[]): Set<string> {
  return new Set(modes.filter((m) => m.mode === "in_full").flatMap((m) => m.linkedDebtIds));
}

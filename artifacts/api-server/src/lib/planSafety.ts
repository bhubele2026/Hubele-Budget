// ⭐ (F1) THE PLAN GATE — a plan is never set while the forecast cannot size
// the card payments it moves.
//
// The bug (2026-10-14): with no weekly plan the Weekly Spend hook reserves its
// stored $450 every Saturday. Once a plan is set, the Saturday amount becomes the
// card's charges plus what is left of the plan — and before F1 "the card's
// charges" left out every card a debt row pointed at, even an ARCHIVED one,
// whose purchases were then paid by no forecast event at all. Setting a plan
// turned a real $450 card payment into $0 on the curve.
//
// So every path that writes a plan the hooks read refuses — 409
// `{ code: "plan_unsafe", reason }`, nothing written — while either holds:
//   - the corrected obligations model is not active (`hookObligationsActive`;
//     the env kill-switch `HOOK_OBLIGATIONS=off` turns it off);
//   - an Amex card a hook depends on (a card billed at the cadence of an active
//     hook) has no resolved payoff mode (`cardPayoffMode.ts`).
// A household with no active hook has nothing to protect: never refused.
//
// The paths (all of them):
//   POST /allowance-plans (the one-tap)       routes/money.ts
//   PUT  /allowance-plans/:id                 routes/money.ts
//   a weekly-limit proposal approved          lib/proposalApply.ts
//   PUT /settings changing the weekly/monthly allowance (mirrored into a plan)
//     or `preferences.weeklyAllowanceOverrides`   routes/settings.ts
//
// ⚠️ READ-ONLY.

import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { activeHookCadences, loadCardPayoffModes } from "./cardPayoffMode";
import { hookObligationsModelOn } from "./everydayHooks";

export { activeHookCadences };

export const PLAN_UNSAFE = "plan_unsafe" as const;

export type PlanGate = { ok: true } | { ok: false; code: typeof PLAN_UNSAFE; reason: string };

/**
 * Is the corrected obligations model the forecast's? Read per call, so a test
 * (or an operator) can flip `HOOK_OBLIGATIONS` without a restart:
 * `HOOK_OBLIGATIONS=off` puts the pre-F1 card-band model back on the forecast
 * AND holds this gate shut.
 */
export function hookObligationsActive(): boolean {
  return hookObligationsModelOn();
}

/** The plain reasons (short: the dialog shows them as they are). */
export const GATE_REASON = {
  modelOff: "Plans are paused: H2 cannot size the card payments safely right now.",
  unresolvedCard: (label: string) => `Plans are paused: choose how ${label} is paid — in full, or paying it down.`,
} as const;

/** "Amex Platinum ••2007" — the card as the reason names it. */
const cardLabel = (c: { name: string | null; mask: string | null }): string =>
  `${c.name?.trim() || "an Amex card"}${c.mask ? ` ••${c.mask}` : ""}`;

/**
 * ⭐ May a plan be written for this household now? See the file header.
 */
export async function planWriteGate(householdId: string, ownerUserId: string): Promise<PlanGate> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  const preferences = s?.preferences ?? null;
  const cadences = await activeHookCadences(ownerUserId, preferences);
  if (cadences.length === 0) return { ok: true };
  if (!hookObligationsActive()) return { ok: false, code: PLAN_UNSAFE, reason: GATE_REASON.modelOff };
  const modes = await loadCardPayoffModes(householdId, ownerUserId, { preferences });
  const open = modes.find((m) => m.mode == null && cadences.includes(m.cadence));
  if (open) return { ok: false, code: PLAN_UNSAFE, reason: GATE_REASON.unresolvedCard(cardLabel(open)) };
  return { ok: true };
}

/** The 409 body every refused path answers with. */
export function planUnsafeBody(gate: Extract<PlanGate, { ok: false }>): { error: string; code: typeof PLAN_UNSAFE; reason: string } {
  return { error: gate.reason, code: gate.code, reason: gate.reason };
}

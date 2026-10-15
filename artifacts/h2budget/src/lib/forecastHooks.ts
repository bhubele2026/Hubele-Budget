import type { CashSignal } from "@workspace/api-client-react";

/**
 * ⭐ (WP8) THE EVERYDAY HOOKS ON THE FORECAST REGISTER — what the curve really
 * takes out for a Weekly / Monthly Spend occurrence. Display only. Pure.
 *
 * The register lists a hook item at its STORED amount (the plan, e.g. $450),
 * but the curve pays the card payoff in its place: the period's card charges
 * plus what is left of the allowance (`everydayHooks.ts`, the cash signal's
 * events), and an occurrence a bank payment covered leaves the curve
 * (`overdueAssumedPaid`, `card_payment`). Each register row of a hook item
 * says both, in the dashboard's words: "card payoff $477.57 · plan $450", or
 * "paid on evidence by AMERICAN EXPRESS ACH PMT".
 *
 * ⚠️ The register's running balance still walks the stored amount — whether it
 * should walk the payoff is the owner's open decision (plan, WP8 label (v)).
 * Nothing here moves a figure.
 */
export interface HookPayoffLine {
  /** `<itemId>|<occurrenceDate>`: the register row it belongs to. */
  planKey: string;
  cadence: "weekly" | "monthly";
  /** The item's stored amount — the plan the curve ignores. Unsigned. */
  plan: number;
  /** What the curve takes out for the occurrence (the card payoff), or null when it is not on the curve. Unsigned. */
  payoff: number | null;
  /** The bank row that paid it, when the forecast counts it paid on that evidence (and leaves it off the curve). */
  paidOnEvidence: { txnId: string; amount: number; description: string | null } | null;
  /**
   * (S2) What the server sized the occurrence from (`hookReserves[].basis`):
   * `plan` — the card's charges plus what is left of the allowance plan;
   * `stored_amount` — no plan is set for the period, so the item's own amount
   * is kept as a reserve (never a spending cap). Null when the signal does not say.
   */
  basis: "plan" | "stored_amount" | null;
  /** (S2) The hook item's name ("Weekly Spend"), when the signal names it. */
  label: string | null;
  /**
   * (F4) What the reserve is made of, the server's strings (`hookReserves[]`): card purchases
   * made (`incurred`), carried from an earlier unpaid period, and what is left to spend.
   * Null when the signal does not say.
   */
  parts: { incurred: string; carried: string; left: string } | null;
  /**
   * ⭐ (F5 round 2) The day this occurrence's unpaid card purchases land on the
   * forecast, with the later week that carries them (the server's
   * `hookReserves[].carriedTo`, placed by that week's curve event). Null when
   * nothing was carried on. A week answered "missed" whose purchases are still
   * owed is CARRIED, never missed.
   */
  carriedTo?: string | null;
  /** (F5 round 2) What is left of the period's allowance (`hookReserves[].allowanceLeft`); absent when the signal does not say. */
  left?: number | null;
}

/**
 * ⭐ (F5 round 2) What a hook row really is when the household answered it
 * "missed": its purchases moved to a later week (`carried`), or they are still
 * on the forecast (`still_owed`). Null: nothing owed — the answer stands.
 */
export function hookOwedStatus(line: HookPayoffLine | null | undefined): "carried" | "still_owed" | null {
  if (!line) return null;
  if (line.carriedTo) return "carried";
  return line.payoff != null && line.payoff > 0 ? "still_owed" : null;
}

type HookSignal = Pick<CashSignal, "events" | "hookAmountIgnored" | "overdueAssumedPaid" | "hookReserves">;

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "$450" for a round plan, "$451.20" otherwise — the dashboard's plan money. */
const planMoney = (n: number) => money(n).replace(/\.00$/, "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-15" → "Oct 15". */
const shortDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

export function hookPayoffsOf(
  signal: HookSignal | null | undefined,
  /** A bank row's description by id (the forecast bundle's rows), for the evidence line. */
  describe?: (txnId: string) => string | null | undefined,
): Map<string, HookPayoffLine> {
  const out = new Map<string, HookPayoffLine>();
  // (S2) Each occurrence's reserve, by plan key. A hook whose every occurrence
  // kept its stored amount (no plan set) is named only here, never in
  // `hookAmountIgnored` (its stored amount is not ignored).
  const reserves = new Map((signal?.hookReserves ?? []).map((r) => [r.planKey, r]));
  const hooks = new Map<string, { cadence: "weekly" | "monthly"; storedAmount: string }>();
  for (const r of signal?.hookReserves ?? []) {
    // (F1) A no-plan occurrence's `amount` is no longer always the stored amount
    // (a closed week reserves its unpaid purchases); the server says it apart.
    if (r.basis === "stored_amount" && !hooks.has(r.recurringItemId)) hooks.set(r.recurringItemId, { cadence: r.hook, storedAmount: r.storedAmount ?? r.amount });
  }
  for (const h of signal?.hookAmountIgnored ?? []) hooks.set(h.itemId, h);
  if (hooks.size === 0) return out;
  // (F5 round 2) Where each carrying occurrence lands on the curve (its event's date).
  const carrierDate = new Map<string, string>();
  for (const e of signal?.events ?? []) {
    if (!e.itemId || !hooks.has(e.itemId)) continue;
    const key = e.occurrenceKey ?? `${e.itemId}|${e.originalDate ?? e.date}`;
    if (!carrierDate.has(key)) carrierDate.set(key, e.date);
  }
  const lineFor = (itemId: string, planKey: string): HookPayoffLine => {
    let line = out.get(planKey);
    if (!line) {
      const h = hooks.get(itemId)!;
      const r = reserves.get(planKey);
      line = {
        planKey,
        cadence: h.cadence,
        plan: Math.abs(Number(h.storedAmount) || 0),
        payoff: null,
        paidOnEvidence: null,
        basis: r?.basis ?? null,
        label: r?.label || null,
        parts: r && r.basis === "plan" && r.incurred != null && r.allowanceLeft != null ? { incurred: r.incurred, carried: r.carried ?? "0.00", left: r.allowanceLeft } : null,
        ...(r?.carriedTo ? { carriedTo: carrierDate.get(`${itemId}|${r.carriedTo}`) ?? r.carriedTo } : {}),
        ...(r?.allowanceLeft != null && Number.isFinite(Number(r.allowanceLeft)) ? { left: Number(r.allowanceLeft) } : {}),
      };
      out.set(planKey, line);
    }
    return line;
  };
  for (const e of signal?.events ?? []) {
    if (!e.itemId || !hooks.has(e.itemId)) continue;
    const amount = Number(e.amount);
    if (!Number.isFinite(amount)) continue;
    const planKey = e.occurrenceKey ?? `${e.itemId}|${e.originalDate ?? e.date}`;
    const line = lineFor(e.itemId, planKey);
    line.payoff = Math.round(((line.payoff ?? 0) + Math.abs(amount)) * 100) / 100;
  }
  // (F5 round 2) A week whose unpaid purchases were carried on is off the curve
  // and paid by nothing: it gets a line too, so it never reads "missed".
  for (const r of signal?.hookReserves ?? []) {
    if (r.carriedTo && hooks.has(r.recurringItemId)) lineFor(r.recurringItemId, r.planKey);
  }
  for (const p of signal?.overdueAssumedPaid ?? []) {
    if (!hooks.has(p.itemId)) continue;
    const line = lineFor(p.itemId, p.planKey);
    line.paidOnEvidence = {
      txnId: p.txnId,
      amount: Math.abs(Number(p.txnAmount) || 0),
      description: describe?.(p.txnId)?.trim() || null,
    };
  }
  return out;
}

/**
 * "card payoff $477.57 · plan $450" — or, off the curve, "paid on evidence by <row>".
 * (S2) With no plan set for the period the occurrence is the item's stored
 * amount, a reserve and never a cap: "Weekly Spend reserve $380 · no weekly plan set".
 */
export function hookPayoffWords(line: HookPayoffLine): string {
  const noPlan = `no ${line.cadence} plan set`;
  // (F5 round 2) Carried on: the purchases are on a later day of the forecast.
  if (line.carriedTo) return `card purchases carried to ${shortDay(line.carriedTo)}`;
  if (line.paidOnEvidence && line.payoff != null && line.payoff > 0) {
    const by = line.paidOnEvidence.description ?? `a ${money(line.paidOnEvidence.amount)} card payment`;
    return `part paid by ${by} · ${money(line.payoff)} still owed`;
  }
  if (line.paidOnEvidence) {
    const by = line.paidOnEvidence.description ?? `a ${money(line.paidOnEvidence.amount)} card payment`;
    return line.basis === "stored_amount" ? `paid on evidence by ${by} · ${noPlan}` : `paid on evidence by ${by} · plan ${planMoney(line.plan)}`;
  }
  if (line.basis === "stored_amount") {
    // (F5 round 2) Nothing left to spend (a closed or answered week): what is on the forecast is card purchases.
    if (line.left === 0 && line.payoff != null && line.payoff > 0) return `card purchases ${money(line.payoff)} still owed`;
    return `${line.label ?? "Spend"} reserve ${planMoney(line.plan)} · ${noPlan}`;
  }
  // (F4) With a plan: the three things the reserve is made of, in the owner's words.
  if (line.parts) {
    const p = line.parts;
    const carried = Math.round(Number(p.carried) * 100) !== 0 ? ` (+ carried ${money(Number(p.carried))})` : "";
    return `${line.label ?? (line.cadence === "weekly" ? "Weekly Spend" : "Monthly Spend")}: card purchases ${money(Number(p.incurred))}${carried} + left to spend ${money(Number(p.left))}`;
  }
  return line.payoff === null
    ? `card payoff · plan ${planMoney(line.plan)}`
    : `card payoff ${money(line.payoff)} · plan ${planMoney(line.plan)}`;
}

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
}

type HookSignal = Pick<CashSignal, "events" | "hookAmountIgnored" | "overdueAssumedPaid">;

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "$450" for a round plan, "$451.20" otherwise — the dashboard's plan money. */
const planMoney = (n: number) => money(n).replace(/\.00$/, "");

export function hookPayoffsOf(
  signal: HookSignal | null | undefined,
  /** A bank row's description by id (the forecast bundle's rows), for the evidence line. */
  describe?: (txnId: string) => string | null | undefined,
): Map<string, HookPayoffLine> {
  const out = new Map<string, HookPayoffLine>();
  const hooks = new Map((signal?.hookAmountIgnored ?? []).map((h) => [h.itemId, h]));
  if (hooks.size === 0) return out;
  const lineFor = (itemId: string, planKey: string): HookPayoffLine => {
    let line = out.get(planKey);
    if (!line) {
      const h = hooks.get(itemId)!;
      line = { planKey, cadence: h.cadence, plan: Math.abs(Number(h.storedAmount) || 0), payoff: null, paidOnEvidence: null };
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

/** "card payoff $477.57 · plan $450" — or, off the curve, "paid on evidence by <row>". */
export function hookPayoffWords(line: HookPayoffLine): string {
  if (line.paidOnEvidence) {
    const by = line.paidOnEvidence.description ?? `a ${money(line.paidOnEvidence.amount)} card payment`;
    return `paid on evidence by ${by} · plan ${planMoney(line.plan)}`;
  }
  return line.payoff === null
    ? `card payoff · plan ${planMoney(line.plan)}`
    : `card payoff ${money(line.payoff)} · plan ${planMoney(line.plan)}`;
}

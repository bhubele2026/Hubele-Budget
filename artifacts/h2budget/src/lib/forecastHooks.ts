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
 *
 * ⭐ (C4) THE WORDS TIE TO THE ROW. Every line is keyed by the occurrence's OWN
 * key (`occurrenceKey`, else `<itemId>|<occurrenceDate>`), never by the day a
 * row is shown on: a moved or dragged occurrence reads its own reserve and
 * names its period ("October's Monthly Spend, due Nov 1"). The figures the
 * words add up (card purchases, carried, left to spend) sum to what the
 * forecast takes for the occurrence (`payoff`, its curve events), less a
 * partial answer's row, which the words then name ("$X paid by <row> · $Y
 * still owed"). Parts that do not add (already paid, the card's balance) are
 * named after the sum. When the row's own amount is not the forecast's (the
 * item's stored amount), the words say what the forecast takes. Words that
 * would not add up to the cent are never printed (`hookPayoffWords`' guard).
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
   * Null when the signal does not say. (C4) Both bases: with no plan, "left" is what is
   * left of the stored reserve.
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
  /** (C4) The day the occurrence lands on the forecast (its curve event), when that is not its own date: moved or dragged. */
  dueDate?: string;
  /** (C4) Payments allocated to its own purchases (`hookReserves[].paid`), when not zero. Already out of `incurred`. */
  paid?: number;
  /** (C4) Its own purchases the card's balance shows paid (`hookReserves[].cappedByBalance`), when not zero. Already out of `incurred`. */
  capped?: number;
  /**
   * (C4) A partial answer on the occurrence: the bank row that paid part of it
   * (`paid` unsigned, null when its amount is unknown). The curve takes the rest.
   */
  partial?: { paid: number | null; description: string | null };
  /**
   * (C5) No plan is set for this period or any later one of its cadence, and
   * the period is current or ahead: the row may offer "Set a weekly plan →".
   */
  planLink?: "week" | "month";
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

type HookSignal = Pick<CashSignal, "events" | "hookAmountIgnored" | "overdueAssumedPaid" | "hookReserves"> & { fromDate?: string };

/**
 * (C4) A register plan line, as the page's bundle builds it (`PlanLine`): read
 * only for a partial answer — the row that paid part of an occurrence.
 */
export interface HookPlanRow {
  itemId: string;
  date: string;
  originalDate?: string;
  status: string;
  paidAmount?: number | null;
  matchedTxnId?: string | null;
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "$450" for a round plan, "$451.20" otherwise — the dashboard's plan money. */
const planMoney = (n: number) => money(n).replace(/\.00$/, "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10-15" → "Oct 15". */
const shortDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
/** Whole cents of a server string or a number; null when it is not a number. */
const centsOf = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const positive = (v: string | number | null | undefined): number | undefined => {
  const c = centsOf(v);
  return c != null && c > 0 ? c / 100 : undefined;
};
const occurrenceDateOf = (planKey: string) => planKey.slice(planKey.lastIndexOf("|") + 1);

/**
 * ⭐ (C4) THE LINE FOR A REGISTER ROW, by the occurrence's own key: a moved
 * row's original date, never the day it is shown on.
 */
export function hookLineOf(
  lines: ReadonlyMap<string, HookPayoffLine> | null | undefined,
  row: { itemId: string; date: string; originalDate?: string | null },
): HookPayoffLine | undefined {
  return lines?.get(`${row.itemId}|${row.originalDate ?? row.date}`);
}

export function hookPayoffsOf(
  signal: HookSignal | null | undefined,
  /** A bank row's description by id (the forecast bundle's rows), for the evidence line. */
  describe?: (txnId: string) => string | null | undefined,
  /** (C4) The register's plan lines, for partial answers (the row that paid part of an occurrence). */
  plans?: readonly HookPlanRow[] | null,
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
  // (C4) The event's own occurrence key: `originalDate` is the moved-to day, never the key.
  const keyOf = (e: NonNullable<HookSignal["events"]>[number]) => e.occurrenceKey ?? `${e.itemId}|${e.occurrenceDate ?? e.originalDate ?? e.date}`;
  // (F5 round 2) Where each occurrence lands on the curve (its event's date).
  const carrierDate = new Map<string, string>();
  for (const e of signal?.events ?? []) {
    if (!e.itemId || !hooks.has(e.itemId)) continue;
    const key = keyOf(e);
    if (!carrierDate.has(key)) carrierDate.set(key, e.date);
  }
  // (C5) The latest occurrence of each cadence the server sized from a plan.
  const lastPlanned = new Map<string, string>();
  for (const r of signal?.hookReserves ?? []) {
    if (r.basis !== "plan") continue;
    const at = lastPlanned.get(r.hook);
    if (at === undefined || r.occurrenceDate > at) lastPlanned.set(r.hook, r.occurrenceDate);
  }
  // (C4) Partial answers, by the occurrence's own key.
  const partials = new Map<string, NonNullable<HookPayoffLine["partial"]>>();
  for (const p of plans ?? []) {
    if (p.status !== "partial" || !hooks.has(p.itemId)) continue;
    partials.set(`${p.itemId}|${p.originalDate ?? p.date}`, {
      paid: p.paidAmount != null && Number.isFinite(p.paidAmount) ? Math.abs(p.paidAmount) : null,
      description: (p.matchedTxnId ? describe?.(p.matchedTxnId)?.trim() : null) || null,
    });
  }
  const lineFor = (itemId: string, planKey: string): HookPayoffLine => {
    let line = out.get(planKey);
    if (!line) {
      const h = hooks.get(itemId)!;
      const r = reserves.get(planKey);
      const occurrenceDate = occurrenceDateOf(planKey);
      const due = carrierDate.get(planKey);
      const paid = positive(r?.paid);
      const capped = positive(r?.cappedByBalance);
      const partial = partials.get(planKey);
      const laterPlan = lastPlanned.get(h.cadence);
      line = {
        planKey,
        cadence: h.cadence,
        plan: Math.abs(Number(h.storedAmount) || 0),
        payoff: null,
        paidOnEvidence: null,
        basis: r?.basis ?? null,
        label: r?.label || null,
        parts: r && r.incurred != null && r.allowanceLeft != null ? { incurred: r.incurred, carried: r.carried ?? "0.00", left: r.allowanceLeft } : null,
        ...(r?.carriedTo ? { carriedTo: carrierDate.get(`${itemId}|${r.carriedTo}`) ?? r.carriedTo } : {}),
        ...(r?.allowanceLeft != null && Number.isFinite(Number(r.allowanceLeft)) ? { left: Number(r.allowanceLeft) } : {}),
        ...(due && due !== occurrenceDate ? { dueDate: due } : {}),
        ...(paid ? { paid } : {}),
        ...(capped ? { capped } : {}),
        ...(partial ? { partial } : {}),
        ...(r?.basis === "stored_amount" &&
        (laterPlan === undefined || laterPlan < occurrenceDate) &&
        (signal?.fromDate === undefined || occurrenceDate >= signal.fromDate)
          ? { planLink: h.cadence === "weekly" ? ("week" as const) : ("month" as const) }
          : {}),
      };
      out.set(planKey, line);
    }
    return line;
  };
  for (const e of signal?.events ?? []) {
    if (!e.itemId || !hooks.has(e.itemId)) continue;
    const amount = Number(e.amount);
    if (!Number.isFinite(amount)) continue;
    const line = lineFor(e.itemId, keyOf(e));
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

/** (C4) "October's Monthly Spend" / "Weekly Spend of Oct 10": the occurrence's own period. */
function periodName(line: HookPayoffLine, name: string): string {
  const occ = occurrenceDateOf(line.planKey);
  if (line.cadence === "monthly") return `${MONTHS_LONG[Number(occ.slice(5, 7)) - 1]}'s ${name}`;
  return `${name} of ${shortDay(occ)}`;
}

/**
 * "card payoff $477.57 · plan $450" — or, off the curve, "paid on evidence by <row>".
 * (S2) With no plan set for the period the occurrence is the item's stored
 * amount, a reserve and never a cap: "Weekly Spend reserve $380 · no weekly plan set".
 *
 * ⭐ (C4) `face`: the amount the row itself shows (unsigned) — the item's stored
 * amount on the register. When the forecast takes something else, the words
 * say what it takes ("= $30.80 on the forecast"), and with a plan that the
 * item's amount is not used. The parts printed always add up to the forecast's
 * figure, to the cent; when the server's parts do not, only the figure is said.
 */
export function hookPayoffWords(line: HookPayoffLine, opts: { face?: number | null } = {}): string {
  const noPlan = `no ${line.cadence} plan set`;
  // (F5 round 2) Carried on: the purchases are on a later day of the forecast.
  if (line.carriedTo) return `card purchases carried to ${shortDay(line.carriedTo)}`;
  const name = line.label ?? (line.cadence === "weekly" ? "Weekly Spend" : "Monthly Spend");
  // (C4) Moved or dragged: the row's own period, and the day the forecast takes it.
  const where = line.dueDate ? `${periodName(line, name)}, due ${shortDay(line.dueDate)}` : null;
  const lead = (s: string) => (where ? `${where}: ${s}` : s);
  const T = line.payoff;
  const faceDiffers = opts.face != null && T != null && centsOf(opts.face) !== centsOf(T);
  // With a plan the item's stored amount is never read: say so when the row shows it.
  const itemNote = faceDiffers && line.basis === "plan" ? ` (item amount ${planMoney(line.plan)} not used)` : "";
  if (line.paidOnEvidence && T != null && T > 0) {
    const by = line.paidOnEvidence.description ?? `a ${money(line.paidOnEvidence.amount)} card payment`;
    return lead(`part paid by ${by} · ${money(T)} still owed`) + itemNote;
  }
  if (line.paidOnEvidence) {
    const by = line.paidOnEvidence.description ?? `a ${money(line.paidOnEvidence.amount)} card payment`;
    return line.basis === "stored_amount" ? `paid on evidence by ${by} · ${noPlan}` : `paid on evidence by ${by} · plan ${planMoney(line.plan)}`;
  }
  // (C4) The parts, in cents, and whether they add up to what the forecast takes.
  const p = line.parts;
  const I = p ? centsOf(p.incurred) : null;
  const C = p ? (centsOf(p.carried) ?? 0) : 0;
  const L = p ? centsOf(p.left) : null;
  const part = line.partial;
  const partPaid = part?.paid != null ? Math.round(part.paid * 100) : null;
  const sumKnown = I != null && L != null;
  const ties = sumKnown && T != null && I + C + L - (part ? (partPaid ?? Number.NaN) : 0) === centsOf(T);
  const sumWords = () =>
    `card purchases ${money(I! / 100)}${C !== 0 ? ` (+ carried ${money(C / 100)})` : ""} + left to spend ${money(L! / 100)}`;
  const partialWords = () => {
    if (!part) return "";
    const by = part.description ?? "a bank row";
    return ` · ${part.paid != null ? `${money(part.paid)} ` : ""}paid by ${by} · ${money(T ?? 0)} still owed`;
  };
  // Non-adding parts: already out of "card purchases".
  const notes = `${line.paid ? ` · ${money(line.paid)} already paid` : ""}${line.capped ? ` · ${money(line.capped)} paid per the card's balance` : ""}`;
  const total = !part && faceDiffers && T != null ? ` = ${money(T)} on the forecast` : "";

  if (line.basis === "stored_amount") {
    // (F5 round 2) Nothing left to spend (a closed or answered week): what is on the forecast is card purchases.
    if (!part && line.left === 0 && T != null && T > 0 && (!sumKnown || ties)) return lead(`card purchases ${money(T)} still owed`) + notes;
    // The plain reserve: the forecast holds exactly the item's amount.
    const plain = !part && T != null && centsOf(T) === centsOf(line.plan) && C === 0 && !line.paid && !line.capped;
    if (plain || T == null) return where ? `${where}: reserve ${planMoney(line.plan)} · ${noPlan}` : `${name} reserve ${planMoney(line.plan)} · ${noPlan}`;
    const head = where ?? `${name} reserve`;
    if (ties) return `${head}: ${sumWords()}${total}${partialWords()}${notes} · ${noPlan}`;
    // (C4) The guard: parts that do not add up are never printed.
    return part
      ? `${head}: part paid by ${part.description ?? "a bank row"} · ${money(T)} still owed · ${noPlan}`
      : `${head}: ${money(T)} on the forecast · ${noPlan}`;
  }
  // (F4) With a plan: the three things the reserve is made of, in the owner's words.
  if (p) {
    if (T == null) return `${where ?? name}: ${sumWords()}`;
    if (ties) return `${where ?? name}: ${sumWords()}${total}${partialWords()}${notes}${itemNote}`;
    // (C4) The guard: parts that do not add up are never printed.
    return part
      ? `${where ?? name}: part paid by ${part.description ?? "a bank row"} · ${money(T)} still owed${itemNote}`
      : `${where ?? name}: ${money(T)} on the forecast${itemNote}`;
  }
  return lead(
    T === null ? `card payoff · plan ${planMoney(line.plan)}` : `card payoff ${money(T)} · plan ${planMoney(line.plan)}`,
  );
}

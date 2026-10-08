import type { BillsSummary, Spine } from "@workspace/api-client-react";
import { addDaysISO } from "@workspace/avalanche-core/householdTime";
import { ACTION_TITLE_MAX } from "@/kit/ActionCard";
import { fmtMoney, toAmount } from "@/lib/money";

/**
 * ⭐ THE ONE THING, CHOSEN IN A FIXED ORDER — first match wins; "Next" walks on
 * to the next match. Pure: the same inputs always name the same item, and
 * nothing here persists (the cycle is UI state).
 *
 *   1. the bank needs reconnecting   2. the bank balance is old
 *   3. over the week's limit         4. a bill is due today or tomorrow
 *   5. charges need a look           6. nothing
 *
 * "Over" is a fact to know, not a failing to answer for: no scold.
 */
export type AttentionKind = "reconnect" | "stale" | "over" | "bill" | "review" | "nothing";

export interface Attention {
  kind: AttentionKind;
  title: string;
  detail?: string;
  action?: { label: string; href: string };
}

export interface DueBill {
  name: string;
  amount: number | null;
  dueOn: string;
}

/** Every bill and debt minimum whose next occurrence is on or after `today`, soonest first. */
export function upcomingBills(summary: BillsSummary | undefined, today: string): DueBill[] {
  if (!summary) return [];
  const rows: DueBill[] = [];
  for (const r of summary.bills) {
    if (r.item.active === "false" || !r.nextOccurrence) continue;
    rows.push({ name: r.item.name, amount: toAmount(r.item.amount), dueOn: r.nextOccurrence.slice(0, 10) });
  }
  for (const d of summary.debtMins) {
    if (!d.nextOccurrence) continue;
    rows.push({ name: d.debtName, amount: toAmount(d.minPayment), dueOn: d.nextOccurrence.slice(0, 10) });
  }
  return rows.filter((r) => r.dueOn >= today).sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
}

/** What `GET /bills/summary` says lands today or tomorrow. */
export function billsDueSoon(summary: BillsSummary | undefined, today: string): DueBill[] {
  const tomorrow = addDaysISO(today, 1);
  return upcomingBills(summary, today).filter((b) => b.dueOn === today || b.dueOn === tomorrow);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function attentionItems(i: {
  bank: Spine["bank"] | undefined;
  withinPlan: "yes" | "tight" | "over" | null | undefined;
  /** How far over the week's limit, in dollars, when over. */
  overBy: number | null;
  dueSoon: DueBill[];
  today: string;
  reviewCount: number;
}): Attention[] {
  const out: Attention[] = [];
  if (i.bank?.staleReason === "refresh_failed") {
    // The spine does not name the bank, so neither does the card.
    out.push({
      kind: "reconnect",
      title: "Reconnect your bank",
      detail: "The last sync did not go through.",
      action: { label: "Reconnect", href: "/household" },
    });
  }
  if (i.bank?.stale && i.bank.staleReason === "old") {
    out.push({
      kind: "stale",
      title: "The bank balance is out of date",
      action: { label: "Sync", href: "/household" },
    });
  }
  if (i.withinPlan === "over") {
    const by = i.overBy != null && i.overBy > 0 ? ` by ${fmtMoney(i.overBy)}` : "";
    out.push({
      kind: "over",
      title: `You're over this week${by}`,
      detail: "Nothing to decide. Just know it.",
    });
  }
  if (i.dueSoon.length > 0) {
    const first = i.dueSoon[0]!;
    const when = first.dueOn === i.today ? "today" : "tomorrow";
    const title =
      i.dueSoon.length === 1
        ? `${clip(first.name, 24)}${first.amount != null ? ` ${fmtMoney(first.amount)}` : ""} is due ${when}`
        : `${i.dueSoon.length} bills are due today or tomorrow`;
    out.push({ kind: "bill", title, action: { label: "See bills", href: "/classic/bills/all" } });
  }
  if (i.reviewCount > 0) {
    out.push({
      kind: "review",
      title: i.reviewCount === 1 ? "1 charge needs a look" : `${i.reviewCount} charges need a look`,
      action: { label: "Open review", href: "/activity/review" },
    });
  }
  if (out.length === 0) out.push({ kind: "nothing", title: "Nothing needs you today" });
  return out.map((a) => ({ ...a, title: clip(a.title, ACTION_TITLE_MAX) }));
}

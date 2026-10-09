import type { BillsSummary, Spine } from "@workspace/api-client-react";
import { addDaysISO } from "@/lib/householdDay";
import { formatCurrency } from "@/lib/utils";

/**
 * The one thing that needs the household, chosen in a fixed order: first match
 * wins. Pure: the same inputs always name the same item. Ported from the
 * frozen h2 app's `screens/today/attention.ts` (logic copied, not imported).
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
  /** (F7) The card offers "Pick a way back" (a sheet) instead of only a link. */
  wayBack?: boolean;
}

export interface DueBill {
  name: string;
  amount: number | null;
  dueOn: string;
}

export const ATTENTION_TITLE_MAX = 60;

function toAmount(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
  /** Banks whose saved login expired (Plaid re-auth), by name. The checking
   *  feed's own failure is `bank.staleReason`; a CARD's bank needing a new
   *  login is just as much a reconnect — new charges stop coming in. */
  reauthBanks?: readonly string[];
}): Attention[] {
  const out: Attention[] = [];
  const reauth = [...new Set(i.reauthBanks ?? [])];
  if (i.bank?.staleReason === "refresh_failed") {
    out.push({
      kind: "reconnect",
      title: "Reconnect your bank",
      detail: reauth.length ? `The last sync did not go through. Also needs a new login: ${reauth.join(", ")}.` : "The last sync did not go through.",
      action: { label: "Reconnect", href: "/settings" },
    });
  } else if (reauth.length) {
    out.push({
      kind: "reconnect",
      title: `Reconnect ${reauth.join(" and ")}`,
      detail: "The saved login expired, so new transactions are not coming in.",
      action: { label: "Reconnect", href: "/settings" },
    });
  }
  if (i.bank?.stale && i.bank.staleReason === "old") {
    out.push({
      kind: "stale",
      title: "The bank balance is out of date",
      action: { label: "Sync", href: "/settings" },
    });
  }
  if (i.withinPlan === "over") {
    const by = i.overBy != null && i.overBy > 0 ? ` by ${formatCurrency(i.overBy)}` : "";
    out.push({
      kind: "over",
      title: `Over this week's limit${by}`,
      detail: "Pick a way back. No lecture.",
      action: { label: "See allowances", href: "/allowances" },
      wayBack: true,
    });
  }
  if (i.dueSoon.length > 0) {
    const first = i.dueSoon[0]!;
    const when = first.dueOn === i.today ? "today" : "tomorrow";
    const title =
      i.dueSoon.length === 1
        ? `${clip(first.name, 24)}${first.amount != null ? ` ${formatCurrency(first.amount)}` : ""} is due ${when}`
        : `${i.dueSoon.length} bills are due today or tomorrow`;
    out.push({ kind: "bill", title, action: { label: "See bills", href: "/bills" } });
  }
  if (i.reviewCount > 0) {
    out.push({
      kind: "review",
      title: i.reviewCount === 1 ? "1 charge needs a look" : `${i.reviewCount} charges need a look`,
      action: { label: "Open review", href: "/review" },
    });
  }
  if (out.length === 0) out.push({ kind: "nothing", title: "Nothing needs you today" });
  return out.map((a) => ({ ...a, title: clip(a.title, ATTENTION_TITLE_MAX) }));
}

/**
 * The dashboard header's ONE action, chosen by the same priority as the list
 * above: the first item that needs a household decision wins. A failed bank
 * connection asks for Reconnect; a week over its plan offers "Pick a way
 * back". Anything else (an old balance, a bill due, charges to match) has its
 * own row in Needs attention and the account list's per-bank Sync, so the
 * header keeps the everyday question: "Can we afford something?". Pure.
 */
export type HeaderAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "reconnect"; label: string; href: string }
  | { kind: "wayBack" }
  | { kind: "afford" };

/** With no bank linked at all there is nothing to afford against yet: the one
 *  action is the app's existing link path (Settings › Banks, Link a bank). */
export function headerActionOf(items: readonly Attention[], opts: { noBank?: boolean } = {}): HeaderAction {
  if (opts.noBank) return { kind: "link", label: "Link a bank", href: "/settings" };
  for (const a of items) {
    if (a.kind === "reconnect") return { kind: "reconnect", label: a.action?.label ?? "Reconnect", href: a.action?.href ?? "/settings" };
    if (a.kind === "over" && a.wayBack) return { kind: "wayBack" };
  }
  return { kind: "afford" };
}

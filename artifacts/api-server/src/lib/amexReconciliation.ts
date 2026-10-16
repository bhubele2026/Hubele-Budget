// ⭐ (Task 5) THE AMEX PURCHASES, PARTITIONED — `AmexSummary.reconciliation`.
//
// The owner's Spending week read "Amex purchases $X · counted $Y · not counted
// $Z" and the three did not add up: the line left out what the cards filed to
// the MONTHLY allowance (and every purchase outside the two plans). This puts
// every purchase the summary counts (`purchaseRows`, exactly the `purchases`
// tally) in ONE group, so the groups add up to the purchases to the cent.
//
// No rule of its own. Each purchase's group comes from what the summary
// already read for it:
//   - the household window's placement (`classifyMovement` coverage, via the
//     row's `allowanceRowOf` — the read `householdContribution` sums);
//   - inside the weekly and monthly plans (`breakdownCountedCoverages`), the
//     F2 evidence class (`isUnresolvedInPool`, the very test
//     `evidenceSplitCents` splits known / unresolved with).
//
//   weekly_known · weekly_unresolved   allowance_weekly / needs_classification
//   monthly_known · monthly_unresolved allowance_monthly
//   bills                              bill_matched
//   unplanned · reimbursable           their coverage
//   not_counted                        any other placement (transfer, excluded
//                                      category, debt or card payment, income)
//   no_bucket                          a purchase the window did not place
//
// Refunds are NOT in the partition: they are reported beside it (`net` =
// purchases − refunds). ⚠️ So a plan group equals its `householdContribution`
// figure only while that plan holds nothing but these purchases: the
// contribution also nets a card's refunds into the plan they belong to (B6)
// and reads rows the payoff leaves out ("not mine"). The review note
// (docs/reviews/2026-10-16-f-amex-recon.md) works both cases.
//
// Pure. Read-only.

import { breakdownCountedCoverages, isUnresolvedInPool, type EvidenceSplitRow } from "@workspace/avalanche-core";

export type AmexReconciliationKey =
  | "weekly_known"
  | "weekly_unresolved"
  | "monthly_known"
  | "monthly_unresolved"
  | "bills"
  | "unplanned"
  | "reimbursable"
  | "not_counted"
  | "no_bucket";

/** The groups, in the order every reader lists them, with their words. */
export const AMEX_RECONCILIATION_GROUPS: ReadonlyArray<{ key: AmexReconciliationKey; label: string }> = [
  { key: "weekly_known", label: "This week's plan" },
  { key: "weekly_unresolved", label: "This week's plan, awaiting a decision" },
  { key: "monthly_known", label: "Monthly allowance" },
  { key: "monthly_unresolved", label: "Monthly allowance, awaiting a decision" },
  { key: "bills", label: "Bills" },
  { key: "unplanned", label: "Unplanned" },
  { key: "reimbursable", label: "Reimbursable" },
  { key: "not_counted", label: "Not counted" },
  { key: "no_bucket", label: "Not placed" },
];

/** What a row says beside its group: flags that are not groups. */
export type AmexReconciliationNote = "not_filed" | "no_category" | "pending";

/** One purchase as the partition reads it: the summary's own facts for it. */
export interface AmexReconciliationInput {
  id: string;
  date: string;
  displayName: string;
  /** The purchase, positive cents (`spendAmount`). */
  cents: number;
  pending: boolean;
  card: { accountId: string; name: string; mask: string | null };
  /** Filed under a real category (the summary's needsAttention test). */
  hasCategory: boolean;
  /** The window's placement (the row's `allowanceRowOf` and evidence class); null = not placed. */
  placed: EvidenceSplitRow | null;
}

const WEEK_POOL: ReadonlySet<string> = new Set(breakdownCountedCoverages("week"));
const MONTH_POOL: ReadonlySet<string> = new Set(breakdownCountedCoverages("month"));

/** The one group a purchase is in. */
export function reconciliationKeyOf(placed: EvidenceSplitRow | null): AmexReconciliationKey {
  if (!placed) return "no_bucket";
  const c = placed.allowance.coverage;
  if (WEEK_POOL.has(c)) return isUnresolvedInPool("week", placed) ? "weekly_unresolved" : "weekly_known";
  if (MONTH_POOL.has(c)) return isUnresolvedInPool("month", placed) ? "monthly_unresolved" : "monthly_known";
  if (c === "bill_matched") return "bills";
  if (c === "unplanned") return "unplanned";
  if (c === "reimbursable") return "reimbursable";
  return "not_counted";
}

function notesOf(p: AmexReconciliationInput): AmexReconciliationNote[] {
  const notes: AmexReconciliationNote[] = [];
  if (p.placed?.allowance.coverage === "needs_classification") notes.push("not_filed");
  if (!p.hasCategory) notes.push("no_category");
  if (p.pending) notes.push("pending");
  return notes;
}

const money = (cents: number): string => (cents / 100).toFixed(2);

/** Largest first, then newest, then id: the summary's own row order. */
const byAmount = (a: AmexReconciliationInput, b: AmexReconciliationInput): number =>
  b.cents - a.cents || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || a.id.localeCompare(b.id);

/**
 * ⭐ The partition. `purchases` is the summary's `purchases` tally (the same
 * rows), `refunds` its `refunds` tally; `rowsPerGroup` bounds each group's
 * list (its amount and count still cover every row).
 */
export function reconcileAmexPurchases(
  rows: readonly AmexReconciliationInput[],
  totals: { purchases: { cents: number; count: number }; refunds: { cents: number; count: number } },
  rowsPerGroup: number,
) {
  const byKey = new Map<AmexReconciliationKey, AmexReconciliationInput[]>(AMEX_RECONCILIATION_GROUPS.map((g) => [g.key, []]));
  for (const r of rows) byKey.get(reconciliationKeyOf(r.placed))!.push(r);
  const centsOf = new Map<AmexReconciliationKey, number>();
  const groups = AMEX_RECONCILIATION_GROUPS.map(({ key, label }) => {
    const list = [...byKey.get(key)!].sort(byAmount);
    const cents = list.reduce((a, r) => a + r.cents, 0);
    centsOf.set(key, cents);
    return {
      key,
      label,
      amount: money(cents),
      count: list.length,
      rows: list.slice(0, rowsPerGroup).map((r) => ({
        id: r.id,
        date: r.date,
        displayName: r.displayName,
        amount: money(r.cents),
        pending: r.pending,
        card: r.card,
        notes: notesOf(r),
      })),
      truncated: list.length > rowsPerGroup,
    };
  });
  const sumCents = [...centsOf.values()].reduce((a, c) => a + c, 0);
  const sumCount = groups.reduce((a, g) => a + g.count, 0);
  const unresolvedKeys: AmexReconciliationKey[] = ["weekly_unresolved", "monthly_unresolved"];
  return {
    purchases: { amount: money(totals.purchases.cents), count: totals.purchases.count },
    refunds: { amount: money(totals.refunds.cents), count: totals.refunds.count },
    net: money(totals.purchases.cents - totals.refunds.cents),
    // "Awaiting a decision": the two plans' unresolved groups together.
    unresolved: {
      amount: money(unresolvedKeys.reduce((a, k) => a + centsOf.get(k)!, 0)),
      count: unresolvedKeys.reduce((a, k) => a + byKey.get(k)!.length, 0),
    },
    ties: sumCents === totals.purchases.cents && sumCount === totals.purchases.count,
    groups,
  };
}

import type { LedgerFilter, LedgerPage, LedgerRow } from "@workspace/api-client-react";
import type { GetTransactionsLedgerParams } from "@workspace/api-client-react/ledger";

/**
 * ⭐ PR14 — THE CHASE LIST READS THE SERVER'S LEDGER. Pure helpers only.
 *
 * The page used to pull 1,000 rows and scope, total and balance them in the
 * browser. The server now settles all of that (GET /transactions/ledger); this
 * file only turns the page's choices into the ledger's filter, and the pages
 * that come back into one list.
 *
 * ⚠️ One filter, two spellings. The list asks with query strings ("true" /
 * "false") and bulk review sends booleans. Both come from `ChaseListFilter`, so
 * "Select all 260 matching" marks exactly the rows the list counted.
 */

/** Rows per ledger request. CLAUDE.md §2: a list view asks for 100 or fewer. */
export const LEDGER_PAGE_SIZE = 50;
/** The server refuses to review more than this many rows by filter (400). */
export const BULK_REVIEW_MAX = 1000;
/** Ledger rows only change on a Sync or an edit, and every write invalidates them. */
export const LEDGER_CACHE = { staleTime: 2 * 60_000, gcTime: 30 * 60_000 } as const;

export type ChaseListFilter = {
  account?: string;
  from?: string;
  to?: string;
  pending?: boolean;
  /** `false` lists only rows not yet reviewed ("Clear reviewed from list"). */
  reviewed?: boolean;
  categoryId?: string;
  uncategorized?: boolean;
};

const bool = (v: boolean | undefined) => (v === undefined ? undefined : v ? "true" : "false");

/** The list's query: strings for the booleans, and the page size. */
export function toLedgerParams(f: ChaseListFilter): GetTransactionsLedgerParams {
  const p: GetTransactionsLedgerParams = { limit: LEDGER_PAGE_SIZE };
  if (f.account) p.account = f.account;
  if (f.from) p.from = f.from;
  if (f.to) p.to = f.to;
  if (f.pending !== undefined) p.pending = bool(f.pending);
  if (f.reviewed !== undefined) p.reviewed = bool(f.reviewed);
  if (f.categoryId) p.categoryId = f.categoryId;
  if (f.uncategorized) p.uncategorized = "true";
  return p;
}

/** The same filter for POST /transactions/bulk-review-matching. Unset keys are left out. */
export function toBulkFilter(f: ChaseListFilter): LedgerFilter {
  const out: LedgerFilter = {};
  if (f.account) out.account = f.account;
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.pending !== undefined) out.pending = f.pending;
  if (f.reviewed !== undefined) out.reviewed = f.reviewed;
  if (f.categoryId) out.categoryId = f.categoryId;
  if (f.uncategorized) out.uncategorized = true;
  return out;
}

/** Calendar arithmetic on YYYY-MM-DD, at noon UTC so no zone moves the day. */
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Split the viewed range at the household's today.
 *
 * ⚠️ The register never asks past today. The ledger's totals over a range that
 * reaches past today can count a charge twice among rows dated after today
 * (PR13 note, "After today"), and no balance exists after today. So the list,
 * its totals and its balances cover `from`..today, and the days after today are
 * asked for apart: listed and labelled, never totalled.
 */
export function splitAtToday(
  range: { from: string; to: string },
  today: string,
): {
  register: { from: string; to: string } | null;
  after: { from: string; to: string } | null;
} {
  if (range.from > today) return { register: null, after: { from: range.from, to: range.to } };
  const register = { from: range.from, to: range.to < today ? range.to : today };
  const after = range.to > today ? { from: addDaysISO(today, 1), to: range.to } : null;
  return { register, after };
}

/**
 * The loaded pages as one list, in the server's order. A row the cursor hands
 * back twice (its sort key changed between pages) is listed once.
 */
export function flattenLedgerPages(pages: readonly LedgerPage[] | undefined): LedgerRow[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: LedgerRow[] = [];
  for (const page of pages) {
    for (const row of page.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

/** Money the server may not have: a number, or null. Never a made-up 0. */
export function moneyOrNull(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * (PR14 review M1) What a row adds to a day or group total: what the ledger
 * moves the register by (a mask-twin, duplicate or replaced row adds 0), so a
 * day's total reconciles with the card. On an account with no register
 * (`balanceAmount` null) the row's amount when `countsInBalance`, else 0.
 */
export function countedAmount(
  row: Pick<LedgerRow, "amount" | "countsInBalance"> & { balanceAmount: string | null },
): number {
  if (row.balanceAmount != null) return Number(row.balanceAmount) || 0;
  return row.countsInBalance ? Number(row.amount) || 0 : 0;
}

/** The counted total of rows, summed in whole cents. */
export function sumCounted(
  rows: ReadonlyArray<Pick<LedgerRow, "amount" | "countsInBalance"> & { balanceAmount: string | null }>,
): number {
  let cents = 0;
  for (const r of rows) cents += Math.round(countedAmount(r) * 100);
  return cents / 100;
}

/** Up to `max` evenly spaced days from `from` to `to`, both ends included. */
export function sampleDays(from: string, to: string, max = 40): string[] {
  if (from > to) return [];
  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) days.push(d);
  if (days.length <= max) return days;
  const step = Math.ceil(days.length / max);
  const picked = days.filter((_, i) => i % step === 0);
  if (picked[picked.length - 1] !== to) picked.push(to);
  return picked;
}

/** The server takes at most this many dates per GET /transactions/balances. */
export const BALANCE_DATES_MAX = 120;

/** Sorted, unique, and capped at what the balances endpoint accepts (newest kept). */
export function balanceDates(...lists: string[][]): string[] {
  const all = Array.from(new Set(lists.flat())).sort();
  return all.length > BALANCE_DATES_MAX ? all.slice(all.length - BALANCE_DATES_MAX) : all;
}

/**
 * The words for a row the balance treats specially. Status is never colour
 * alone: each label says the state, and its title says why.
 */
export function ledgerRowLabels(
  row: Pick<LedgerRow, "afterToday" | "heldAhead" | "stalePending" | "countsInBalance" | "balanceReason">,
): Array<{ key: string; label: string; title: string }> {
  const out: Array<{ key: string; label: string; title: string }> = [];
  if (row.afterToday) {
    out.push({
      key: "after-today",
      label: "After today",
      title: "Dated after today. Not in the totals, and no balance yet.",
    });
  }
  if (row.stalePending) {
    out.push({
      key: "stale-pending",
      label: "Pending 14+ days",
      title: "Still pending after 14 days. It may have posted as another row.",
    });
  }
  if (row.heldAhead) {
    out.push({
      key: "held-ahead",
      label: "Already in balance",
      title: "The bank balance already includes this row, though it is dated after that balance was read.",
    });
  }
  if (!row.countsInBalance) {
    const why =
      row.balanceReason === "superseded"
        ? "Replaced by its posted row."
        : row.balanceReason === "duplicate"
          ? "A second copy of another row."
          : row.balanceReason === "not_bank"
            ? "On a duplicate of this account; the bank balance does not read it."
            : "The bank balance does not count this row.";
    out.push({ key: "not-counted", label: "Not counted", title: why });
  }
  return out;
}

import { isBankRow } from "@workspace/avalanche-core";
import {
  resolveTxnAccount,
  type ResolvedTxnAccount,
  type TxnAccountEntry,
  type TxnAccountRef,
} from "./accountIdentity";
import { accountPageHref } from "./accountPage";
import { AMEX_SOURCES } from "./amexSources";

export { accountPageHref } from "./accountPage";

/**
 * ⭐ WHERE A TRANSACTION OPENS — the one route rule (WP7). Pure.
 *
 * Every list that links a row to "its" ledger asks here (the dashboard's Recent
 * activity and its income-in-an-expense-category row, the Accounts page's
 * combined view), so a row opens the page that actually lists it. Before, a row
 * with no linked account fell through to `/transactions` — the checking
 * account's ledger, where an Amex workbook row or a closed card's row is not —
 * and a row was linked without the day it is on.
 *
 * In order, a row:
 *   1. on a LINKED account (its external `plaidAccountId` matches an entry,
 *      `resolveTxnAccount`) opens that account's page: `/next/accounts/<ext>`;
 *   2. otherwise, from a source the American Express page lists
 *      (`AMEX_SOURCES`: the Amex workbook import, Plaid Amex and Apple Card rows)
 *      opens `/amex`, whose "All cards" view lists every such row — the workbook
 *      rows included, which no per-card view shows;
 *   3. otherwise, with no Plaid account, and on the bank ledger by the bank
 *      balance's own rule (`isBankRow`: a manual entry, any row whose source
 *      names no card) opens `/transactions`, the ledger that lists manual rows;
 *   4. otherwise opens nowhere (`href: null`) and says why: a Plaid row whose
 *      account is no longer linked is on no ledger H2 has.
 *
 * Each href carries `?tx=<row id>&month=<YYYY-MM-01>`: the row to open, and the
 * month it is in, so the ledger opens on the right page of history.
 */

/** What `txnRoute` reads from a transaction (a generated `Transaction` fits). */
export interface TxnRouteRef extends TxnAccountRef {
  id: string;
  /** The row's day, YYYY-MM-DD (a longer ISO string is read to its day). */
  occurredOn: string;
}

export type TxnRouteKind =
  /** A linked account's own page. */
  | "account"
  /** The American Express page, "All cards". */
  | "cards"
  /** The checking ledger, which lists manual rows. */
  | "bank"
  /** No ledger lists the row. */
  | "none";

export interface TxnRoute {
  kind: TxnRouteKind;
  /** Where the row opens; null when no ledger lists it. */
  href: string | null;
  /** Where it opens, in words ("Chase Total Checking ••4821", "Amex (imported) · All cards"). */
  label: string;
  /** Why it opens nowhere ("No ledger: Chase (no longer linked)"); null whenever `href` is set. */
  note: string | null;
  /** The account the row belongs to (`resolveTxnAccount`): what its chip says. */
  identity: ResolvedTxnAccount;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `tx=<id>&month=<YYYY-MM-01>`, then any extra params a caller keeps (e.g. `category`). */
function rowQuery(txn: TxnRouteRef, extra: Record<string, string | null | undefined>): string {
  const parts = [`tx=${encodeURIComponent(txn.id)}`];
  const day = (txn.occurredOn ?? "").slice(0, 10);
  if (ISO_DAY.test(day)) parts.push(`month=${day.slice(0, 7)}-01`);
  for (const [key, value] of Object.entries(extra)) {
    if (value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

function labelWithMask(identity: ResolvedTxnAccount): string {
  return identity.mask4 ? `${identity.label} ••${identity.mask4}` : identity.label;
}

export function txnRoute(
  txn: TxnRouteRef,
  entries: readonly TxnAccountEntry[] | ReadonlyMap<string, TxnAccountEntry>,
  opts: { extra?: Record<string, string | null | undefined> } = {},
): TxnRoute {
  const identity = resolveTxnAccount(txn, entries);
  const query = rowQuery(txn, opts.extra ?? {});
  const ext = (txn.plaidAccountId ?? "").trim();
  // 1. A linked account: its own page.
  if (identity.known) {
    return {
      kind: "account",
      href: `${accountPageHref({ plaidAccountId: ext })}?${query}`,
      label: labelWithMask(identity),
      note: null,
      identity,
    };
  }
  const source = (txn.source ?? "").trim().toLowerCase();
  // 2. A row the American Express page lists: its "All cards" view.
  if (AMEX_SOURCES.includes(source)) {
    return { kind: "cards", href: `/amex?${query}`, label: `${identity.label} · All cards`, note: null, identity };
  }
  // 3. A row with no Plaid account that the bank balance counts: the checking ledger.
  if (!ext && isBankRow(txn.source ?? null, null, null)) {
    return { kind: "bank", href: `/transactions?${query}`, label: "Checking ledger", note: null, identity };
  }
  // 4. On no ledger H2 has.
  return {
    kind: "none",
    href: null,
    label: identity.label,
    note: source.startsWith("plaid:") ? `No ledger: ${identity.label}` : "No ledger: its account is not linked",
    identity,
  };
}

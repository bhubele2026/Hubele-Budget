import type { CashSignalAccount, Spine } from "@workspace/api-client-react";
import { shortDate } from "@/components/next";
import { householdDayOfAt } from "@/lib/householdDay";
import { formatCurrency } from "@/lib/utils";

/**
 * ⭐ THE CHECKING BALANCE — ONE MODEL FOR EVERY SURFACE (WP1).
 *
 * The same checking account read two balances on two screens: the dashboard's
 * "$2,156.55" (the bank snapshot rolled forward through the ledger) beside the
 * account selector's "$3,458.98" (the raw Oct 2 snapshot, with no date). Both
 * were true; nothing said which was which. The spine now carries both halves
 * from the ledger that computed the balance (`bank.snapshot`, what rolled since
 * in `bank.sinceSnapshot`) and the account they belong to, with its ids. This
 * reads them, and computes nothing: every figure is a spine field.
 *
 *   - `balance`: the balance today (the snapshot rolled forward); null when
 *     there is no bank balance at all, which a screen says in words, never $0.
 *   - `snapshot`: the bank's own figure as read, when (`day`, the household
 *     day) and from where; null with no snapshot.
 *   - `since`: what the ledger added on top, through today (a real zero is
 *     `count: 0, net: "0.00"`); null when nothing rolls.
 *   - `account`: the account it all belongs to, with its ids; null when the
 *     server could not resolve one.
 * Freshness stays on the spine's own fields (`FreshnessLine bank={spine.bank}`).
 *
 * `snapshot.balance + since.net = balance` to the cent — the server's parity
 * test holds it, so no screen ever needs to add them up itself.
 */
export interface BankBalanceView {
  balance: string | null;
  snapshot: { balance: string; at: string; day: string; source: "plaid" | "manual" } | null;
  since: { net: string; count: number; through: string } | null;
  account: CashSignalAccount | null;
}

export function bankBalanceView(bank: Spine["bank"]): BankBalanceView {
  // `?? null`: a payload from before the spine carried these reads as "none".
  const snap = bank.snapshot ?? null;
  const acct = bank.account ?? null;
  return {
    balance: !bank.source && !bank.asOfDate ? null : bank.balance,
    snapshot: snap && { ...snap, day: householdDayOfAt(snap.at) },
    since: bank.sinceSnapshot ?? null,
    account: acct && acct.via !== "unresolved" ? acct : null,
  };
}

/** One account as a list knows it: its row id, its Plaid account_id, its mask. */
export type BankAccountKeys = { id?: string | null; accountId?: string | null; mask?: string | null };

/**
 * Is this the account the balance rolls forward on? BY ID: the row id or the
 * Plaid account_id the spine names. Matching by mask was the bug — `"" === ""`
 * made every account without a mask "the checking account", and two accounts
 * can share four digits. A mask decides only when the spine sent no id at all
 * (a payload from before the ids), it is not empty, and exactly one account in
 * `all` (which includes `acct`) carries it; anything else is "not this one".
 */
export function isSpineAccount(
  acct: BankAccountKeys,
  account: Pick<CashSignalAccount, "rowId" | "externalId" | "mask"> | null | undefined,
  all: readonly BankAccountKeys[],
): boolean {
  if (!account) return false;
  const { rowId, externalId, mask } = account;
  if (rowId || externalId) return (!!rowId && acct.id === rowId) || (!!externalId && acct.accountId === externalId);
  return !!mask && acct.mask === mask && all.filter((a) => a.mask === mask).length === 1;
}

/** "1 entry", "20 entries". */
export const entriesWord = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

/**
 * "Includes 2 entries since the Oct 5 snapshot": why the balance is not the
 * bank's figure. Null when nothing was added on top (or there is no snapshot).
 */
export function sinceSnapshotWords(v: BankBalanceView): string | null {
  const n = v.since?.count ?? 0;
  return v.snapshot && n > 0 ? `Includes ${entriesWord(n)} since the ${shortDate(v.snapshot.day)} snapshot` : null;
}

/**
 * "Snapshot $3,458.98 · Oct 2 · +20 entries": the bank's own figure, dated, for
 * a screen that shows it beside the balance today. Null with no snapshot.
 */
export function snapshotWords(v: BankBalanceView): string | null {
  const s = v.snapshot;
  if (!s) return null;
  const n = v.since?.count ?? 0;
  return `Snapshot ${formatCurrency(s.balance)} · ${shortDate(s.day)}${n > 0 ? ` · +${entriesWord(n)}` : ""}`;
}

import { formatCurrency } from "./utils";
import { dayOf } from "./accountFreshness";

/**
 * (WP3) ONE RULE for a depository account that is not the account the bank
 * balance rolls forward on (savings, a second checking account): it shows its
 * last balance READING (`PlaidAccount.snapshot`, from GET /plaid/items) and
 * says that it is not rolled forward — or says it is not tracked yet. Never
 * $0 for "no reading", never "Balance today" for a stale reading. The
 * dashboard row, the account chip and the account's Summary all read this.
 */
export interface SnapshotLike {
  balance: string;
  at: string;
}

export const NOT_TRACKED = {
  savings: "Savings balance is not tracked yet.",
  other: "Balance is not tracked for this account.",
} as const;

/** "as of Oct 6 · not rolled forward". */
export function snapshotCaption(s: SnapshotLike): string {
  const d = dayOf(s.at);
  return `${d ? `as of ${d} · ` : ""}not rolled forward`;
}

/** "Snapshot $3,100.00 · as of Oct 6 · not rolled forward". */
export function snapshotLine(s: SnapshotLike): string {
  return `Snapshot ${formatCurrency(s.balance)} · ${snapshotCaption(s)}`;
}

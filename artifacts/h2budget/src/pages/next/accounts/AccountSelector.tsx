import { Link } from "wouter";
import { cn, formatCurrency, formatRelativeTime } from "@/lib/utils";
import { AccountChip, shortDate } from "@/components/next";
import { accountPageHref } from "@/lib/accountRoute";
import { STATE_WORD, type AccountEntry } from "./entries";

/** Balance shown on a chip, already resolved by the page ("" = unknown). */
export type BalanceByRow = Record<string, string | undefined>;

const EDGE: Record<AccountEntry["identity"]["accent"], string> = {
  checking: "border-acct-checking",
  amex: "border-acct-amex",
  card2: "border-acct-card2",
  other: "border-acct-other",
};

const chipBase =
  "flex min-h-[44px] min-w-[11rem] flex-col justify-center gap-0.5 rounded-control border bg-white px-3 py-1.5 text-left " +
  "transition-colors duration-150 motion-reduce:transition-none hover:bg-platinum-1 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 active:translate-y-px motion-reduce:active:translate-y-0";

/** One chip per account. The selected one is `aria-current`; "All accounts" clears it. */
export function AccountSelector({
  entries, selectedId, balances,
}: { entries: AccountEntry[]; selectedId: string | null; balances: BalanceByRow }) {
  return (
    <nav aria-label="Accounts" data-testid="account-selector" className="flex gap-2 overflow-x-auto pb-1">
      <Link
        href="/next/accounts"
        aria-current={selectedId === null ? "page" : undefined}
        data-testid="account-chip-all"
        className={cn(chipBase, "border-brand-line", selectedId === null && "ring-2 ring-brand-navy/40")}
      >
        <span className="text-label font-semibold text-brand-navy">All accounts</span>
        <span className="text-micro text-neutral-500">Recent activity from every account</span>
      </Link>
      {entries.map((e) => {
        const bal = balances[e.rowId];
        const sel = e.plaidAccountId === selectedId;
        return (
          <Link
            key={e.rowId}
            href={accountPageHref(e)}
            aria-current={sel ? "page" : undefined}
            data-testid={`account-chip-${e.plaidAccountId}`}
            data-accent={e.identity.accent}
            className={cn(chipBase, "border-l-4", EDGE[e.identity.accent], sel && "ring-2 ring-brand-navy/40")}
          >
            <AccountChip identity={e.identity} />
            <span className="flex flex-wrap items-baseline gap-x-2 text-micro text-neutral-600">
              <span className="font-mono tabular-nums" data-testid="chip-balance">
                {e.identity.isCard ? "Owed " : "Balance "}
                {bal ? formatCurrency(bal) : "—"}
              </span>
              <span data-testid="chip-state" className={cn(e.state === "reconnect" || e.state === "problem" ? "text-status-bad font-medium" : "")}>
                {STATE_WORD[e.state]}
                {e.state === "synced" && e.lastSyncedAt ? ` ${formatRelativeTime(e.lastSyncedAt)}` : ""}
              </span>
              {e.dataThrough ? <span data-testid="chip-through">Data through {shortDate(e.dataThrough)}</span> : null}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { AccountChip } from "@/components/next";
import { freshnessStamps } from "@/lib/accountFreshness";
import { accountPageHref } from "@/lib/accountRoute";
import { STATE_WORD, type AccountEntry } from "./entries";

/**
 * What a chip says about its account's balance, resolved by the page from the
 * ONE card model (`lib/cardBalance.ts`) and the snapshot rule
 * (`lib/snapshotWords.ts`), so a chip and the dashboard row print the same
 * words for the same concept (WP3):
 *   - a card on the plan: "Owed" + the netted figure;
 *   - a card off the plan: its own current balance, and `plan` says so;
 *   - checking (the account the balance rolls forward on): "Balance" + the
 *     dashboard's figure, and `sub` = the bank snapshot under it ("Snapshot
 *     $3,458.98 · Oct 2 · +20 entries", WP1's `snapshotWords`);
 *   - savings and any other depository account: "Snapshot" + the reading +
 *     "as of <day> · not rolled forward", or only words when nothing has been read.
 * `null` figure and words = not known: an em dash, never $0.
 */
export interface ChipBalance {
  label: string | null;
  figure: string | null;
  words?: string | null;
  /** A second line under the figure (the checking account's bank snapshot). */
  sub?: string | null;
  plan?: string | null;
  /** When the balance on the chip was read (the "balance read" stamp). */
  balanceAt?: string | null;
}
export type BalanceByRow = Record<string, ChipBalance | undefined>;

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
  entries, selectedId, balances, now = Date.now(),
}: { entries: AccountEntry[]; selectedId: string | null; balances: BalanceByRow; now?: number }) {
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
        const b = balances[e.rowId];
        const sel = e.plaidAccountId === selectedId;
        // Three stamps, three moments (WP3): synced · balance read · data through.
        const stamps = freshnessStamps({ syncedAt: e.lastSyncedAt, balanceAt: b?.balanceAt, dataThrough: e.dataThrough }, now);
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
              <span data-testid="chip-balance">
                {b?.label ? `${b.label} ` : null}
                {b?.figure ? <span className="font-mono tabular-nums">{b.figure}</span> : b?.words ? null : "—"}
                {b?.words ? `${b.figure ? " · " : ""}${b.words}` : null}
              </span>
              {b?.plan ? <span className="font-medium" data-testid="chip-plan">{b.plan}</span> : null}
            </span>
            {b?.sub ? <span className="text-micro text-neutral-500" data-testid="chip-snapshot">{b.sub}</span> : null}
            <span className="flex flex-wrap gap-x-1 text-micro text-neutral-500">
              {e.state !== "synced" ? (
                <span data-testid="chip-state" className={cn(e.state === "reconnect" || e.state === "problem" ? "text-status-bad font-medium" : "")}>
                  {STATE_WORD[e.state]}
                  {stamps.length ? " ·" : ""}
                </span>
              ) : null}
              {stamps.length ? <span data-testid="chip-stamps">{stamps.join(" · ")}</span> : null}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

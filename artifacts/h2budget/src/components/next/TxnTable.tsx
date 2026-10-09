import type { KeyboardEvent, MouseEvent } from "react";
import { Link, useLocation } from "wouter";
import { cn, formatCurrency } from "@/lib/utils";
import type { AccountIdentity } from "@/lib/accountIdentity";
import { AccountChip } from "./AccountChip";
import { formatDisplayAmount } from "@/lib/amountDisplay";
import { th, td, tdNum, emptyNote } from "@/ui";
import { shortDate } from "./shortDate";

export interface TxnRow {
  id: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  description: string;
  /** Signed: negative is money out. */
  amount: number;
  identity: AccountIdentity;
  pending: boolean;
  category?: string | null;
  href?: string;
  /**
   * (WP7) Why a row with no `href` opens nowhere, in words ("No ledger: Chase
   * (no longer linked)", from `txnRoute`). Shown only when there is no href.
   */
  note?: string | null;
  /** A review flag said in words ("Income in an expense category"), shown as a chip. */
  flag?: string | null;
}

/** The description of a row that opens somewhere: a REAL link, so a keyboard
 *  or screen-reader user gets a named, native navigation target (Enter, and
 *  Space as well), one focus stop per row. The rest of the row stays clickable
 *  with the mouse. */
function RowLink({ href, children, className }: { href: string; children: string; className?: string }) {
  const [, navigate] = useLocation();
  return (
    <Link
      href={href}
      onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => {
        if (e.key === " ") { e.preventDefault(); navigate(href); }
      }}
      className={cn("rounded-control hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40", className)}
      data-testid="txn-row-link"
    >
      {children}
    </Link>
  );
}

/** A click anywhere on a row opens it, except on the link itself (which
 *  navigates on its own: one history entry, not two). */
function rowClick(href: string | undefined, navigate: (to: string) => void) {
  if (!href) return undefined;
  return (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("a")) return;
    navigate(href);
  };
}

/** Compact ledger: 36 px rows (40 px when not `dense`), an account chip on
 *  every row, pending/posted as a word, category in its own column. A row with
 *  an `href` carries its description as a link (Enter / Space) and opens on a
 *  click anywhere; a row without one says why in its `note` (WP7).
 *  `layout="list"` draws the SAME rows as two-line list items (description and
 *  amount, then date, account chip, category and status) for a narrow panel,
 *  where six columns would scroll sideways. Nothing is dropped. */
export function TxnTable({ rows, dense = true, layout = "table" }: { rows: TxnRow[]; dense?: boolean; layout?: "table" | "list" }) {
  const [, navigate] = useLocation();
  if (rows.length === 0) return <p className={emptyNote}>No transactions to show.</p>;
  if (layout === "list") {
    return (
      <ul className="list-none divide-y divide-brand-line p-0" data-testid="txn-list">
        {rows.map((r) => {
          const go = rowClick(r.href, navigate);
          return (
            <li
              key={r.id}
              data-testid="txn-row"
              onClick={go}
              className={cn(
                "px-4 py-2",
                go && "cursor-pointer transition-colors duration-[calc(96ms*var(--anim-speed))] hover:bg-platinum-3 focus-within:bg-platinum-3",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-body text-brand-ink [overflow-wrap:anywhere]">
                  {r.href ? <RowLink href={r.href}>{r.description}</RowLink> : r.description}
                </span>
                <span className={cn("shrink-0 font-mono text-label tabular-nums", r.amount < 0 ? "text-brand-ink" : "text-brand-navy")}>
                  {formatDisplayAmount(r.amount)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-neutral-500">
                <span className="font-mono tabular-nums">{shortDate(r.date)}</span>
                <AccountChip identity={r.identity} size="sm" wrap />
                <span>{r.category || "Uncategorized"}</span>
                <span aria-hidden>·</span>
                <span>{r.pending ? "Pending" : "Posted"}</span>
                {!r.href && r.note ? <span className="text-neutral-600" data-testid="txn-note">{r.note}</span> : null}
                {r.flag ? <span className="chip warn" data-testid="txn-flag">{r.flag}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }
  const h = dense ? "h-9" : "h-10";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Description</th>
            <th className={th}>Account</th>
            <th className={th}>Category</th>
            <th className={th}>Status</th>
            <th className={cn(th, "text-right")}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const go = rowClick(r.href, navigate);
            return (
              <tr
                key={r.id}
                data-testid="txn-row"
                onClick={go}
                className={cn(
                  h,
                  "transition-colors duration-[calc(96ms*var(--anim-speed))]",
                  go && "cursor-pointer hover:bg-platinum-3 focus-within:bg-platinum-3",
                )}
              >
                <td className={cn(td, "whitespace-nowrap py-1 font-mono tabular-nums text-neutral-600")}>{shortDate(r.date)}</td>
                <td className={cn(td, "max-w-[22rem] truncate py-1")}>
                  {r.href ? <RowLink href={r.href}>{r.description}</RowLink> : r.description}
                  {!r.href && r.note ? <span className="block text-micro text-neutral-600" data-testid="txn-note">{r.note}</span> : null}
                </td>
                <td className={cn(td, "py-1")}><AccountChip identity={r.identity} size="sm" /></td>
                <td className={cn(td, "py-1 text-neutral-600")}>
                  {r.category || "Uncategorized"}
                  {r.flag ? <span className="chip warn ml-2" data-testid="txn-flag">{r.flag}</span> : null}
                </td>
                <td className={cn(td, "py-1 text-neutral-600")}>{r.pending ? "Pending" : "Posted"}</td>
                <td className={cn(tdNum, "py-1", r.amount < 0 ? "text-brand-ink" : "text-brand-navy")}>
                  {formatDisplayAmount(r.amount)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { useLocation } from "wouter";
import { cn, formatCurrency } from "@/lib/utils";
import type { AccountIdentity } from "@/lib/accountIdentity";
import { AccountChip } from "./AccountChip";
import { formatDisplayAmount } from "@/lib/amountDisplay";
import { th, td, tdNum, emptyNote } from "@/ui";

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
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-08" -> "Oct 8", with no Date object so no timezone can shift it. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** Compact ledger: 36 px rows (40 px when not `dense`), an account chip on
 *  every row, pending/posted as a word, category in its own column. Rows with
 *  an `href` are focusable and open on Enter or click.
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
          const go = r.href ? () => navigate(r.href!) : undefined;
          return (
            <li
              key={r.id}
              data-testid="txn-row"
              tabIndex={go ? 0 : undefined}
              onClick={go}
              onKeyDown={go ? (e) => { if (e.key === "Enter") go(); } : undefined}
              className={cn(
                "px-4 py-2",
                go && "cursor-pointer transition-colors duration-[calc(96ms*var(--anim-speed))] hover:bg-platinum-3 focus-visible:bg-platinum-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-navy/40",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-body text-brand-ink [overflow-wrap:anywhere]">{r.description}</span>
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
            const go = r.href ? () => navigate(r.href!) : undefined;
            return (
              <tr
                key={r.id}
                data-testid="txn-row"
                tabIndex={go ? 0 : undefined}
                onClick={go}
                onKeyDown={go ? (e) => { if (e.key === "Enter") go(); } : undefined}
                className={cn(
                  h,
                  "transition-colors duration-[calc(96ms*var(--anim-speed))]",
                  go && "cursor-pointer hover:bg-platinum-3 focus-visible:bg-platinum-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-navy/40",
                )}
              >
                <td className={cn(td, "whitespace-nowrap py-1 font-mono tabular-nums text-neutral-600")}>{shortDate(r.date)}</td>
                <td className={cn(td, "max-w-[22rem] truncate py-1")}>{r.description}</td>
                <td className={cn(td, "py-1")}><AccountChip identity={r.identity} size="sm" /></td>
                <td className={cn(td, "py-1 text-neutral-600")}>{r.category || "Uncategorized"}</td>
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

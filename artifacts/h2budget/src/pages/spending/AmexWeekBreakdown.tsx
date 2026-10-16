import { Link } from "wouter";
import type {
  AmexSummaryReconciliation,
  AmexSummaryReconciliationGroup,
  AmexSummaryReconciliationRow,
  AmexSummaryReconciliationRowNotesItem,
} from "@workspace/api-client-react/features";
import { shortDate } from "@/components/next/shortDate";
import type { TxnRoute } from "@/lib/accountRoute";
import { formatCurrency } from "@/lib/utils";

const NOTE_WORDS: Record<AmexSummaryReconciliationRowNotesItem, string> = {
  not_filed: "Not filed yet",
  no_category: "No category",
  pending: "Pending",
};

/** `?open=` token of one group. */
export const amexGroupToken = (key: string): string => `amex:${key}`;

const countWords = (n: number): string => `${n} ${n === 1 ? "purchase" : "purchases"}`;

function cardWords(c: AmexSummaryReconciliationRow["card"]): string {
  return c.mask ? `${c.name} ••${c.mask.slice(-4)}` : c.name;
}

/** Where "and N more" opens the Amex page: this week's rows, or the month a past week ends in. */
export function amexMoreHref(end: string, isCurrent: boolean): string {
  return isCurrent ? "/amex" : `/amex?month=${end.slice(0, 7)}-01&mode=month`;
}

function Rows({ g, end, isCurrent, routeOf }: {
  g: AmexSummaryReconciliationGroup;
  end: string;
  isCurrent: boolean;
  routeOf: (r: AmexSummaryReconciliationRow) => TxnRoute;
}) {
  const more = g.count - g.rows.length;
  return (
    <div className="border-t border-brand-line bg-brand-tint/40" data-testid={`sp-amex-rows-${g.key}`}>
      <ul className="divide-y divide-brand-line">
        {g.rows.map((r) => {
          const route = routeOf(r);
          const merchant = <span className="min-w-0 truncate font-medium text-brand-ink">{r.displayName}</span>;
          return (
            <li key={r.id} className="px-4 py-2" data-testid="sp-amex-row">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2 text-body">
                  <span className="shrink-0 text-micro text-neutral-600">{shortDate(r.date)}</span>
                  {route.href ? (
                    <Link href={route.href} className="min-w-0 truncate hover:underline" data-testid="sp-amex-row-link">{merchant}</Link>
                  ) : (
                    <span className="min-w-0 truncate" title={route.note ?? undefined}>{merchant}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-body tabular-nums text-brand-ink" data-testid="sp-amex-row-amount">{formatCurrency(r.amount)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-neutral-600">
                <span className="chip gray" data-testid="sp-amex-row-card">{cardWords(r.card)}</span>
                {r.notes.length ? <span data-testid="sp-amex-row-notes">{r.notes.map((n) => NOTE_WORDS[n]).join(" · ")}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
      {g.truncated && more > 0 ? (
        <p className="px-4 py-2 text-micro">
          <Link href={amexMoreHref(end, isCurrent)} className="font-medium text-brand-navy underline" data-testid={`sp-amex-more-${g.key}`}>
            and {more} more → open in Amex
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * (Task 5) The Amex reconciliation, opened from the Spending week's Amex line:
 * one line per group that holds a purchase (label · amount · count), each
 * opening its purchases (date · merchant · amount · card · notes), each row
 * opening the Amex page on that row (`routeOf`: the one route rule). Refunds
 * stand beside, outside the total. Every figure and word is the server's
 * (`GET /amex/summary` `reconciliation`); nothing is computed here.
 */
export default function AmexWeekBreakdown({ rec, start, end, isCurrent, open, onToggle, routeOf }: {
  rec: AmexSummaryReconciliation;
  start: string;
  end: string;
  isCurrent: boolean;
  open: readonly string[];
  onToggle: (token: string) => void;
  routeOf: (r: AmexSummaryReconciliationRow) => TxnRoute;
}) {
  const groups = rec.groups.filter((g) => g.count > 0);
  return (
    <div className="surface mt-2 rounded-card ring-1 ring-brand-line" data-testid="sp-amex-breakdown">
      <p className="border-b border-brand-line px-4 py-2 text-label text-neutral-600" data-testid="sp-amex-scope">
        All Amex cards · {shortDate(start)} – {shortDate(end)}
      </p>
      <ul className="divide-y divide-brand-line">
        {groups.map((g) => {
          const token = amexGroupToken(g.key);
          const isOpen = open.includes(token);
          return (
            <li key={g.key}>
              <details open={isOpen} data-testid={`sp-amex-group-${g.key}`}>
                <summary
                  className="press flex cursor-pointer list-none items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-brand-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy [&::-webkit-details-marker]:hidden"
                  onClick={(e) => {
                    e.preventDefault();
                    onToggle(token);
                  }}
                >
                  <span className="min-w-0 truncate text-body font-semibold text-brand-ink">{g.label}</span>
                  <span className="shrink-0 text-body tabular-nums text-brand-ink">
                    <span className="font-mono font-semibold" data-testid={`sp-amex-group-amount-${g.key}`}>{formatCurrency(g.amount)}</span>
                    <span className="text-micro text-neutral-600"> · {countWords(g.count)}</span>
                  </span>
                </summary>
                {isOpen ? <Rows g={g} end={end} isCurrent={isCurrent} routeOf={routeOf} /> : null}
              </details>
            </li>
          );
        })}
      </ul>
      {rec.refunds.count > 0 ? (
        <p className="border-t border-brand-line px-4 py-2 text-label text-neutral-700" data-testid="sp-amex-refunds">
          Refunds −{formatCurrency(rec.refunds.amount)} · credits, not in the total
        </p>
      ) : null}
    </div>
  );
}

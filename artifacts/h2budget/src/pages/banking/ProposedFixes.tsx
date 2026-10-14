import { useState } from "react";
import { Link } from "wouter";
import {
  getGetReviewProposalsQueryKey,
  useGetReviewProposals,
  type ReviewProposal,
  type ReviewProposalAction,
  type ReviewProposalEvidence,
} from "@workspace/api-client-react/features";
import { formatCurrency } from "@/lib/utils";
import { dayWords } from "./words";

/**
 * (F4) PROPOSED FIXES — what H2 thinks some rows really are, read-only
 * (`GET /review/proposals`). Rows, the evidence, the proposed action, and a
 * link to the app action that applies it (Reconcile "mark matched", or
 * Categories). Nothing is applied from this panel. The query runs only while
 * the panel is open.
 */
const SHOWN_ROWS = 4;

const KIND_TITLE: Record<ReviewProposal["kind"], string> = {
  loan_payment: "Loan payments",
  transfer: "Transfers counted as spending",
  bill_match: "Bill payments to confirm",
  income_category: "Income filed as an expense",
};

export function actionWords(a: ReviewProposalAction): string {
  const label = a.target.label;
  switch (a.code) {
    case "file_as_bill_payment":
      return `File as a payment of ${label}`;
    case "file_as_debt_payment":
      return `File as a payment toward ${label}`;
    case "file_as_transfer":
      return "File as a transfer";
    case "confirm_bill_match":
      return `Confirm it pays ${label}`;
    case "file_under_income_category":
      return `File under ${label} (income)`;
    default:
      return label;
  }
}

const plain = (v: string) => v.toLowerCase().replace(/_/g, " ");

export function evidenceLine(e: ReviewProposalEvidence): string {
  switch (e.field) {
    case "pfc_primary":
    case "pfc_detailed":
      return `Bank says ${plain(e.value)}`;
    case "bill_suggestion":
      return `Forecast suggests ${e.value}`;
    case "category":
      return `Filed under ${e.value}`;
    case "name_match":
      return `Name fits ${e.value.split(" ~ ").at(-1)}`;
    case "amount_match": {
      // "1150.40 ~ 1110.00": the row's amount against the plan's.
      const [row, plan] = e.value.split(" ~ ");
      return row && plan ? `Amount ${formatCurrency(row)} vs ${formatCurrency(plan)} planned` : `Amount fits ${e.value}`;
    }
    case "same_amount_rows":
      return `${e.value} rows of the same amount`;
    default:
      return e.value;
  }
}

function Proposal({ p }: { p: ReviewProposal }) {
  const shown = p.rows.slice(0, SHOWN_ROWS);
  const more = p.rowCount - shown.length;
  // The distinct evidence lines (the bank's two Plaid fields say the same thing twice).
  const lines = Array.from(new Set(p.evidence.filter((e) => e.field !== "pfc_detailed").map(evidenceLine)));
  return (
    <li className="space-y-1.5 px-4 py-3" data-testid="br-fix" data-kind={p.kind}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-body font-semibold text-brand-navy">{KIND_TITLE[p.kind]}</h3>
        <span className="font-mono text-body font-semibold tabular-nums text-brand-ink" data-testid="br-fix-total">{formatCurrency(p.total)}</span>
      </div>
      <ul className="space-y-0.5">
        {shown.map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-3 text-label" data-testid="br-fix-row">
            <span className="min-w-0 truncate text-neutral-700">
              <span className="text-neutral-500">{dayWords(r.date)}</span> {r.displayName}
              {r.account.mask ? <span className="text-neutral-500"> ••{r.account.mask}</span> : null}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-brand-ink">{formatCurrency(r.amount)}</span>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="text-micro text-neutral-600">and {more} more</p> : null}
      {lines.length ? <p className="text-micro text-neutral-600" data-testid="br-fix-evidence">{lines.join(" · ")}</p> : null}
      <p className="text-label font-medium text-brand-ink" data-testid="br-fix-action">Proposed: {actionWords(p.action)}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-label">
        {p.applyWith.includes("review_mark_matched") ? (
          <Link href="/review" className="font-semibold text-brand-navy underline" data-testid="br-fix-link-match">Mark matched in Reconcile</Link>
        ) : null}
        {p.applyWith.includes("categories_change") ? (
          <Link href="/review/categories" className="font-semibold text-brand-navy underline" data-testid="br-fix-link-categories">Change in Categories</Link>
        ) : null}
      </div>
    </li>
  );
}

export function ProposedFixes({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const q = useGetReviewProposals({ query: { queryKey: getGetReviewProposalsQueryKey(), staleTime: 60_000, enabled: open } });
  const d = q.data;
  return (
    <details
      className="surface rounded-card ring-1 ring-brand-line"
      data-testid="br-fixes"
      id="proposed-fixes"
      open={defaultOpen || undefined}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="press cursor-pointer px-4 py-3 text-title font-semibold text-brand-navy">
        Proposed fixes
        {d ? <span className="ml-2 font-mono text-label tabular-nums text-neutral-500" data-testid="br-fixes-count">{d.count}</span> : null}
      </summary>
      <div className="border-t border-brand-line">
        {!open ? null : q.isError ? (
          <p className="px-4 py-3 text-body text-neutral-700" role="alert" data-testid="br-fixes-error">
            The proposals did not load. <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button>
          </p>
        ) : !d ? (
          <div className="p-4"><div className="skeleton h-16 w-full rounded-card" aria-busy="true" data-testid="br-fixes-loading" /></div>
        ) : d.items.length === 0 ? (
          <p className="px-4 py-3 text-body text-neutral-600" data-testid="br-fixes-none">Nothing to propose right now.</p>
        ) : (
          <>
            <p className="px-4 pt-3 text-micro text-neutral-600">Read-only. Nothing is changed from here.</p>
            <ul className="divide-y divide-brand-line/70">{d.items.map((p) => <Proposal key={p.key} p={p} />)}</ul>
            {d.truncated ? <p className="px-4 py-2 text-micro text-neutral-600">Showing the largest {d.items.length} of {d.count}.</p> : null}
          </>
        )}
      </div>
    </details>
  );
}

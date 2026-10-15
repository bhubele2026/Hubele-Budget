import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useListPlaidItems } from "@workspace/api-client-react";
import {
  getGetReviewProposalsQueryKey,
  getListAppliedReviewProposalsQueryKey,
  undoAppliedReviewProposal,
  useGetReviewProposals,
  useListAppliedReviewProposals,
  type AppliedCorrection,
  type ReviewProposal,
  type ReviewProposalAction,
  type ReviewProposalEvidence,
} from "@workspace/api-client-react/features";
import { toastWithActions } from "@/components/ui/action-toast";
import { toast } from "@/hooks/use-toast";
import { useOwner } from "@/hooks/useOwner";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries } from "@/pages/next/accounts/entries";
import { formatCurrency, formatRelativeTime } from "@/lib/utils";
import { btn, btnSecondary } from "@/ui";
import { FixDialog } from "./FixDialog";
import { refusalCode, refusalWords } from "./fixWords";
import { dayWords } from "./words";

/**
 * (F4, Q5) PROPOSED FIXES — what H2 thinks some rows really are, and what to do
 * about it. Each proposal lists its rows (every row opens its record), one line
 * of evidence, the proposed change and its scope, then Preview (a dry run: which
 * totals change, before → after) and Apply (asks once, writes, then offers Undo).
 * "Applied fixes" below keeps the last ones, each with its own Undo. The owner
 * applies; a member reads. The queries run only while the panel is open.
 */
const SHOWN_ROWS = 4;
/** One-line evidence: the first two facts; the rest are behind "Why?". */
const EVIDENCE_SHOWN = 2;

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


const kindTitle = (p: ReviewProposal) => KIND_TITLE[p.kind];

/**
 * (Round 3) What a proposal is ABOUT, in a few words: the action and its first row (merchant or bill, amount, date), so
 * two proposals of one kind never share a button name. A screen-reader user moving by buttons can tell the cards apart.
 */
export function subjectOf(p: ReviewProposal): string {
  const r = p.rows[0];
  const row = r ? `${r.displayName} ${formatCurrency(r.amount)}, ${dayWords(r.date)}` : formatCurrency(p.total);
  const more = p.rowCount > 1 ? ` and ${p.rowCount - 1} more` : "";
  return `${actionWords(p.action)}: ${row}${more}`;
}

function Proposal({
  p,
  owner,
  hrefOf,
  onPreview,
  onApply,
}: {
  p: ReviewProposal;
  owner: ReturnType<typeof useOwner>;
  hrefOf: (r: ReviewProposal["rows"][number]) => string | null;
  onPreview: (opener: HTMLElement) => void;
  onApply: (opener: HTMLElement) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? p.rows : p.rows.slice(0, SHOWN_ROWS);
  const more = p.rows.length - shown.length;
  // The distinct evidence lines (the bank's two Plaid fields say the same thing twice).
  const lines = Array.from(new Set(p.evidence.filter((e) => e.field !== "pfc_detailed").map(evidenceLine)));
  // The change's scope: the rows it applies to (a truncated proposal applies to the rows it lists).
  const scope = p.truncated || p.rowCount > p.rows.length
    ? `Changes the ${p.rows.length} rows listed, of ${p.rowCount}`
    : `Changes ${p.rows.length} ${p.rows.length === 1 ? "row" : "rows"}`;
  return (
    <li className="space-y-1.5 px-4 py-3" data-testid="br-fix" data-kind={p.kind}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-body font-semibold text-brand-navy">{kindTitle(p)}</h3>
        <span className="font-mono text-body font-semibold tabular-nums text-brand-ink" data-testid="br-fix-total">{formatCurrency(p.total)}</span>
      </div>
      <ul className="space-y-0.5">
        {shown.map((r) => {
          const href = hrefOf(r);
          const name = <span className="text-neutral-700"><span className="text-neutral-500">{dayWords(r.date)}</span> {r.displayName}{r.account.mask ? <span className="text-neutral-500"> ••{r.account.mask}</span> : null}</span>;
          return (
            <li key={r.id} className="flex items-baseline justify-between gap-3 text-label" data-testid="br-fix-row">
              <span className="min-w-0 truncate">
                {href ? <Link href={href} className="hover:underline" data-testid="br-fix-row-link">{name}</Link> : name}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-brand-ink">{formatCurrency(r.amount)}</span>
            </li>
          );
        })}
      </ul>
      {more > 0 || all ? (
        <button type="button" className="press text-micro font-semibold text-brand-navy underline" onClick={() => setAll((v) => !v)} data-testid="br-fix-rows-toggle">
          {all ? "Show fewer" : `Show all ${p.rows.length} rows`}
        </button>
      ) : null}
      {lines.length ? <p className="text-micro text-neutral-600" data-testid="br-fix-evidence">{lines.slice(0, EVIDENCE_SHOWN).join(" · ")}</p> : null}
      {lines.length > EVIDENCE_SHOWN ? (
        <details className="text-micro text-neutral-600" data-testid="br-fix-why">
          <summary className="inline cursor-pointer font-semibold text-brand-navy" aria-label={`Why? ${subjectOf(p)}`}>Why?</summary>
          <p className="mt-0.5" data-testid="br-fix-why-lines">{lines.join(" · ")}</p>
        </details>
      ) : null}
      <p className="text-label font-medium text-brand-ink" data-testid="br-fix-action">Proposed: {actionWords(p.action)}</p>
      <p className="text-micro text-neutral-600" data-testid="br-fix-scope">{scope}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-label">
        {owner === "unknown" ? (
          <span className="skeleton h-9 w-40 rounded-control" aria-busy="true" data-testid="br-fix-owner-unknown" />
        ) : owner ? (
          <>
            <button type="button" className={btnSecondary} onClick={(e) => onPreview(e.currentTarget)} aria-label={`Preview: ${subjectOf(p)}`} data-testid="br-fix-preview">Preview</button>
            <button type="button" className={btn} onClick={(e) => onApply(e.currentTarget)} aria-label={`Apply: ${subjectOf(p)}`} data-testid="br-fix-apply">Apply</button>
          </>
        ) : (
          <span className="text-micro text-neutral-600" data-testid="br-fix-readonly">The household owner applies fixes.</span>
        )}
        {p.applyWith.includes("review_mark_matched") ? (
          <Link href="/review" className="font-semibold text-brand-navy underline" data-testid="br-fix-link-match">In Review</Link>
        ) : null}
        {p.applyWith.includes("categories_change") ? (
          <Link href="/review/categories" className="font-semibold text-brand-navy underline" data-testid="br-fix-link-categories">In Categories</Link>
        ) : null}
      </div>
    </li>
  );
}

/** "Undo: File as a transfer, 1 row, Oct 14, 3:00 PM": the label, its size and the minute it was applied tell two applied fixes apart. */
const undoName = (a: { label: string; rowCount: number; appliedAt: string }) =>
  `Undo: ${a.label}, ${a.rowCount} ${a.rowCount === 1 ? "row" : "rows"}, ${new Date(a.appliedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}`;

function AppliedFixes({ onUndo, owner }: { onUndo: (id: string, label: string) => void; owner: ReturnType<typeof useOwner> }) {
  // The list is the owner's (the server answers a member 403): it is asked only for the owner, never an error for a member.
  const q = useListAppliedReviewProposals({ query: { queryKey: getListAppliedReviewProposalsQueryKey(), staleTime: 30_000, enabled: owner === true } });
  if (owner !== true) return null;
  const items = q.data?.items ?? [];
  if (q.isError) return <p className="px-4 py-2 text-micro text-neutral-600" role="alert" data-testid="br-applied-error">Applied fixes did not load.</p>;
  if (items.length === 0) return null;
  return (
    <div className="border-t border-brand-line" data-testid="br-applied">
      <h3 className="px-4 pt-3 text-label font-semibold text-brand-navy">Applied fixes</h3>
      <ul className="divide-y divide-brand-line/70">
        {items.map((a) => (
          <li key={a.id} className="flex items-baseline justify-between gap-3 px-4 py-2 text-label" data-testid="br-applied-row">
            <span className="min-w-0">
              <span className="font-medium text-brand-ink">{a.label}</span>
              <span className="text-neutral-600"> · {a.rowCount} {a.rowCount === 1 ? "row" : "rows"} · {formatRelativeTime(a.appliedAt)}</span>
              {a.undoneAt ? <span className="ml-2 chip gray" data-testid="br-applied-undone">Undone</span> : null}
            </span>
            {!a.undoneAt && a.undoable ? (
              <button type="button" className="press shrink-0 font-semibold text-brand-navy underline" onClick={() => onUndo(a.id, a.label)} aria-label={undoName(a)} data-testid={`br-applied-undo-${a.id}`}>Undo</button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Focus the toast's Undo once it is on screen (a keyboard user cannot otherwise reach it before it goes). */
function focusToastUndo() {
  let tries = 0;
  const go = () => {
    const el = document.querySelector<HTMLElement>('[data-testid="fix-toast-undo"]');
    if (el) el.focus();
    else if (++tries < 20) window.setTimeout(go, 50);
  };
  // After the dialog has given focus back (its own unmount hand-back runs on a timer).
  window.setTimeout(go, 150);
}

export function ProposedFixes({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [dialog, setDialog] = useState<{ p: ReviewProposal; confirm: boolean } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const qc = useQueryClient();
  const owner = useOwner();
  // The count is asked on load (not only when opened) so "Needs your decision" says how many wait. Owner only: the server answers a member 403.
  const q = useGetReviewProposals({ query: { queryKey: getGetReviewProposalsQueryKey(), staleTime: 60_000, enabled: owner === true } });
  const d = q.data;
  // (Round 3) The panel never opens itself: the count is in the collapsed summary, the owner opens it (or `?fixes=1`
  // does, once, before first paint of what sits below). Nothing below it moves after the answer lands.
  // Where each row opens: the one route rule (the account, month and row in the address).
  const items = useListPlaidItems({ query: { staleTime: 60_000, enabled: open && owner === true } as never });
  const entries = useMemo(() => buildEntries(items.data), [items.data]);
  const entriesKnown = items.data !== undefined;
  const hrefOf = (r: ReviewProposal["rows"][number]): string | null =>
    txnRoute({ id: r.id, occurredOn: r.date, plaidAccountId: r.account.externalId, source: r.source }, entries, { entriesKnown }).href;

  // A fix moves totals on many screens: everything is marked stale, what is on screen refetches.
  const refreshAll = () => void qc.invalidateQueries();

  const undo = async (id: string, label: string) => {
    try {
      await undoAppliedReviewProposal(id);
      refreshAll();
      toast({ title: `Undone · ${label}` });
    } catch (e) {
      const changed = refusalCode(e) === "changed_since";
      toast({ title: changed ? "Not undone" : "Could not undo", description: refusalWords(e, "Nothing was changed."), variant: "destructive" });
    }
    // The Undo button that was pressed is gone (the row says "Undone"): focus stays in the panel.
    summaryRef.current?.focus();
  };

  // Owns the result of an apply: it runs even if the dialog was closed meanwhile (nothing is lost).
  const applied = (r: AppliedCorrection, title: string) => {
    setDialog(null);
    refreshAll();
    toastWithActions({
      title: `Applied · ${title}`,
      description: `${r.rows.length} ${r.rows.length === 1 ? "row" : "rows"} changed.`,
      duration: 15_000,
      actions: [{ label: "Undo", altText: `Undo ${title}`, onClick: () => void undo(r.applicationId, title), "data-testid": "fix-toast-undo" }],
    });
    focusToastUndo();
  };

  const openDialog = (p: ReviewProposal, confirm: boolean, from: HTMLElement) => {
    opener.current = from;
    setDialog({ p, confirm });
  };

  if (owner === false) {
    // The proposals and the applied list are the owner's; a member is told so once.
    return (
      <p className="surface rounded-card px-4 py-3 text-label text-neutral-600 ring-1 ring-brand-line" data-testid="br-fixes-member">
        The household owner applies fixes.
      </p>
    );
  }

  return (
    <details
      className="surface rounded-card ring-1 ring-brand-line"
      data-testid="br-fixes"
      id="proposed-fixes"
      open={open}
      onToggle={(e) => {
        setOpen((e.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary ref={summaryRef} className="press block cursor-pointer px-4 py-3" data-testid="br-fixes-summary">
        {/* Two lines, always: the height is reserved while the count is on its way, so nothing below moves. */}
        <span className="flex items-baseline justify-between gap-3">
          <span className="text-title font-semibold text-brand-navy" data-testid="br-fixes-title">
            {d ? (
              <><span className="font-mono tabular-nums" data-testid="br-fixes-count">{d.count}</span> proposed {d.count === 1 ? "fix" : "fixes"}</>
            ) : q.isError ? "Proposed fixes" : <span className="skeleton inline-block h-5 w-36 rounded-control align-middle" aria-busy="true" data-testid="br-fixes-count-loading" />}
          </span>
          <span className="text-label font-semibold text-brand-navy underline" aria-hidden>{open ? "Hide" : "Show"}</span>
        </span>
        <span className="mt-0.5 block min-h-[1rem] text-micro font-normal text-neutral-600" data-testid="br-fixes-scope">
          {d ? `All accounts · last ${d.window.days} days` : q.isError ? "Did not load" : ""}
        </span>
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
            <ul className="divide-y divide-brand-line/70">
              {d.items.map((p) => (
                <Proposal key={p.key} p={p} owner={owner} hrefOf={hrefOf} onPreview={(el) => openDialog(p, false, el)} onApply={(el) => openDialog(p, true, el)} />
              ))}
            </ul>
            {d.truncated ? <p className="px-4 py-2 text-micro text-neutral-600">Showing the largest {d.items.length} of {d.count}.</p> : null}
          </>
        )}
        {open ? <AppliedFixes owner={owner} onUndo={(id, label) => void undo(id, label)} /> : null}
      </div>
      {dialog ? (
        <FixDialog
          key={`${dialog.p.key}|${dialog.p.proposalHash}`}
          proposal={dialog.p}
          title={actionWords(dialog.p.action)}
          hrefOf={hrefOf}
          startConfirming={dialog.confirm}
          // Focus goes back to the button that opened the dialog; when that card is gone, to this panel's heading.
          returnFocus={() => (opener.current?.isConnected ? opener.current : summaryRef.current)}
          onClose={() => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: getGetReviewProposalsQueryKey() });
          }}
          onApplied={applied}
        />
      ) : null}
    </details>
  );
}

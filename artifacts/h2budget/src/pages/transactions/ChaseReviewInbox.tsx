import type { ReactNode } from "react";
import type { LedgerRow } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Help, fieldLabel } from "@/ui";
import { BULK_REVIEW_MAX, ledgerRowLabels } from "./chaseLedger";

/**
 * ⭐ PR14 — the Chase review inbox's controls. Presentational only: the page
 * owns the queries, the selection and the writes.
 *
 * "To review" counts Chase rows not yet marked reviewed. It is deliberately a
 * different label from the nav's Review badge, which counts forecast review.
 */

const count = (n: number) => n.toLocaleString("en-US");
const Num = ({ n, testId }: { n: number; testId?: string }) => (
  <span className="font-mono tabular-nums" data-testid={testId}>
    {count(n)}
  </span>
);
/** A count in running text (toasts, banners): mono numerals, like every count on screen. */
export const MonoCount = ({ n }: { n: number }) => <Num n={n} />;

export function ChaseReviewControls({
  toReview,
  hideReviewed,
  onToggleHide,
  onSelectPage,
  canSelectPage,
  freshness,
}: {
  toReview: number | null;
  hideReviewed: boolean;
  onToggleHide: () => void;
  onSelectPage: () => void;
  canSelectPage: boolean;
  freshness: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="chase-review-controls">
      <span className="inline-flex items-center gap-1.5" data-testid="chase-to-review">
        <span className={fieldLabel}>To review:</span>
        {toReview == null ? (
          <span className="font-mono tabular-nums text-neutral-400">—</span>
        ) : (
          <span className="font-mono text-label font-semibold tabular-nums text-brand-navy">
            {count(toReview)}
          </span>
        )}
        <Help>
          Chase rows in this range not yet marked reviewed, through today. Not the forecast Review count. Reviewing moves no money.
        </Help>
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onSelectPage}
        disabled={!canSelectPage}
        data-testid="chase-select-page"
      >
        Select this page
      </Button>
      <Button
        variant={hideReviewed ? "default" : "outline"}
        size="sm"
        onClick={onToggleHide}
        data-testid="chase-clear-reviewed"
      >
        {hideReviewed ? "Show reviewed" : "Clear reviewed from list"}
      </Button>
      <span className="ml-auto text-micro text-neutral-500" data-testid="chase-freshness">
        {freshness}
      </span>
    </div>
  );
}

/**
 * The step from "this page" to "every matching row". Shown once every loaded
 * row is selected and more rows match; after the click it states the count the
 * bulk review will be held to.
 */
export function ChaseSelectAllBanner({
  pageSelected,
  matchingCount,
  allMatchingCount,
  canSelectAll,
  onSelectAll,
  onClear,
}: {
  pageSelected: number;
  matchingCount: number;
  /** The count captured when "Select all" was clicked; null while only the page is selected. */
  allMatchingCount: number | null;
  /** False while the list shows another filter's rows (the count is not this filter's yet). */
  canSelectAll: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  if (allMatchingCount != null) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-label text-neutral-600" data-testid="chase-select-all-banner">
        <span>
          All <Num n={allMatchingCount} testId="chase-all-matching-count" /> matching selected.
        </span>
        <Button variant="ghost" size="sm" onClick={onClear} data-testid="chase-select-all-clear">
          Clear selection
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-label text-neutral-600" data-testid="chase-select-all-banner">
      <span>
        <Num n={pageSelected} /> on this page selected.
      </span>
      {matchingCount > BULK_REVIEW_MAX ? (
        <span data-testid="chase-select-all-too-many">
          Over <Num n={BULK_REVIEW_MAX} /> match. Narrow the range to select all.
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={onSelectAll}
          disabled={!canSelectAll}
          data-testid="chase-select-all-matching"
        >
          Select all <Num n={matchingCount} testId="chase-select-all-count" /> matching
        </Button>
      )}
    </div>
  );
}

/** "Showing 50 of 260 · 37 to review", and the next page on request. */
export function ChaseLedgerPager({
  showing,
  matching,
  toReview,
  hasMore,
  loading,
  onLoadMore,
}: {
  showing: number;
  matching: number;
  toReview: number | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 py-2" data-testid="chase-ledger-pager">
      <span className="text-label text-neutral-500" data-testid="chase-showing">
        Showing <Num n={showing} /> of <Num n={matching} />
        {toReview != null && (
          <>
            {" · "}
            <Num n={toReview} /> to review
          </>
        )}
      </span>
      <Help>
        Rows in this range through today. Pending rows and rows after today are listed apart and are not in this count.
      </Help>
      {hasMore && (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading} data-testid="chase-load-more">
          {loading ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

/** Quiet labels for rows the balance treats specially. The words carry the state. */
export function LedgerRowLabels({ row }: { row: LedgerRow }) {
  const labels = ledgerRowLabels(row);
  if (labels.length === 0) return null;
  return (
    <>
      {labels.map((l) => (
        <span
          key={l.key}
          className="chip gray whitespace-nowrap"
          title={l.title}
          data-testid={`label-${l.key}-${row.id}`}
        >
          {l.label}
        </span>
      ))}
    </>
  );
}

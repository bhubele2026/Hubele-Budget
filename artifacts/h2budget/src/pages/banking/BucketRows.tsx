import { Link } from "wouter";
import type {
  BankingReviewBucketName,
  BankingReviewKind,
  BankingReviewRow,
  GetBankingReviewParams,
} from "@workspace/api-client-react/features";
import { useQueryClient } from "@tanstack/react-query";
import { getBankingReview, getGetBankingReviewQueryKey, useGetBankingReview } from "@workspace/api-client-react/features";
import { emptyNote } from "@/ui";
import { formatCurrency } from "@/lib/utils";
import { BANKING_MIN as MIN, BANKING_PAGE as PAGE } from "./reviewParams";
import { classificationNote, dayWords, planLine, REASON_WORDS, varianceShort, variancePinches } from "./words";

/**
 * (W3) One bucket's rows, paged by the server (`bucket` + `cursor`). Each page
 * is its own component and query, so "Show more" only adds one; nothing here
 * adds a figure up. A row opens its register (`href` from the one route rule)
 * with the account, month and transaction in the address.
 */

const chip = "chip gray";

function RowLine({ row, href, bucket }: { row: BankingReviewRow; href: string | null; bucket: BankingReviewBucketName }) {
  const plan = planLine(row);
  const flags = row.flags;
  const name = row.displayName || row.description;
  const note = classificationNote(row);
  // (F4) A row that compares with its plan leads with the DIFFERENCE; the full amount is secondary.
  const variance = row.plan ? varianceShort(row.plan) : null;
  const pinches = row.plan?.varianceKind ? variancePinches(row.plan.varianceKind) : false;
  return (
    <li className="px-4 py-2.5" data-testid={`br-row-${row.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-label tabular-nums text-neutral-500">{dayWords(row.date)}</span>
            {href ? (
              <Link href={href} className="press truncate text-body font-medium text-brand-navy hover:underline" data-testid={`br-link-${row.id}`}>
                {name}
              </Link>
            ) : (
              <span className="truncate text-body font-medium text-brand-ink">{name}</span>
            )}
            {row.pending ? <span className={chip}>Pending</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-neutral-500">
            <span data-testid={`br-cat-${row.id}`}>{row.category ? (row.category.name ?? "Category removed") : "No category"}</span>
            {bucket === "uncertain" && REASON_WORDS[row.reason] ? <span className={chip}>{REASON_WORDS[row.reason]}</span> : null}
            {flags.unplannedAllowance ? <span className={chip}>Unplanned allowance</span> : null}
            {flags.reimbursable ? <span className={chip}>Reimbursable</span> : null}
          </div>
          {plan ? <div className="mt-1 text-micro text-neutral-600" data-testid={`br-plan-${row.id}`}>{plan}</div> : null}
          {note ? (
            <div className="mt-1 text-micro text-neutral-700" data-testid={`br-issue-${row.id}`}>
              {note} ·{" "}
              <Link href="/review/categories" className="font-semibold text-brand-navy underline">Categories</Link>
            </div>
          ) : null}
        </div>
        {variance && row.plan ? (
          <span className="shrink-0 text-right" data-testid={`br-variance-box-${row.id}`}>
            <span className={`block font-mono text-body font-semibold tabular-nums ${pinches ? "text-bad-ink" : "text-brand-navy"}`} data-testid={`br-variance-${row.id}`}>{variance}</span>
            <span className="block font-mono text-micro tabular-nums text-neutral-500" data-testid={`br-amount-${row.id}`}>{formatCurrency(row.amount)}</span>
          </span>
        ) : (
          <span className="shrink-0 font-mono text-body tabular-nums text-brand-ink" data-testid={`br-amount-${row.id}`}>
            {formatCurrency(row.amount)}
          </span>
        )}
      </div>
    </li>
  );
}

function Chunk({
  base,
  cursor,
  last,
  onMore,
  hrefOf,
  bucket,
  seed,
}: {
  base: GetBankingReviewParams;
  cursor: string | undefined;
  last: boolean;
  onMore: (cursor: string) => void;
  hrefOf: (row: BankingReviewRow) => string | null;
  bucket: BankingReviewBucketName;
  seed?: BucketSeed | null;
}) {
  const qc = useQueryClient();
  const params: GetBankingReviewParams = { ...base, limit: PAGE, ...(cursor ? { cursor } : {}) };
  // (P4) The first page rides in the summary: no second review on first load.
  // Its "Show more" needs the server's cursor, which only the paged request
  // returns, so that one request is made when the owner reaches for it.
  const seeded = !!seed && cursor === undefined;
  const q = useGetBankingReview(params, { query: { queryKey: getGetBankingReviewQueryKey(params), staleTime: MIN, enabled: !seeded } });
  const page = q.data?.page ?? null;
  const cursorOf = () => qc.fetchQuery({ queryKey: getGetBankingReviewQueryKey(params), queryFn: () => getBankingReview(params), staleTime: MIN });
  if (seeded && seed) {
    return (
      <>
        {seed.rows.map((r) => <RowLine key={r.id} row={r} href={hrefOf(r)} bucket={bucket} />)}
        {last && seed.truncated ? (
          <li className="px-4 py-3">
            <button
              type="button"
              className="press rounded-control px-3 py-1.5 text-label font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-neutral-50"
              onPointerEnter={() => void cursorOf().catch(() => {})}
              onFocus={() => void cursorOf().catch(() => {})}
              onClick={() => void cursorOf().then((r) => r.page?.nextCursor && onMore(r.page.nextCursor)).catch(() => {})}
              data-testid="br-more"
            >
              Show more
            </button>
          </li>
        ) : null}
      </>
    );
  }
  if (!q.data) {
    return q.isError ? (
      <li className="px-4 py-3 text-body text-neutral-700" role="alert">
        These rows did not load.{" "}
        <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button>
      </li>
    ) : (
      <li className="px-4 py-3"><div className="skeleton h-12 w-full rounded-card" aria-busy="true" /></li>
    );
  }
  return (
    <>
      {(page?.rows ?? []).map((r) => <RowLine key={r.id} row={r} href={hrefOf(r)} bucket={bucket} />)}
      {last && page?.nextCursor ? (
        <li className="px-4 py-3">
          <button
            type="button"
            className="press rounded-control px-3 py-1.5 text-label font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-neutral-50"
            onClick={() => onMore(page.nextCursor as string)}
            data-testid="br-more"
          >
            Show more
          </button>
        </li>
      ) : null}
    </>
  );
}

/** One bucket's first page, as the summary already returned it. */
export type BucketSeed = { rows: BankingReviewRow[]; truncated: boolean };

export function BucketRows({
  base,
  bucket,
  kind,
  cursors,
  onMore,
  hrefOf,
  empty,
  seed,
}: {
  base: GetBankingReviewParams;
  bucket: BankingReviewBucketName;
  kind: BankingReviewKind | null;
  cursors: string[];
  onMore: (cursor: string) => void;
  hrefOf: (row: BankingReviewRow) => string | null;
  /** True when the bucket holds no rows at all. */
  empty: boolean;
  /** The summary's own rows for this bucket; used for the first page when no kind is chosen. */
  seed?: BucketSeed | null;
}) {
  if (empty) return <div className={emptyNote} data-testid="br-empty">Nothing here for this range.</div>;
  const pageBase: GetBankingReviewParams = { ...base, bucket, ...(kind ? { kind } : {}) };
  const all: Array<string | undefined> = [undefined, ...cursors];
  return (
    <ul className="divide-y divide-brand-line/70" data-testid="br-rows">
      {all.map((c, i) => (
        <Chunk key={c ?? "first"} base={pageBase} cursor={c} last={i === all.length - 1} onMore={onMore} hrefOf={hrefOf} bucket={bucket} seed={kind ? null : seed} />
      ))}
    </ul>
  );
}

import { Link } from "wouter";
import type {
  BankingReviewBucketName,
  BankingReviewKind,
  BankingReviewRow,
  GetBankingReviewParams,
} from "@workspace/api-client-react/features";
import { getGetBankingReviewQueryKey, useGetBankingReview } from "@workspace/api-client-react/features";
import { emptyNote } from "@/ui";
import { formatCurrency } from "@/lib/utils";
import { dayWords, planLine, REASON_WORDS } from "./words";

/**
 * (W3) One bucket's rows, paged by the server (`bucket` + `cursor`). Each page
 * is its own component and query, so "Show more" only adds one; nothing here
 * adds a figure up. A row opens its register (`href` from the one route rule)
 * with the account, month and transaction in the address.
 */
const PAGE = 25;
const MIN = 60_000;

const chip = "chip gray";

function RowLine({ row, href, bucket }: { row: BankingReviewRow; href: string | null; bucket: BankingReviewBucketName }) {
  const plan = planLine(row);
  const flags = row.flags;
  const name = row.displayName || row.description;
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
        </div>
        <span className="shrink-0 font-mono text-body tabular-nums text-brand-ink" data-testid={`br-amount-${row.id}`}>
          {formatCurrency(row.amount)}
        </span>
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
}: {
  base: GetBankingReviewParams;
  cursor: string | undefined;
  last: boolean;
  onMore: (cursor: string) => void;
  hrefOf: (row: BankingReviewRow) => string | null;
  bucket: BankingReviewBucketName;
}) {
  const params: GetBankingReviewParams = { ...base, limit: PAGE, ...(cursor ? { cursor } : {}) };
  const q = useGetBankingReview(params, { query: { queryKey: getGetBankingReviewQueryKey(params), staleTime: MIN } });
  const page = q.data?.page ?? null;
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

export function BucketRows({
  base,
  bucket,
  kind,
  cursors,
  onMore,
  hrefOf,
  empty,
}: {
  base: GetBankingReviewParams;
  bucket: BankingReviewBucketName;
  kind: BankingReviewKind | null;
  cursors: string[];
  onMore: (cursor: string) => void;
  hrefOf: (row: BankingReviewRow) => string | null;
  /** True when the bucket holds no rows at all. */
  empty: boolean;
}) {
  if (empty) return <div className={emptyNote} data-testid="br-empty">Nothing here for this range.</div>;
  const pageBase: GetBankingReviewParams = { ...base, bucket, ...(kind ? { kind } : {}) };
  const all: Array<string | undefined> = [undefined, ...cursors];
  return (
    <ul className="divide-y divide-brand-line/70" data-testid="br-rows">
      {all.map((c, i) => (
        <Chunk key={c ?? "first"} base={pageBase} cursor={c} last={i === all.length - 1} onMore={onMore} hrefOf={hrefOf} bucket={bucket} />
      ))}
    </ul>
  );
}

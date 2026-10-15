import { useEffect, useRef, useState } from "react";
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
import { formatDisplayAmount } from "@/lib/amountDisplay";
import { BANKING_MIN as MIN, BANKING_PAGE as PAGE } from "./reviewParams";
import { classificationNote, dayWords, planLine, REASON_WORDS, varianceShort, variancePinches } from "./words";

/**
 * (W3) One bucket's rows, paged by the server (`bucket` + `cursor`). Each page
 * is its own component and query, so "Show more" only adds one; nothing here
 * adds a figure up. A row opens its register (`href` from the one route rule)
 * with the account, month and transaction in the address.
 */

const chip = "chip gray";

/**
 * "Show more": pending ("Loading…", ignores a second click, aria-busy) and failed ("Couldn't load more. Try again",
 * an alert) are both said. `load` resolves when the next page is on its way; a rejection is the failure.
 */
function MoreButton({ load, onHover }: { load: () => Promise<void>; onHover?: () => void }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const go = () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    load().catch(() => alive.current && setFailed(true)).finally(() => alive.current && setPending(false));
  };
  return (
    <li className="px-4 py-3">
      <button
        type="button"
        className="press rounded-control px-3 py-1.5 text-label font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-neutral-50"
        onPointerEnter={onHover}
        onFocus={onHover}
        onClick={go}
        aria-busy={pending}
        data-testid="br-more"
      >
        {pending ? "Loading…" : "Show more"}
      </button>
      {failed ? <span className="ml-3 text-label text-bad-ink" role="alert" data-testid="br-more-error">Couldn't load more. Try again</span> : null}
    </li>
  );
}

function RowLine({ row, href, bucket, first }: { row: BankingReviewRow; href: string | null; bucket: BankingReviewBucketName; first?: React.RefObject<HTMLLIElement | null> }) {
  const plan = planLine(row);
  const flags = row.flags;
  const name = row.displayName || row.description;
  const note = classificationNote(row);
  // (F4) A row that compares with its plan leads with the DIFFERENCE; the full amount is secondary.
  const variance = row.plan ? varianceShort(row.plan) : null;
  const pinches = row.plan?.varianceKind ? variancePinches(row.plan.varianceKind) : false;
  return (
    <li ref={first} tabIndex={first ? -1 : undefined} className="px-4 py-2.5 focus:outline-none" data-testid={`br-row-${row.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-label tabular-nums text-neutral-600">{dayWords(row.date)}</span>
            {href ? (
              <Link href={href} className="press truncate text-body font-medium text-brand-navy hover:underline" data-testid={`br-link-${row.id}`}>
                {name}
              </Link>
            ) : (
              <span className="truncate text-body font-medium text-brand-ink">{name}</span>
            )}
            {row.pending ? <span className={chip}>Pending</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-neutral-600">
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
            <span className="block font-mono text-micro tabular-nums text-neutral-600" data-testid={`br-amount-${row.id}`}>{formatDisplayAmount(Number(row.amount))}</span>
          </span>
        ) : (
          <span className="shrink-0 font-mono text-body tabular-nums text-brand-ink" data-testid={`br-amount-${row.id}`}>
            {formatDisplayAmount(Number(row.amount))}
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
  // (Q4) An answer that lands after this page's scope changed (account, range,
  // bucket: the Chunk unmounts) is dropped: its cursor belongs to the old rows.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const cursorOf = () => qc.fetchQuery({ queryKey: getGetBankingReviewQueryKey(params), queryFn: () => getBankingReview(params), staleTime: MIN });
  // Rows added by "Show more": focus lands on the first new row once its page arrives (the old button is gone).
  const firstRow = useRef<HTMLLIElement | null>(null);
  const added = cursor !== undefined;
  const arrived = !!q.data;
  useEffect(() => {
    if (!added || !arrived) return;
    const el = firstRow.current;
    (el?.querySelector("a") ?? el)?.focus({ preventScroll: false });
  }, [added, arrived]);
  if (seeded && seed) {
    return (
      <>
        {seed.rows.map((r) => <RowLine key={r.id} row={r} href={hrefOf(r)} bucket={bucket} />)}
        {last && seed.truncated ? (
          <MoreButton
            onHover={() => void cursorOf().catch(() => {})}
            load={async () => {
              const r = await cursorOf();
              if (live.current && r.page?.nextCursor) onMore(r.page.nextCursor);
            }}
          />
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
      {(page?.rows ?? []).map((r, i) => <RowLine key={r.id} row={r} href={hrefOf(r)} bucket={bucket} first={i === 0 && added ? firstRow : undefined} />)}
      {last && page?.nextCursor ? <MoreButton load={async () => onMore(page.nextCursor as string)} /> : null}
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

import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Panel } from "@/components/next";
import { useSpine } from "@/hooks/useSpine";
import { useDuplicateCountQ, useReviewQueueQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { Empty, Gate, rise } from "./shared";

const ROW_CLASS =
  "flex items-baseline justify-between gap-2 rounded-control px-2 py-1.5 text-label hover:bg-platinum-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";

/** (F1) The categorization queue's own screen, Review › Categories. It replaced
 *  the temporary link out to the old app's `/activity/review`. */
export const CATEGORIZATION_QUEUE_HREF = "/review/categories";

function Row({ href, count, label, testid, external }: { href: string; count: number; label: string; testid: string; external?: boolean }) {
  const inner = (
    <>
      <span>{label}</span>
      <span className="font-mono tabular-nums font-semibold text-brand-navy">{count}</span>
    </>
  );
  return (
    <li>
      {external ? (
        <a href={href} data-testid={testid} className={ROW_CLASS}>{inner}</a>
      ) : (
        <Link href={href} data-testid={testid} className={ROW_CLASS}>{inner}</Link>
      )}
    </li>
  );
}

/** A source that has not answered is never a zero. */
function PendingRow({ failed, label, testid, onRetry }: { failed: boolean; label: string; testid: string; onRetry?: () => void }) {
  return (
    <li data-testid={testid} className="flex items-baseline justify-between gap-2 px-2 py-1.5 text-label text-neutral-600">
      <span>{label}</span>
      {failed ? (
        <span role="alert">
          did not load
          {onRetry ? (
            <button type="button" onClick={onRetry} className="ml-2 font-semibold text-brand-navy underline">Try again</button>
          ) : null}
        </span>
      ) : (
        <span aria-busy="true">loading…</span>
      )}
    </li>
  );
}

export default function ReviewPanel() {
  const spine = useSpine();
  const queue = useReviewQueueQ();
  const dups = useDuplicateCountQ();
  const q = { data: spine.data, isError: spine.state === "failed", refetch: spine.refetch };
  const review = spine.data?.reviewCount ?? 0;
  const cat = queue.data?.total ?? 0;
  const dup = dups.data?.duplicateCount ?? 0;
  // (D20) A queue that is still loading or failed is not "nothing waiting".
  const catKnown = queue.data !== undefined;
  const dupKnown = dups.data !== undefined;
  return (
    <Panel title="Needs review" span={4} className={cn(rise(BELOW_FOLD.review.rise), BELOW_FOLD.review.minH)} data-testid="dash-review">
      <Gate q={q} what="Review" rows={3}>
        {() =>
          review + cat + dup === 0 && catKnown && dupKnown ? (
            <Empty>Nothing is waiting on a decision.</Empty>
          ) : (
            <ul className="list-none space-y-1 p-0">
              {review > 0 ? <Row href="/review" count={review} label="Charges to match to the forecast" testid="dash-review-forecast" /> : null}
              {!catKnown ? (
                <PendingRow failed={!!queue.isError} label="Categories to confirm" testid="dash-review-cats-pending" onRetry={queue.refetch ? () => void queue.refetch() : undefined} />
              ) : cat > 0 ? (
                <Row href={CATEGORIZATION_QUEUE_HREF} count={cat} label="Categories to confirm" testid="dash-review-cats" />
              ) : null}
              {!dupKnown ? (
                <PendingRow failed={!!dups.isError} label="Possible duplicates" testid="dash-review-dups-pending" onRetry={dups.refetch ? () => void dups.refetch() : undefined} />
              ) : dup > 0 ? (
                <Row href="/transactions" count={dup} label="Possible duplicates" testid="dash-review-dups" />
              ) : null}
            </ul>
          )
        }
      </Gate>
    </Panel>
  );
}

import { Link } from "wouter";
import { Panel } from "@/components/next";
import { useSpine } from "@/hooks/useSpine";
import { useDuplicateCountQ, useReviewQueueQ } from "./queries";
import { Empty, Gate, rise } from "./shared";

function Row({ href, count, label, testid }: { href: string; count: number; label: string; testid: string }) {
  return (
    <li>
      <Link href={href} data-testid={testid}
        className="flex items-baseline justify-between gap-2 rounded-control px-2 py-1.5 text-label hover:bg-platinum-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40">
        <span>{label}</span>
        <span className="font-mono tabular-nums font-semibold text-brand-navy">{count}</span>
      </Link>
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
  return (
    <Panel title="Needs review" span={4} className={rise(7)} data-testid="dash-review">
      <Gate q={q} what="Review" rows={3}>
        {() =>
          review + cat + dup === 0 ? (
            <Empty>Nothing is waiting on a decision.</Empty>
          ) : (
            <ul className="list-none space-y-1 p-0">
              {review > 0 ? <Row href="/review" count={review} label="Charges to match to the forecast" testid="dash-review-forecast" /> : null}
              {cat > 0 ? <Row href="/review" count={cat} label="Categories to confirm" testid="dash-review-cats" /> : null}
              {dup > 0 ? <Row href="/transactions" count={dup} label="Possible duplicates" testid="dash-review-dups" /> : null}
            </ul>
          )
        }
      </Gate>
    </Panel>
  );
}

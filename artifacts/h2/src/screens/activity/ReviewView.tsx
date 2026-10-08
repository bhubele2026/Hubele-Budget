import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListCategorizationReviewQueryKey,
  useAcceptCategorizationDecision,
  useCorrectCategorizationDecision,
  useSkipCategorizationDecision,
  type Category,
  type ReviewItem,
} from "@workspace/api-client-react";
import { reviewParams, useCategoryList, useInvalidateActivity, useReviewQueue } from "@/data/activityData";
import { Link } from "wouter";
import { Button, buttonClass } from "@/kit/Button";
import { CategoryChip } from "@/kit/CategoryChip";
import { Note, RefreshNote } from "@/kit/Note";
import { SkeletonLine } from "@/kit/Skeleton";
import { useToast } from "@/kit/Toast";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { shortDate } from "@/lib/dates";
import { cx } from "@/lib/cx";
import { CategoryPickerSheet } from "./CategoryPickerSheet";
import { titleCase, reviewFlags, reviewWhy } from "./words";

const byOldest = (a: ReviewItem, b: ReviewItem) =>
  a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/**
 * ⭐ THE REVIEW QUEUE — what H2 was not sure about, oldest first, twenty at a
 * time. Each item is a row with H2's proposed category (provisional) and one
 * line on why, then three controls: Accept (keep it), Change (pick another),
 * Skip (leave it for later). Keys: j/k move, a accept, c change, s skip.
 *
 * A resolved item leaves the list at once; if the server refuses, it comes
 * back with a notice. The queue and the nav badge refetch after every answer.
 */
export function ReviewView({ now }: { now?: Date }) {
  const queue = useReviewQueue();
  const categories = useCategoryList();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useInvalidateActivity();
  const accept = useAcceptCategorizationDecision();
  const skip = useSkipCategorizationDecision();
  const correct = useCorrectCategorizationDecision();

  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [at, setAt] = useState(0);
  const [changing, setChanging] = useState<ReviewItem | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const cats: readonly Category[] = categories.data ?? [];
  const names = useMemo(() => new Map(cats.map((c) => [c.id, c.name] as const)), [cats]);
  const items = useMemo(
    () => [...(queue.data?.items ?? [])].sort(byOldest).filter((i) => !gone.has(i.decisionId)),
    [queue.data, gone],
  );
  const cursor = Math.min(at, Math.max(0, items.length - 1));

  const leave = (id: string, on: boolean) =>
    setGone((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const answer = async (item: ReviewItem, kind: "accept" | "skip" | "correct", category?: Category) => {
    leave(item.decisionId, true);
    const name = (kind === "correct" ? category?.name : names.get(item.suggestedCategoryId ?? "")) ?? null;
    try {
      if (kind === "accept") await accept.mutateAsync({ decisionId: item.decisionId });
      else if (kind === "skip") await skip.mutateAsync({ decisionId: item.decisionId });
      else await correct.mutateAsync({ decisionId: item.decisionId, data: { categoryId: category!.id } });
      refresh();
      void qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey(reviewParams) });
      if (kind !== "skip" && name) toast.show({ message: `Filed under ${name}. H2 will remember ${titleCase(item.description)}.` });
    } catch {
      leave(item.decisionId, false);
      toast.show({ message: "Couldn't save that answer. It's still in the queue.", tone: "error" });
    }
  };

  // j/k move, a accepts, s skips, c changes — never while typing or a sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || changing) return;
      if (document.querySelector('[role="dialog"]')) return;
      const item = items[cursor];
      if (e.key === "j") setAt(Math.min(cursor + 1, items.length - 1));
      else if (e.key === "k") setAt(Math.max(cursor - 1, 0));
      else if (!item) return;
      else if (e.key === "a" && item.suggestedCategoryId) void answer(item, "accept");
      else if (e.key === "s") void answer(item, "skip");
      else if (e.key === "c") setChanging(item);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cursor, changing]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  if (queue.state === "cold") {
    return (
      <div className="flex flex-col gap-4 py-2" data-testid="review-skeleton" aria-busy="true">
        <SkeletonLine className="w-64" />
        <SkeletonLine className="w-80" />
        <SkeletonLine className="w-56" />
      </div>
    );
  }
  if (queue.state === "failed") {
    return (
      <Note kind="error" onRetry={queue.refetch} retrying={queue.isFetching}>
        Couldn't load the review queue.
      </Note>
    );
  }

  const total = queue.data?.total ?? 0;
  return (
    <div className="flex flex-col gap-3" data-testid="review">
      <p className="type-caption text-ink-3" data-testid="automation-link">
        <Link href="/household/automation" className={buttonClass({ variant: "link", size: "sm" })}>
          How filing works and what the model may do → Automation
        </Link>
      </p>
      <RefreshNote state={queue.state} updatedAt={null} onRetry={queue.refetch} retrying={queue.isFetching} now={now} />
      {items.length === 0 ? (
        <Note kind="empty" data-testid="review-empty">
          Nothing to review. H2 filed everything it was sure about.
        </Note>
      ) : (
        <>
          <p className="type-caption text-ink-3" data-testid="review-count">
            <span className="tnum">{total}</span> to review
            {total > items.length && (
              <>
                {" "}
                · showing <span className="tnum">{items.length}</span>
              </>
            )}
            <span className="hidden md:inline"> · j / k to move · a accept · c change · s skip</span>
          </p>
          <ul ref={listRef} data-testid="review-items">
            {items.map((item, i) => {
              const amount = toAmount(item.amount);
              const proposed = item.suggestedCategoryId ? (names.get(item.suggestedCategoryId) ?? "Unknown category") : null;
              const flags = reviewFlags(item.flags);
              const here = i === cursor;
              return (
                <li
                  key={item.decisionId}
                  aria-current={here ? "true" : undefined}
                  onClick={() => setAt(i)}
                  className={cx("relative border-t border-l-2 border-t-rule py-4 pl-3 first:border-t-0", here ? "border-l-moss" : "border-l-transparent")}
                  data-testid="review-item"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate type-body text-ink">{item.description}</p>
                      <p className="type-caption text-ink-3">
                        {shortDate(item.occurredOn)}
                        {item.account ? ` · ${item.account}` : ""}
                      </p>
                    </div>
                    {amount != null && (
                      <data value={centsValue(amount)} className="shrink-0 type-figure-sm text-ink">
                        {amount > 0 ? `+${fmtMoney(amount)}` : fmtMoney(amount)}
                      </data>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <CategoryChip name={proposed} provisional={proposed != null} data-testid="review-chip" />
                    <span className="type-caption text-ink-2" data-testid="review-why">
                      {reviewWhy(item)}
                    </span>
                    {flags.map((f) => (
                      <span key={f} className="type-caption text-clay" data-testid="review-flag">
                        {f}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.suggestedCategoryId && (
                      <Button variant="primary" size="sm" onClick={() => answer(item, "accept")} data-testid="review-accept">
                        Accept
                      </Button>
                    )}
                    <Button variant="quiet" size="sm" onClick={() => setChanging(item)} data-testid="review-change">
                      Change
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => answer(item, "skip")} data-testid="review-skip">
                      Skip
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <CategoryPickerSheet
        open={changing != null}
        onOpenChange={(o) => !o && setChanging(null)}
        categories={cats}
        currentId={changing?.suggestedCategoryId}
        title="Change category"
        description={changing?.description}
        onPick={(c) => {
          const item = changing;
          setChanging(null);
          if (item) void answer(item, "correct", c);
        }}
      />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getListCategoriesQueryKey, getListCategorizationReviewQueryKey, useListCategories, type Category, type ReviewItem } from "@workspace/api-client-react";
import {
  listLearnedRules,
  getListLearnedRulesQueryKey,
  useAcceptCategorizationDecision,
  useApplyLearnedRuleRetroactively,
  useCorrectCategorizationDecision,
  useSkipCategorizationDecision,
  useUndoCategoryDecision,
  type LearnedRule,
  type ReviewResolution,
} from "@workspace/api-client-react/features";
import { PageGrid, Panel } from "@/components/next";
import { CategoryPickerDialog } from "@/components/review/CategoryPickerDialog";
import { toastWithActions } from "@/components/ui/action-toast";
import { useCategorizationQueue } from "@/hooks/useCategorizationQueue";
import { toast } from "@/hooks/use-toast";
import { shortDate } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { byOldest, filedWords, isTyping, reviewFlags, reviewWhy } from "@/lib/reviewQueue";
import { cn } from "@/lib/utils";
import { btn, btnLink, btnSecondary, emptyNote, errorBanner } from "@/ui";

/**
 * ⭐ REVIEW › CATEGORIES — what H2 was not sure about, oldest first, twenty at a
 * time. Each item is a row with H2's proposed category (provisional), one line
 * on why, and three controls: Accept (keep it), Change (pick another), Skip
 * (leave it for later). Keys: j/k move, a accept, c change, s skip.
 *
 * A resolved item leaves the list at once; if the server refuses, it comes
 * back with a notice. Accept and Change say what H2 will remember and offer
 * Undo, and, when the server reports similar unlocked charges, "Apply to N
 * similar" (moves nothing until pressed). The queue and the nav badge refetch
 * after every answer. (F1; ported from h2's `screens/activity/ReviewView.tsx`.)
 *
 * Three different queues stay distinct: `/review` is the forecast bank-match
 * inbox, the Chase review inbox marks charges reviewed, and this one is
 * category decisions.
 */

/** Find the learned rule an answer just wrote, to apply it to similar charges. */
export function findRule(rules: readonly LearnedRule[], categoryId: string, description: string): LearnedRule | null {
  const text = description.toLowerCase();
  const mine = rules.filter((r) => !r.disabled && r.categoryId === categoryId && r.signature && text.includes(r.signature.toLowerCase()));
  return (mine.find((r) => r.scope === "merchant") ?? mine[0]) ?? null;
}

export default function ReviewCategoriesPage() {
  const queue = useCategorizationQueue();
  const categories = useListCategories({ query: { queryKey: getListCategoriesQueryKey(), staleTime: 10 * 60_000, gcTime: 30 * 60_000 } });
  const qc = useQueryClient();
  const accept = useAcceptCategorizationDecision();
  const skip = useSkipCategorizationDecision();
  const correct = useCorrectCategorizationDecision();
  const undoDecision = useUndoCategoryDecision();
  const applyRule = useApplyLearnedRuleRetroactively();

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
  const refresh = () => void qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey() });

  const leave = (id: string, on: boolean) =>
    setGone((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const offerFollowUps = async (item: ReviewItem, res: ReviewResolution, category: { id: string; name: string }) => {
    const undo = res.userDecisionId
      ? {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await undoDecision.mutateAsync({ id: res.userDecisionId! });
                leave(item.decisionId, false);
                refresh();
                toast({ title: "Put back." });
              } catch {
                toast({ title: "Couldn't undo that. The new category stays.", variant: "destructive" });
              }
            })();
          },
        }
      : null;
    const similar = res.retroactiveCandidates?.count ?? 0;
    let rule: LearnedRule | null = null;
    if (similar > 0) {
      try {
        const rules = await qc.fetchQuery({
          queryKey: getListLearnedRulesQueryKey(),
          queryFn: ({ signal }) => listLearnedRules({ signal }),
          staleTime: 0,
        });
        rule = findRule(rules, category.id, item.description);
      } catch {
        rule = null;
      }
    }
    const applyBtn =
      rule && similar > 0
        ? {
            label: `Apply to ${similar} similar`,
            onClick: () => {
              void (async () => {
                try {
                  const done = await applyRule.mutateAsync({ id: rule!.id });
                  toast({ title: done.updated === 1 ? "Filed 1 similar charge." : `Filed ${done.updated} similar charges.` });
                } catch {
                  toast({ title: "Couldn't apply that to the similar charges.", variant: "destructive" });
                }
              })();
            },
          }
        : null;
    const title = filedWords(category.name, item.description);
    if (undo && applyBtn) toastWithActions({ title, actions: [undo, applyBtn] });
    else if (undo || applyBtn) toastWithActions({ title, actions: [(undo ?? applyBtn)!] });
    else toast({ title });
  };

  const answer = async (item: ReviewItem, kind: "accept" | "skip" | "correct", category?: Category) => {
    leave(item.decisionId, true);
    const chosenId = kind === "correct" ? category?.id : (item.suggestedCategoryId ?? undefined);
    const name = (kind === "correct" ? category?.name : names.get(item.suggestedCategoryId ?? "")) ?? null;
    try {
      let res: ReviewResolution;
      if (kind === "accept") res = await accept.mutateAsync({ decisionId: item.decisionId });
      else if (kind === "skip") res = await skip.mutateAsync({ decisionId: item.decisionId });
      else res = await correct.mutateAsync({ decisionId: item.decisionId, data: { categoryId: category!.id } });
      refresh();
      if (kind !== "skip" && name && chosenId) void offerFollowUps(item, res, { id: chosenId, name });
    } catch {
      leave(item.decisionId, false);
      toast({ title: "Couldn't save that answer. It's still in the queue.", variant: "destructive" });
    }
  };

  // j/k move, a accepts, s skips, c changes — never while typing or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || changing) return;
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

  const cold = !queue.data && !queue.isError;
  const failed = !queue.data && queue.isError;
  const total = queue.data?.total ?? 0;

  return (
    <div className="space-y-4" data-testid="review-categories">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold text-brand-navy">Categories to confirm</h1>
        <Link href="/settings?tab=automation" className={btnLink} data-testid="automation-link">
          How filing works and what the model may do
        </Link>
      </div>
      <PageGrid>
        <Panel
          title="Review queue"
          sub="Oldest first. H2 files what it is sure about and asks about the rest."
          span={12}
          variant={["static", "flush"]}
          data-testid="review-queue-panel"
        >
          {cold ? (
            <div className={emptyNote} aria-busy="true" data-testid="review-skeleton">
              Loading…
            </div>
          ) : failed ? (
            <div className="p-4">
              <div className={errorBanner} role="alert" data-testid="review-failed">
                Couldn't load the review queue.{" "}
                <button type="button" className={btnLink} onClick={() => void queue.refetch()}>
                  Try again
                </button>
              </div>
            </div>
          ) : items.length === 0 ? (
            <p className={emptyNote} data-testid="review-empty">
              Nothing to review. H2 filed everything it was sure about.
            </p>
          ) : (
            <>
              <p className="border-b border-brand-line px-4 py-2 text-micro text-neutral-500" data-testid="review-count">
                <span className="font-mono tabular-nums">{total}</span> to review
                {total > items.length && (
                  <>
                    {" "}
                    · showing <span className="font-mono tabular-nums">{items.length}</span>
                  </>
                )}
                <span className="hidden md:inline"> · j / k to move · a accept · c change · s skip</span>
              </p>
              <ul ref={listRef} data-testid="review-items" className="list-none p-0">
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
                      className={cn(
                        "relative border-t border-l-2 border-t-brand-line px-4 py-3 first:border-t-0",
                        here ? "border-l-brand-orange bg-platinum-3/60" : "border-l-transparent",
                      )}
                      data-testid="review-item"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate text-body font-medium text-brand-navy">{item.description}</p>
                          <p className="text-micro text-neutral-500">
                            {shortDate(item.occurredOn)}
                            {item.account ? ` · ${item.account}` : ""}
                          </p>
                        </div>
                        {amount != null && (
                          <data value={centsValue(amount)} className="shrink-0 font-mono text-label font-semibold tabular-nums text-brand-navy">
                            {amount > 0 ? `+${fmtMoney(amount)}` : fmtMoney(amount)}
                          </data>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span
                          className={cn("chip gray", proposed != null && "border border-dotted border-neutral-400")}
                          data-provisional={proposed != null ? "" : undefined}
                          data-testid="review-chip"
                        >
                          {proposed ?? "Not filed"}
                          {proposed != null && <span className="sr-only"> (provisional)</span>}
                        </span>
                        <span className="text-micro text-neutral-600" data-testid="review-why">
                          {reviewWhy(item)}
                        </span>
                        {flags.map((f) => (
                          <span key={f} className="chip warn" data-testid="review-flag">
                            {f}
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.suggestedCategoryId && (
                          <button type="button" className={btn} onClick={() => void answer(item, "accept")} data-testid="review-accept">
                            Accept
                          </button>
                        )}
                        <button type="button" className={btnSecondary} onClick={() => setChanging(item)} data-testid="review-change">
                          Change
                        </button>
                        <button type="button" className={btnSecondary} onClick={() => void answer(item, "skip")} data-testid="review-skip">
                          Skip
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Panel>
      </PageGrid>
      <CategoryPickerDialog
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

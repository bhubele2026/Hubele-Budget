import { rowExitRef } from "@/lib/motion-page";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListCategorizationReviewQueryKey,
  getListCategoriesQueryKey,
  useListCategories,
  useUpdateTransaction,
  useUpsertForecastResolution,
  type Category,
  type ForecastResolutionReplaced,
  type Transaction,
} from "@workspace/api-client-react";
import {
  undoForecastResolution,
  useAcceptCategorizationDecision,
  useCorrectCategorizationDecision,
  useUndoCategoryDecision,
  type BankingReviewPlanned,
  type ReviewResolution,
} from "@workspace/api-client-react/features";
import { CategoryPickerDialog } from "@/components/review/CategoryPickerDialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toastWithActions } from "@/components/ui/action-toast";
import { toast } from "@/hooks/use-toast";
import { useCategoryFollowUps } from "@/hooks/useCategoryFollowUps";
import { formatDisplayAmount } from "@/lib/amountDisplay";
import { shortDateOfInstant } from "@/lib/dates";
import { isTyping } from "@/lib/reviewQueue";
import { cn } from "@/lib/utils";
import { btnLink, btnSecondarySm, btnSm, emptyNote } from "@/ui";
import { StatusBadge } from "@/components/next/StatusBadge";
import { getAutoDoneQueryKey, getNeedsYouQueryKey, planOccurrenceOf, useAutoDone, useNeedsYou, type AutoDoneItem, type NeedsYouItem } from "./needsYouApi";
import { TxDrawer, type DrawerRow } from "./TxDrawer";
import { dayWords } from "./words";
import { useReadyMark } from "@/lib/perfMarks";

/**
 * ⭐ NEEDS YOU — Banking's one task list (owner, 2026-11-12: "it isn't clear to
 * me how to reconcile and categorize the banking window at all").
 *
 * H2 matches and files the rows it is sure of on its own. What is left is here,
 * oldest first, each with H2's suggested answer and two buttons:
 *   - OK     takes the suggestion: a match writes ONE answer (POST /forecast/resolutions,
 *            matched, with Undo); a category accepts the review item (POST
 *            /categorization/review/:id/accept, with Undo and "Apply to N similar").
 *   - Change opens the right picker: a planned item, "Not a planned payment" or "Add as a
 *            bill" for a match; the category picker for a category.
 * A row with no suggestion has OK off and Change first. Keys: j / k move, Enter = OK,
 * c = Change. A click on the row opens it in place (the drawer): nothing navigates away.
 * An answered row leaves at once; if the server refuses, it comes back with a notice.
 *
 * Every figure is the server's string.
 */

export const NEEDS_YOU_HINT = "Match = this is a planned bill or payment. Category = what kind of spending it is.";

/** (2026-11-12) The list's columns on a desktop — the head row and every row share this one track list. */
const NY_GRID = "grid md:grid-cols-[4rem_minmax(0,1fr)_9.5rem_8.5rem_6.5rem_8rem] md:items-start md:gap-x-4";

const accountOf = (i: NeedsYouItem) => `${i.accountName}${i.mask ? ` ••${i.mask.slice(-4)}` : ""}`;
/** The row's one line: the suggestion (its label is written to follow "Looks like "), else why it waits. */
const thinkWords = (i: NeedsYouItem) => (i.suggestion ? `Looks like ${i.suggestion.label}` : i.reason);
/** The drawer's lines: the reason in full, and the suggestion only when the reason does not already say it. */
const drawerWords = (i: NeedsYouItem): string[] =>
  i.suggestion && !/looks like/i.test(i.reason) ? [thinkWords(i), i.reason] : [i.reason];

/**
 * "See them": what H2 matched and filed on its own (GET /banking/auto-done), newest first, each with Undo. A match is
 * taken back through its answer's own undo (and the auto-sort never matches that row again); a category goes back to
 * the review queue through its decision's undo.
 */
function AutoDoneList() {
  const q = useAutoDone(true);
  const qc = useQueryClient();
  const undoDecision = useUndoCategoryDecision();
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const undo = async (it: AutoDoneItem) => {
    try {
      if (it.kind === "match") await undoForecastResolution(it.undoId, { restore: [] });
      else await undoDecision.mutateAsync({ id: it.undoId });
      setUndone((s) => new Set(s).add(it.undoId));
      toast({ title: it.kind === "match" ? "Undone. It is back in Needs you." : "Put back. It is back in Needs you." });
    } catch {
      toast({ title: "Couldn't undo that. Nothing was changed.", variant: "destructive" });
    }
    void qc.invalidateQueries({ queryKey: getAutoDoneQueryKey() });
    // An answer moves rows on many screens: everything is marked stale, what is on screen refetches.
    void qc.invalidateQueries();
  };
  if (!q.data) {
    return q.isError ? (
      <p className="text-label text-neutral-700" role="alert">
        Couldn't load what H2 sorted.{" "}
        <button type="button" className={btnLink} onClick={() => void q.refetch()}>Try again</button>
      </p>
    ) : (
      <div className="skeleton h-12 w-full rounded-card" aria-busy="true" />
    );
  }
  if (q.data.items.length === 0) return <p className="text-label text-neutral-600" data-testid="ny-autodone-none">Nothing H2 sorted is left to show.</p>;
  return (
    <>
      <ul className="panel list-none divide-y divide-brand-line p-0" data-testid="ny-autodone-items">
        {q.data.items.map((it) => {
          const gone = undone.has(it.undoId);
          return (
            <li key={`${it.kind}:${it.undoId}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2" data-testid="ny-autodone-item">
              <span className="min-w-0">
                <span className="text-body text-foreground">{it.kind === "match" ? `Matched to ${it.label}` : `Filed under ${it.label}`}</span>
                <span className="ml-2 text-micro text-neutral-600">{shortDateOfInstant(it.at)}</span>
              </span>
              {gone ? (
                <span className="chip gray">Undone</span>
              ) : (
                <button type="button" className={btnLink} onClick={() => void undo(it)} data-testid={`ny-autodone-undo-${it.undoId}`}>
                  Undo
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {q.data.truncated ? <p className="mt-1 text-micro text-neutral-600">Showing the newest {q.data.items.length}.</p> : null}
    </>
  );
}
const shortDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? dayWords(iso.slice(0, 10)) : iso);

/** The planned occurrences a row may be matched to: those not already paid by another row. */
export function matchCandidates(planned: readonly BankingReviewPlanned[] | undefined, amount: string): BankingReviewPlanned[] {
  const out = Number(amount) < 0;
  return (planned ?? []).filter((p) => {
    if (p.fate === "matched" || p.fate === "partial") return false;
    if (p.planned == null) return true;
    return Number(p.planned) < 0 === out;
  });
}

function canOk(i: NeedsYouItem): boolean {
  const s = i.suggestion;
  if (!s) return false;
  if (i.kind === "match") return planOccurrenceOf(s) != null;
  return !!(s.reviewItemId || s.categoryId);
}

/** "Change" for a match: which planned item it is, or not a planned payment at all. */
function MatchChangeDialog({
  item,
  planned,
  onClose,
  onPick,
  onUnplanned,
}: {
  item: NeedsYouItem | null;
  planned: readonly BankingReviewPlanned[] | undefined;
  onClose: () => void;
  onPick: (p: BankingReviewPlanned) => void;
  onUnplanned: () => void;
}) {
  const options = item ? matchCandidates(planned, item.amount) : [];
  const reviewHref = item ? `/review?month=${item.date.slice(0, 7)}` : "/review";
  return (
    <Dialog open={item != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="ny-match-picker">
        <DialogHeader>
          <DialogTitle>Which planned item is this?</DialogTitle>
          <DialogDescription>
            {item ? `${item.name} · ${formatDisplayAmount(Number(item.amount))} · ${dayWords(item.date)}` : ""}
          </DialogDescription>
        </DialogHeader>
        {options.length ? (
          <ul className="divide-y divide-brand-line" data-testid="ny-plan-options">
            {options.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  className="press flex min-h-10 w-full items-center justify-between gap-3 rounded-control px-1 py-2 text-left text-body text-brand-navy hover:bg-platinum-3"
                  onClick={() => onPick(p)}
                  data-testid="ny-plan-option"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.label}</span>
                    <span className="block text-micro text-neutral-600">{p.direction === "in" ? "Expected" : "Due"} {dayWords(p.scheduledDate)}</span>
                  </span>
                  {p.planned != null ? <span className="fig shrink-0 text-label">{formatDisplayAmount(Math.abs(Number(p.planned)))}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={emptyNote} data-testid="ny-plan-none">No planned items are open in this range.</p>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-brand-line pt-3">
          <button type="button" className={btnSecondarySm} onClick={onUnplanned} data-testid="ny-unplanned">
            Not a planned payment
          </button>
          <Link href={reviewHref} className={btnLink} data-testid="ny-add-bill">
            Add as a bill (in Review)
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function NeedsYou({
  planned,
  hrefOfTx,
}: {
  /** This page's planned occurrences (GET /banking/review): the choices "Change" offers a match. */
  planned?: readonly BankingReviewPlanned[];
  /** The register at a row (the one route rule), for the drawer's "Open in register". */
  hrefOfTx?: (tx: Transaction) => string | null;
}) {
  const q = useNeedsYou();
  useReadyMark("h2:banking-needs-you-ready", q.data !== undefined); // (PERF-0) the list is real
  const qc = useQueryClient();
  const categories = useListCategories({ query: { queryKey: getListCategoriesQueryKey(), staleTime: 10 * 60_000, gcTime: 30 * 60_000 } });
  const write = useUpsertForecastResolution();
  const accept = useAcceptCategorizationDecision();
  const correct = useCorrectCategorizationDecision();
  const update = useUpdateTransaction();
  const followUps = useCategoryFollowUps();

  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [at, setAt] = useState(0);
  const [changing, setChanging] = useState<NeedsYouItem | null>(null);
  const [opened, setOpened] = useState<NeedsYouItem | null>(null);
  const [seeDone, setSeeDone] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const moved = useRef(false);

  const cats: readonly Category[] = categories.data ?? [];
  const names = useMemo(() => new Map(cats.map((c) => [c.id, c.name] as const)), [cats]);
  const items = useMemo(() => (q.data?.items ?? []).filter((i) => !gone.has(i.id)), [q.data, gone]);
  const cursor = Math.min(at, Math.max(0, items.length - 1));
  const count = Math.max(0, (q.data?.count ?? 0) - ((q.data?.items ?? []).length - items.length));

  const leave = (id: string, on: boolean) =>
    setGone((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getNeedsYouQueryKey() });
    void qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey() });
  };

  const undoMatch = async (item: NeedsYouItem, id: string, replaced: ForecastResolutionReplaced[]) => {
    try {
      await undoForecastResolution(id, { restore: replaced });
      leave(item.id, false);
      toast({ title: "Undone" });
    } catch {
      toast({ title: "Could not undo", description: "Nothing was changed.", variant: "destructive" });
    }
    // An answer moves rows on many screens: everything is marked stale, what is on screen refetches.
    void qc.invalidateQueries();
  };

  const resolve = async (item: NeedsYouItem, data: Parameters<typeof write.mutateAsync>[0]["data"], title: string) => {
    leave(item.id, true);
    setOpened(null);
    try {
      const r = await write.mutateAsync({ data });
      refresh();
      toastWithActions({
        title,
        duration: 15_000,
        actions: [{ label: "Undo", altText: `Undo: ${title}`, onClick: () => void undoMatch(item, r.id, r.replaced ?? []), "data-testid": "ny-undo" }],
      });
    } catch (e) {
      leave(item.id, false);
      toast({ title: "Couldn't save that answer. It's still in the list.", description: (e as Error).message, variant: "destructive" });
    }
  };

  const fileAs = async (item: NeedsYouItem, categoryId: string, how: "accept" | "correct") => {
    leave(item.id, true);
    setOpened(null);
    const name = names.get(categoryId) ?? item.suggestion?.label ?? "the category";
    const reviewId = item.suggestion?.reviewItemId;
    try {
      if (reviewId) {
        const res: ReviewResolution =
          how === "accept" ? await accept.mutateAsync({ decisionId: reviewId }) : await correct.mutateAsync({ decisionId: reviewId, data: { categoryId } });
        refresh();
        void followUps({ description: item.name }, res, { id: categoryId, name }, () => {
          leave(item.id, false);
          refresh();
        });
      } else {
        // No review item behind it: the same hand pick the register makes (it teaches H2 this merchant too).
        await update.mutateAsync({ id: item.txId, data: { categoryId } });
        refresh();
        toast({ title: `Filed under ${name}.`, description: "H2 remembers this merchant for next time." });
      }
    } catch {
      leave(item.id, false);
      toast({ title: "Couldn't save that answer. It's still in the list.", variant: "destructive" });
    }
  };

  const ok = (item: NeedsYouItem) => {
    if (!canOk(item)) return;
    const s = item.suggestion!;
    if (item.kind === "match") {
      const occ = planOccurrenceOf(s)!;
      void resolve(item, { status: "matched", recurringItemId: occ.recurringItemId, occurrenceDate: occ.occurrenceDate, matchedTxnId: item.txId }, `Matched to ${s.label}`);
    } else {
      // A review item is accepted as H2 proposed it; without one, the suggested category is written by hand.
      void fileAs(item, s.categoryId ?? "", "accept");
    }
  };

  // j / k move, Enter = OK, c = Change — never while typing, on a button or link, or with a dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || changing || opened) return;
      if (document.querySelector('[role="dialog"]')) return;
      const el = e.target as HTMLElement | null;
      if (e.key === "Enter" && el && (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "SUMMARY")) return;
      const item = items[cursor];
      if (e.key === "j") {
        moved.current = true;
        setAt(Math.min(cursor + 1, items.length - 1));
      } else if (e.key === "k") {
        moved.current = true;
        setAt(Math.max(cursor - 1, 0));
      } else if (!item) return;
      else if (e.key === "Enter") ok(item);
      else if (e.key === "c") setChanging(item);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cursor, changing, opened]);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  const drawerRow: DrawerRow | null = opened
    ? { id: opened.txId, date: opened.date, name: opened.name, amount: opened.amount, pending: opened.pending, accountLabel: accountOf(opened) }
    : null;

  const answerButtons = (item: NeedsYouItem, where: "row" | "drawer") => {
    const okOn = canOk(item);
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnSm}
          disabled={!okOn}
          onClick={(e) => {
            e.stopPropagation();
            ok(item);
          }}
          aria-label={okOn ? `OK: ${thinkWords(item)}` : "OK (H2 has no suggestion for this row)"}
          aria-keyshortcuts={where === "row" ? "Enter" : undefined}
          data-testid={`ny-ok-${item.id}${where === "drawer" ? "-drawer" : ""}`}
        >
          OK
        </button>
        <button
          type="button"
          className={okOn ? btnSecondarySm : btnSm}
          onClick={(e) => {
            e.stopPropagation();
            setOpened(null);
            setChanging(item);
          }}
          aria-label={`Change: ${item.name}`}
          aria-keyshortcuts={where === "row" ? "c" : undefined}
          data-testid={`ny-change-${item.id}${where === "drawer" ? "-drawer" : ""}`}
        >
          Change
        </button>
      </div>
    );
  };

  const autoDone = q.data?.autoDone;
  const autoN = autoDone ? autoDone.matched + autoDone.categorized : 0;
  const cold = !q.data && !q.isError;

  return (
    <>
      {/* (2026-11-12) ONE panel, an aligned table-like list: date | description and account | category | state |
          amount (right) | OK · Change. On a phone the same cells wrap into a compact card row. */}
      <section id="needs-you" className="panel scroll-mt-4" aria-labelledby="needs-you-title" data-testid="needs-you">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-brand-line px-4 py-2.5">
          <div className="min-w-0">
            <h2 id="needs-you-title" className="text-title font-semibold text-foreground">
              Needs you{q.data ? <span className="fig ml-1 font-normal text-neutral-600" data-testid="ny-count"> ({count})</span> : null}
            </h2>
            {q.data && items.length > 0 ? (
              <p className="text-micro text-neutral-600" data-testid="ny-hint">{NEEDS_YOU_HINT}</p>
            ) : null}
          </div>
          {items.length > 1 ? <span className="hidden text-micro text-neutral-500 md:inline">j / k to move · Enter = OK · c = Change</span> : null}
        </div>
        {cold ? (
          <div className="space-y-2 p-4" aria-busy="true" data-testid="ny-loading">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-full rounded-control" />)}
          </div>
        ) : !q.data ? (
          <p className="px-4 py-4 text-body text-neutral-700" role="alert" data-testid="ny-failed">
            Couldn't load what needs you.{" "}
            <button type="button" className={btnLink} onClick={() => void q.refetch()}>Try again</button>
          </p>
        ) : items.length === 0 ? (
          <div className="px-4 py-5" data-testid="ny-empty">
            <p className="text-body font-medium text-foreground">All caught up through {shortDay(q.data.throughDate)}.</p>
            <p className="mt-1 text-label text-neutral-600">New bank rows are matched and filed for you when H2 is sure.</p>
          </div>
        ) : (
          <>
            <div aria-hidden className={cn(NY_GRID, "hidden border-b border-brand-line px-4 py-2 text-micro font-medium text-neutral-500 md:grid")}>
              <span>Date</span>
              <span>Description</span>
              <span>Category</span>
              <span>State</span>
              <span className="text-right">Amount</span>
              <span />
            </div>
            <ul ref={listRef} className="list-none divide-y divide-brand-line p-0" data-testid="ny-items">
              {items.map((item, i) => {
                const here = i === cursor;
                return (
                  <li
                    key={item.id}
                    ref={rowExitRef}
                    aria-current={here ? "true" : undefined}
                    onClick={() => {
                      setAt(i);
                      setOpened(item);
                    }}
                    className={cn(
                      "press cursor-pointer border-l-2 px-4 py-3 hover:bg-brand-tint",
                      here ? "border-l-brand-navy bg-brand-tint" : "border-l-transparent",
                    )}
                    data-testid="ny-item"
                    data-kind={item.kind}
                  >
                    <div className={cn(NY_GRID, "grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5")}>
                      <span className="fig pt-px text-label text-neutral-600">{dayWords(item.date)}</span>
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="max-w-full text-left text-body font-medium text-foreground hover:text-brand-navy hover:underline md:truncate"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAt(i);
                            setOpened(item);
                          }}
                          data-testid={`ny-open-${item.id}`}
                        >
                          {item.name}
                        </button>
                        <div className="text-micro text-neutral-600" data-testid={`ny-account-${item.id}`}>{accountOf(item)}</div>
                        <p className="mt-1 text-label text-neutral-700" data-testid={`ny-think-${item.id}`}>{thinkWords(item)}</p>
                      </div>
                      {/* Category and state: one wrapping line under the words on a phone, their own columns on a desktop. */}
                      <div className="col-span-2 col-start-2 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 md:contents">
                        <span className="text-label text-neutral-700 md:pt-px" data-testid={`ny-cat-${item.id}`}>
                          <span className="sr-only">Category: </span>
                          {item.categoryName ?? "No category"}
                        </span>
                        <span className="flex flex-wrap items-start gap-1">
                          <StatusBadge state={canOk(item) ? "suggested" : "unresolved"} title={canOk(item) ? "H2 has a suggested answer" : "Waits for your answer"}>
                            {item.kind === "match" ? "Match" : "Category"}
                          </StatusBadge>
                          {item.pending ? <StatusBadge state="pending" /> : null}
                        </span>
                      </div>
                      <span className="fig col-start-3 row-start-1 shrink-0 text-right text-body font-medium text-foreground md:col-start-auto md:row-start-auto" data-testid={`ny-amount-${item.id}`}>
                        {formatDisplayAmount(Number(item.amount))}
                      </span>
                      <div className="col-span-2 col-start-2 md:col-span-1 md:col-start-auto md:justify-self-end">{answerButtons(item, "row")}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {q.data.truncated && count > items.length ? (
              <p className="border-t border-brand-line px-4 py-2 text-micro text-neutral-600" data-testid="ny-more">
                Showing the first <span className="fig">{items.length}</span> of{" "}
                <span className="fig">{count}</span>. Answer these and the next ones come up.
              </p>
            ) : null}
          </>
        )}
      </section>

      {autoDone && autoN > 0 ? (
        <div className="text-label text-neutral-600" data-testid="ny-autodone">
          <span>
            H2 sorted <span className="fig">{autoN}</span> {autoN === 1 ? "row" : "rows"} for you since {shortDay(autoDone.since)}
          </span>
          {" · "}
          <button type="button" className={btnLink} aria-expanded={seeDone} onClick={() => setSeeDone((v) => !v)} data-testid="ny-see-them">
            {seeDone ? "Hide them" : "See them"}
          </button>
          {seeDone ? (
            <div className="mt-2" data-testid="ny-autodone-list">
              <AutoDoneList />
            </div>
          ) : null}
        </div>
      ) : null}

      <TxDrawer row={drawerRow} onOpenChange={(o) => !o && setOpened(null)} hrefOfTx={hrefOfTx}>
        {opened ? (
          <div className="space-y-2" data-testid="ny-drawer-answer">
            {drawerWords(opened).map((w, i) => (
              <p key={i} className={i === 0 ? "text-label text-neutral-700" : "text-micro text-neutral-600"} data-testid="ny-drawer-words">{w}</p>
            ))}
            {answerButtons(opened, "drawer")}
          </div>
        ) : null}
      </TxDrawer>

      <MatchChangeDialog
        item={changing?.kind === "match" ? changing : null}
        planned={planned}
        onClose={() => setChanging(null)}
        onPick={(p) => {
          const item = changing!;
          setChanging(null);
          void resolve(item, { status: "matched", recurringItemId: p.itemId, occurrenceDate: p.occurrenceDate, matchedTxnId: item.txId }, `Matched to ${p.label} · ${dayWords(p.scheduledDate)}`);
        }}
        onUnplanned={() => {
          const item = changing!;
          setChanging(null);
          void resolve(item, { status: "ignored_unforecasted", matchedTxnId: item.txId }, "Not a planned payment");
        }}
      />
      <CategoryPickerDialog
        open={changing?.kind === "category"}
        onOpenChange={(o) => !o && setChanging(null)}
        categories={cats}
        currentId={changing?.suggestion?.categoryId}
        title="Change category"
        description={changing?.name}
        onPick={(c) => {
          const item = changing;
          setChanging(null);
          if (item) void fileAs(item, c.id, "correct");
        }}
      />
    </>
  );
}

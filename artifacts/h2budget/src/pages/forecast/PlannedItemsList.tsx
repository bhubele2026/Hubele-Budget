import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { offsetWithinScroller, shellScrollerOf } from "@/lib/shellScroll";
import type { PlanLine } from "@/lib/forecastMatch";
import type { PayoffInfo, PayoffTransition } from "@/lib/forecastDebts";
import { CashFreedBanner } from "./CashFreedBanner";
import { PlanDropRow } from "./PlanDropRow";
import type { SuggestionAnswer } from "./probablyPaidText";
import type { HookPayoffLine } from "@/lib/forecastHooks";

/**
 * (#618) Flat item descriptor for the virtualized "Planned forecast items"
 * list. We pre-flatten plan rows + payoff transition banners once per
 * register change so the virtualized renderer can look up by index in
 * O(1) without re-walking the interleaving rules per scroll.
 */
export type PlannedItem =
  | { kind: "plan"; key: string; row: PlanLine }
  | { kind: "banner"; key: string; transition: PayoffTransition };

/**
 * (#618) Virtualized renderer for the planned forecast items list. The
 * old implementation mounted every row at once, which made switching to
 * 1 YEAR (hundreds of DnD-enabled rows) hang the main thread for several
 * hundred milliseconds. Virtualizing keeps the rendered row count bounded
 * by the viewport regardless of horizon.
 *
 * ⚠️ (C0, parity review D7) IT VIRTUALIZES AGAINST THE SHELL'S `<main>`, NOT
 * THE WINDOW. The shell's `<main>` is the only scroller (`lib/shellScroll.ts`);
 * the window never scrolls, so the old `useWindowVirtualizer` computed its
 * range from `window.scrollY` = 0 forever and left every row below the first
 * screen blank on long horizons. `scrollMargin` is the list's offset inside
 * `<main>`'s content, re-measured whenever that content resizes.
 *
 * Drag-and-drop (`PlanDropRow` registers via `useDroppable`) keeps
 * working because:
 *  - the user only ever drops on rows visible in the viewport, and
 *  - dnd-kit auto-scrolls the nearest scrollable ancestor (`<main>`) during
 *    a drag, so newly-revealed rows mount and register as droppable
 *    just-in-time.
 */
export function PlannedItemsList({
  items,
  payoffsByItem,
  bestSuggestionPlanKey,
  highlightedPlanKey,
  activeDragId,
  onSelectPlan,
  onMoveStart,
  onMarkMissed,
  onAnswerSuggestion,
  answerDisabled,
  hookPayoffs,
}: {
  items: PlannedItem[];
  payoffsByItem: Map<string, PayoffInfo>;
  bestSuggestionPlanKey: string | null;
  highlightedPlanKey: string | null;
  activeDragId: string | null;
  onSelectPlan: (row: PlanLine) => void;
  onMoveStart: (row: PlanLine) => void;
  onMarkMissed: (row: PlanLine) => void;
  /** (PR5) Confirm / Not this / Partial on a "Suggested" row. */
  onAnswerSuggestion?: (row: PlanLine, answer: SuggestionAnswer) => void;
  answerDisabled?: boolean;
  /**
   * (WP8) An everyday hook's occurrences by plan key (`lib/forecastHooks.ts`):
   * the card payoff the curve takes in place of the stored plan, or the bank
   * row that paid it. Display only.
   */
  hookPayoffs?: Map<string, HookPayoffLine>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // undefined until mounted; null when there is no shell scroller (outside
  // the shell — then the list renders in full rather than blank).
  const [scroller, setScroller] = useState<HTMLElement | null | undefined>(undefined);
  // (#618) Only virtualize when the list is actually long enough that
  // mounting every row hurts. Short horizons (default 90D usually has
  // a few dozen plan rows) render the whole list in normal flow so
  // every plan-row testid stays in the DOM — this matches the
  // pre-virtualization behavior expected by the e2e suite and also
  // avoids any virtualization overhead when it would be wasted work.
  const VIRTUALIZE_THRESHOLD = 120;
  const longList = items.length > VIRTUALIZE_THRESHOLD;
  // A layout effect, so the scroller is known before the first paint. Re-run
  // when the list switches between the full and the virtual branch: each
  // branch mounts its own box, and the offset must be read off the live one.
  useLayoutEffect(() => {
    const main = shellScrollerOf(parentRef.current);
    setScroller(main);
    if (!main) return;
    const measure = () => {
      const el = parentRef.current;
      if (el) setScrollMargin(offsetWithinScroller(el, main));
    };
    measure();
    // Anything above the list that grows or shrinks (the inbox, a banner)
    // resizes the scroller's content, so watching that box catches it.
    const ro = new ResizeObserver(measure);
    ro.observe(main.firstElementChild ?? main);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [longList]);

  const shouldVirtualize = longList && scroller !== null;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller ?? null,
    // Plan rows render ~73px; banner rows render a bit taller. The exact
    // height is measured via `measureElement` once mounted, so this
    // estimate only governs the initial scrollbar size.
    estimateSize: (i) => (items[i].kind === "banner" ? 80 : 73),
    overscan: 6,
    scrollMargin,
    getItemKey: (i) => items[i].key,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // (#618) Locate the highlighted row's index so `jumpToPlan`'s
  // `document.querySelector('[data-plan-key=...]')` finds it even when
  // it would otherwise be virtualized away. We position it absolutely
  // at its computed offset (rather than splicing it into the visible
  // range), which keeps the rest of the layout's geometry correct.
  let highlightedIndex = -1;
  if (highlightedPlanKey) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "plan") {
        const key = `${it.row.itemId}|${it.row.date}`;
        if (key === highlightedPlanKey) {
          highlightedIndex = i;
          break;
        }
      }
    }
  }
  const visibleIndexSet = new Set(virtualItems.map((vi) => vi.index));
  const renderTargets: { index: number; start: number; size: number }[] =
    virtualItems.map((vi) => ({
      index: vi.index,
      start: vi.start - scrollMargin,
      size: vi.size,
    }));
  if (highlightedIndex >= 0 && !visibleIndexSet.has(highlightedIndex)) {
    const offsetResult = virtualizer.getOffsetForIndex?.(
      highlightedIndex,
      "start",
    );
    const rawStart: number = Array.isArray(offsetResult)
      ? (offsetResult[0] as number)
      : typeof offsetResult === "number"
        ? offsetResult
        : 0;
    const size =
      items[highlightedIndex].kind === "banner" ? 80 : 73;
    renderTargets.push({
      index: highlightedIndex,
      start: rawStart - scrollMargin,
      size,
    });
  }

  const renderItem = (target: { index: number; start: number; size: number }) => {
    const { index, start, size } = target;
    const it = items[index];
    const commonStyle: CSSProperties = {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      transform: `translateY(${start}px)`,
    };
    if (it.kind === "banner") {
      return (
        <div
          key={it.key}
          data-index={index}
          ref={virtualizer.measureElement}
          style={commonStyle}
        >
          <CashFreedBanner transition={it.transition} />
        </div>
      );
    }
    const row = it.row;
    const planKey = `${row.itemId}|${row.date}`;
    return (
      <div
        key={it.key}
        data-index={index}
        ref={virtualizer.measureElement}
        style={{ ...commonStyle, minHeight: size }}
        className="border-b border-border last:border-b-0"
      >
        <PlanDropRow
          row={row}
          onSelect={onSelectPlan}
          onMove={onMoveStart}
          onMarkMissed={onMarkMissed}
          onAnswer={onAnswerSuggestion}
          answerDisabled={answerDisabled}
          activeDragId={activeDragId}
          payoff={payoffsByItem.get(row.itemId)}
          hook={hookPayoffs?.get(planKey)}
          isBestSuggestion={bestSuggestionPlanKey === planKey}
          isHighlighted={highlightedPlanKey === planKey}
        />
      </div>
    );
  };

  // Non-virtualized fallback for short lists: render every row in
  // normal flow so e2e selectors that wait on plan-row testids near
  // the bottom of the register continue to find them without needing
  // to scroll. The expensive recompute paths upstream are already
  // memoized, so the cost here is just JSX for ~tens of rows.
  if (!shouldVirtualize) {
    return (
      <div ref={parentRef} className="divide-y divide-border">
        {items.map((it) => {
          if (it.kind === "banner") {
            return (
              <CashFreedBanner key={it.key} transition={it.transition} />
            );
          }
          const row = it.row;
          const planKey = `${row.itemId}|${row.date}`;
          return (
            <PlanDropRow
              key={it.key}
              row={row}
              onSelect={onSelectPlan}
              onMove={onMoveStart}
              onMarkMissed={onMarkMissed}
              onAnswer={onAnswerSuggestion}
              answerDisabled={answerDisabled}
              activeDragId={activeDragId}
              payoff={payoffsByItem.get(row.itemId)}
              hook={hookPayoffs?.get(planKey)}
              isBestSuggestion={bestSuggestionPlanKey === planKey}
              isHighlighted={highlightedPlanKey === planKey}
            />
          );
        })}
      </div>
    );
  }

  // `getTotalSize()` already excludes `scrollMargin` (virtual-core 3.x), so
  // it IS the list's height; subtracting the margin again cut the box short
  // and let the rows run over whatever follows the list.
  return (
    <div ref={parentRef} data-testid="planned-items-virtual">
      <div
        style={{
          position: "relative",
          height: totalSize,
          width: "100%",
        }}
      >
        {renderTargets.map(renderItem)}
      </div>
    </div>
  );
}

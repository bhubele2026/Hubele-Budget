import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export function formatDayHeader(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * A day of the ledger: a sticky header bar and the card of rows under it.
 *
 * ⚠️ THE HEAD IS DELIBERATELY OUTSIDE THE CARD. `position: sticky` cannot
 * escape an `overflow-hidden` ancestor, and the row card needs that clip to
 * keep its corners — so the head is its own bar rather than `cardHead`.
 *
 * ⚠️ AND THE ROW CARD DELIBERATELY OMITS `card-bleed`. The bleed paints a
 * hover stain across the top ~78px of a card, which on a head-less card of
 * twenty rows would tint the first two ledger rows on any hover. It is a
 * head treatment; a card with no head does not get it.
 *
 * `variant="flush"` (C9) is the same group drawn as a section of a ledger
 * PANEL (`LedgerPanel`): the head is a full-width bar with hairlines, the rows
 * sit directly under it with no card of their own — a table, not a stack of
 * cards inside a card. The head sticks under `--page-sticky-top` either way.
 *
 * ⚠️ THE ROW BOX IS THE LEDGER'S `@container`. Rows and `LedgerColumns` switch
 * to their column grid on the ledger's width (`ledger-grid.ts`), so whatever
 * hosts a day group needs no container of its own. The head stays OUTSIDE the
 * container box, so it keeps sticking to `<main>`.
 */
export function DayGroup({
  dayKey,
  count,
  isToday,
  totalNode,
  selectionState,
  onToggleAll,
  todayAccent = "blue",
  headerLabel,
  todayBadgeLabel = "Today",
  containerRef,
  columnHeader,
  variant = "card",
  children,
}: {
  dayKey: string;
  count: number;
  isToday: boolean;
  totalNode: ReactNode;
  selectionState: boolean | "indeterminate";
  onToggleAll: (on: boolean) => void;
  /**
   * Which state the accented header means. Under the navy/orange palette
   * these no longer name colours — `emerald`/`blue` are both the resting
   * navy and `amber` is the neutral grey "still settling" tone. The prop
   * keeps its old value names so no call site has to change; the CHIP TEXT
   * is what tells the user the state.
   */
  todayAccent?: "blue" | "emerald" | "amber";
  headerLabel?: string;
  todayBadgeLabel?: string;
  containerRef?: (el: HTMLDivElement | null) => void;
  /** Column-head strip, passed only by the first group so the ledger is
   *  labelled once rather than once per day. */
  columnHeader?: ReactNode;
  /** `card` (a rounded card per day) or `flush` (a section of a ledger panel). */
  variant?: "card" | "flush";
  children: ReactNode;
}) {
  // Pending is "watch", not "bad" — grey. Everything else is the resting navy.
  const accentRing =
    todayAccent === "amber"
      ? "ring-neutral-300 bg-warn-bg"
      : "ring-brand-navy/25 bg-ok-bg";
  const accentChip = todayAccent === "amber" ? "chip warn" : "chip info";
  const head = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <Checkbox
          checked={selectionState}
          onCheckedChange={(v) => onToggleAll(!!v)}
          aria-label="Select day"
        />
        <div className="truncate text-body font-semibold text-brand-navy">
          {headerLabel ?? formatDayHeader(dayKey)}
        </div>
        {isToday && <span className={accentChip}>{todayBadgeLabel}</span>}
        <span className="chip gray">
          {count} txn{count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="font-mono text-label font-semibold tabular-nums">
        {totalNode}
      </div>
    </>
  );
  if (variant === "flush") {
    // Pending is "watch" (the warn tint); today is the resting navy tint.
    const flushTint =
      todayAccent === "amber" ? "bg-warn-bg" : "bg-ok-bg";
    return (
      <div
        ref={containerRef}
        data-day-group={dayKey}
        data-variant="flush"
        // "Scroll to today" lands the group's head BELOW the pinned pane, not
        // under it.
        style={{ scrollMarginTop: "var(--page-sticky-top, 0px)" }}
      >
        <div
          className={cn(
            "sticky z-10 flex min-h-9 items-center justify-between gap-3 border-y border-brand-line px-4 py-1",
            isToday ? flushTint : "bg-platinum-1",
          )}
          style={{ top: "var(--page-sticky-top, 0px)" }}
          data-testid={`day-head-${dayKey}`}
        >
          {head}
        </div>
        <div className="@container">
          {columnHeader}
          {children}
        </div>
      </div>
    );
  }
  return (
    <div ref={containerRef} className="space-y-2">
      <div
        className={cn(
          "surface sticky z-10 flex items-center justify-between gap-3 rounded-control px-3 py-2 ring-1 ring-brand-line",
          isToday && accentRing,
        )}
        style={{ top: "var(--page-sticky-top, 0px)" }}
      >
        {head}
      </div>
      <div className="@container surface overflow-hidden rounded-card ring-1 ring-brand-line">
        {columnHeader}
        {children}
      </div>
    </div>
  );
}

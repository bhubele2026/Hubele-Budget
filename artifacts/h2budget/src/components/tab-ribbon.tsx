import { useEffect, useRef, useState, type ReactNode } from "react";
import { warmHandlers } from "@/lib/warmRoutes";
import { Link, useLocation } from "wouter";
import { scrollBehavior } from "@/lib/reducedMotion";
import { useUnderlineTravel } from "@/lib/motion";

/**
 * The app's one navigation ribbon — flush labels, a 2 px navy underline under
 * the lit tab, chevrons at the edges only when the strip actually overflows —
 * on the white top bar (2026-11-12) and, as `section`, on the row under it.
 *
 * Ported from KFI-Housing `src/web/components/board-frame.tsx`, with one
 * deliberate difference: Housing's tabs are URL SEGMENTS of one board, ours are
 * whole ROUTES. So a tab is a `<Link>` and the active tab is decided by the
 * caller (the layout owns the boundary-aware longest-match, because the same
 * rule also picks which area's sub-nav is showing).
 *
 * ⚠️ LABELS ONLY — the icons are gone. Every nav item used to carry a 16px
 * lucide glyph that repeated what the word beside it already said, on a row
 * where the words are one syllable each. Two encodings of the same thing is
 * clutter, and it cost the ribbon the horizontal room it needs on a laptop.
 */
export interface RibbonTab {
  href: string;
  label: string;
  /**
   * ⚠️ A COUNT IS A FINDING OR IT IS NOTHING. `null` and `0` both render
   * nothing — an empty queue is not news, and a "0" badge reads as a thing to
   * go and look at.
   */
  count?: number | null;
}

/**
 * The lit tab's mark: a crisp 2 px NAVY underline under navy text (owner,
 * 2026-11-12 — no orange, no glow). One element for the ribbon AND the More
 * trigger, so the two can never draw "you are here" differently.
 * `bg-chrome-ink` is navy on the white bar and light ink in dark.
 * ⭐ (Every click glides) It TRAVELS from the tab you left to the one you picked
 * (`useUnderlineTravel`); in a page cross-fade the browser carries it, by its
 * `data-vt-line` name (index.css).
 */
export function TabUnderline({ line = "top" }: { line?: "top" | "section" }) {
  return (
    <span
      aria-hidden
      data-vt-line={line}
      className="tab-underline pointer-events-none absolute inset-x-3 bottom-0 h-[2px] origin-left bg-chrome-ink"
    />
  );
}

export function TabRibbon({
  tabs,
  activeHref,
  onPrefetch,
  trailing,
  ariaLabel = "Sections",
  variant = "chrome",
  testIdPrefix = "topnav",
}: {
  tabs: RibbonTab[];
  /** Decided by the caller — see the boundary-aware match in `layout.tsx`. */
  activeHref: string | null;
  /** Hover/focus warm — the route's chunk AND its primary query. */
  onPrefetch?: (href: string) => void;
  /**
   * Pinned flush-right of the strip and OUTSIDE the scroller, so an overflow
   * menu can never be the thing that scrolled out of reach.
   */
  trailing?: ReactNode;
  ariaLabel?: string;
  /**
   * `chrome` = the global bar. `section` = the row under it: same
   * geometry and underline, drawn on the page surface (never replaces the bar).
   */
  variant?: "chrome" | "section";
  testIdPrefix?: string;
}) {
  const light = variant === "section";
  const [, navigate] = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState<{ l: boolean; r: boolean }>({ l: false, r: false });
  useUnderlineTravel(navRef, activeHref);

  const measure = () => {
    const n = navRef.current;
    if (!n) return;
    setEdges({ l: n.scrollLeft > 4, r: n.scrollLeft + n.clientWidth < n.scrollWidth - 4 });
  };

  useEffect(() => {
    measure();
    // ⚠️ Watch the ELEMENT, not just the window. The controls to the right of
    // the ribbon appear when their queries land (the review badge, the account
    // button), and the strip shrinks underneath — a resize listener alone
    // measures a nav that was still full width and concludes "everything fits".
    const ro = new ResizeObserver(measure);
    if (navRef.current) ro.observe(navRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length]);

  // Switching area swaps the whole tab set; bring the live one into view.
  useEffect(() => {
    const el = navRef.current?.querySelector(
      `[data-tabhref="${activeHref}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: scrollBehavior() });
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHref]);

  const scrollBy = (dir: number) => {
    const n = navRef.current;
    if (n) n.scrollBy({ left: dir * n.clientWidth * 0.66, behavior: scrollBehavior() });
  };

  /**
   * ⚠️ Arrow keys move between tabs ONLY from the ribbon itself. Bound to the
   * window they would hijack every table, text input and select in the app —
   * and this app is made of them.
   */
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    const i = tabs.findIndex((t) => t.href === activeHref);
    if (i < 0) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length]!;
    navigate(next.href);
  };

  return (
    /* ⚠️ THE STRIP IS SIZED BY ITS TABS, NOT BY THE ROOM AVAILABLE. Given
       `flex-1` the scroller eats the whole rail and pins `trailing` against
       the account controls at the far right — where "More" stops reading as
       the last tab and starts reading as an unrelated right-hand button.
       `min-w-0` with no grow keeps it content-width but still shrinkable, so
       the chevrons appear exactly when the tabs genuinely stop fitting. */
    <div className="flex min-w-0 items-stretch">
      <div className="relative min-w-0">
        <nav
          ref={navRef}
          onScroll={measure}
          onKeyDown={onKey}
          aria-label={ariaLabel}
          className={`scrollbar-none flex items-stretch gap-0.5 overflow-x-auto scroll-smooth ${light ? "h-10" : "h-12"}`}
        >
          {tabs.map((t) => {
            const on = t.href === activeHref;
            return (
              <Link
                key={t.href}
                href={t.href}
                data-tabhref={t.href}
                data-testid={`${testIdPrefix}-${t.href.slice(1)}`}
                aria-current={on ? "page" : undefined}
                {...(onPrefetch ? warmHandlers(onPrefetch, t.href) : {})}
                className={`press relative flex flex-none items-center whitespace-nowrap px-3 text-label ${
                  light
                    ? on
                      ? "font-semibold text-brand-navy"
                      : "font-medium text-neutral-600 hover:text-foreground"
                    : on
                      ? "font-semibold text-chrome-ink"
                      : "font-medium text-chrome-ink-3 hover:text-chrome-ink-hover"
                }`}
              >
                {t.label}
                {t.count != null && t.count > 0 && (
                  /* ⚠️ NOT ORANGE (2026-11-12). Items waiting to be reviewed
                     are a queue, not a fault: a small navy count, squared
                     like every badge. Orange is kept for warnings. */
                  <span className="fig ml-1.5 rounded-[4px] bg-count-bg px-1.5 py-0.5 text-micro font-medium leading-none text-count-ink">
                    {t.count}
                  </span>
                )}
                {on && <TabUnderline line={light ? "section" : "top"} />}
              </Link>
            );
          })}
        </nav>

        {/* The strip says so at its edges — and ONLY when there is more to
            reach. A chevron that is always there is a decoration; one that
            appears is information. */}
        {(["l", "r"] as const).map(
          (side) =>
            edges[side] && (
              <button
                key={side}
                type="button"
                onClick={() => scrollBy(side === "l" ? -1 : 1)}
                aria-label={`Scroll sections ${side === "l" ? "left" : "right"}`}
                data-testid={`${testIdPrefix}-scroll-${side === "l" ? "left" : "right"}`}
                className={`absolute inset-y-0 grid w-7 place-items-center ${side === "l" ? "bg-gradient-to-r left-0" : "bg-gradient-to-l right-0"} text-body ${
                  light
                    ? "from-card via-card/90 to-transparent text-muted-foreground hover:text-brand-navy"
                    : "from-chrome via-chrome/90 to-transparent text-chrome-ink-4 hover:text-chrome-ink"
                }`}
              >
                {side === "l" ? "‹" : "›"}
              </button>
            ),
        )}
      </div>

      {trailing && <div className="flex flex-none items-stretch">{trailing}</div>}
    </div>
  );
}

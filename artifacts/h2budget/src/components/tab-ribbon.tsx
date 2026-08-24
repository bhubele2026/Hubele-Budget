import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";

/**
 * The app's one navigation ribbon — the dashboard's tab geometry (flush
 * labels, an orange underline that sweeps in from the left, chevrons at the
 * edges only when the strip actually overflows), rendered on the navy chrome
 * rather than on a light page.
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

export function TabRibbon({
  tabs,
  activeHref,
  onPrefetch,
  trailing,
  ariaLabel = "Sections",
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
}) {
  const [, navigate] = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState<{ l: boolean; r: boolean }>({ l: false, r: false });

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
    el?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHref]);

  const scrollBy = (dir: number) => {
    const n = navRef.current;
    if (n) n.scrollBy({ left: dir * n.clientWidth * 0.66, behavior: "smooth" });
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
          className="scrollbar-none flex h-12 items-stretch gap-0.5 overflow-x-auto scroll-smooth"
        >
          {tabs.map((t) => {
            const on = t.href === activeHref;
            return (
              <Link
                key={t.href}
                href={t.href}
                data-tabhref={t.href}
                data-testid={`topnav-${t.href.slice(1)}`}
                aria-current={on ? "page" : undefined}
                onMouseEnter={() => onPrefetch?.(t.href)}
                onFocus={() => onPrefetch?.(t.href)}
                className={`press relative flex flex-none items-center whitespace-nowrap px-3.5 text-label font-semibold ${
                  on ? "text-white" : "text-white/60 hover:text-white/90"
                }`}
              >
                {t.label}
                {t.count != null && t.count > 0 && (
                  /* ⚠️ BRAND ORANGE, NOT THE DEEP ORANGE. Items waiting to be
                     reviewed are a queue, not a fault — spending the palette's
                     one alarm colour on a to-do is what makes a real alarm
                     unreadable. */
                  <span className="ml-1.5 rounded-full bg-brand-orange/20 px-1.5 py-0.5 font-mono text-micro leading-none tabular-nums text-brand-orange">
                    {t.count}
                  </span>
                )}
                {on && (
                  <span
                    aria-hidden
                    className="tab-underline pointer-events-none absolute inset-x-2.5 bottom-0 h-[3px] rounded-t-full bg-brand-orange shadow-[0_0_10px_rgba(246,141,46,0.55)]"
                  />
                )}
              </Link>
            );
          })}
        </nav>

        {/* The strip says so at its edges — and ONLY when there is more to
            reach. A chevron that is always there is a decoration; one that
            appears is information. */}
        {edges.l && (
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            aria-label="Scroll sections left"
            data-testid="ribbon-scroll-left"
            className="absolute inset-y-0 left-0 grid w-7 place-items-center bg-gradient-to-r from-brand-navy via-brand-navy/90 to-transparent text-body text-white/50 hover:text-white"
          >
            ‹
          </button>
        )}
        {edges.r && (
          <button
            type="button"
            onClick={() => scrollBy(1)}
            aria-label="Scroll sections right"
            data-testid="ribbon-scroll-right"
            className="absolute inset-y-0 right-0 grid w-7 place-items-center bg-gradient-to-l from-brand-navy via-brand-navy/90 to-transparent text-body text-white/50 hover:text-white"
          >
            ›
          </button>
        )}
      </div>

      {trailing && <div className="flex flex-none items-stretch">{trailing}</div>}
    </div>
  );
}

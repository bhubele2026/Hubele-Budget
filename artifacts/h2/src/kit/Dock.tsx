import { useRef, useState, type KeyboardEvent } from "react";
import { Link } from "wouter";
import { cx } from "@/lib/cx";
import { DESTINATIONS, isActive, type Destination } from "./destinations";

/**
 * ⭐ THE DOCK — the four destinations along the bottom of a phone.
 *
 * Roving tabindex: the dock is ONE tab stop; the arrow keys (and Home/End)
 * move between its items. Every item has an icon AND a label. Destinations not
 * yet shipped stay focusable (so they can be discovered) but are
 * `aria-disabled` and say "soon".
 */
export function Dock({ location, badges }: { location: string; badges?: Partial<Record<Destination["key"], number>> }) {
  const activeIndex = Math.max(
    0,
    DESTINATIONS.findIndex((d) => d.live && isActive(location, d.href)),
  );
  const [focusIndex, setFocusIndex] = useState(activeIndex);
  const items = useRef<Array<HTMLElement | null>>([]);

  const moveTo = (i: number) => {
    const n = (i + DESTINATIONS.length) % DESTINATIONS.length;
    setFocusIndex(n);
    items.current[n]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => moveTo(focusIndex + 1),
      ArrowDown: () => moveTo(focusIndex + 1),
      ArrowLeft: () => moveTo(focusIndex - 1),
      ArrowUp: () => moveTo(focusIndex - 1),
      Home: () => moveTo(0),
      End: () => moveTo(DESTINATIONS.length - 1),
    };
    const go = keys[e.key];
    if (go) {
      e.preventDefault();
      go();
    }
  };

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper-0 pb-[env(safe-area-inset-bottom)] md:hidden"
      data-testid="dock"
    >
      <ul className="grid grid-cols-4" onKeyDown={onKeyDown}>
        {DESTINATIONS.map((d, i) => {
          const Icon = d.icon;
          const active = d.live && isActive(location, d.href);
          const badge = badges?.[d.key] ?? 0;
          const shared = {
            tabIndex: i === focusIndex ? 0 : -1,
            onFocus: () => setFocusIndex(i),
            "data-testid": `dock-${d.key}`,
            ...(badge > 0 ? { "aria-label": `${d.label}, ${badge} to review` } : {}),
          };
          // Every item stacks from the top (icon, label, then "soon" where it
          // applies) and sizes to its content, so icons and labels line up
          // across the row whether or not an item has the third line.
          const face = (
            <>
              <Icon size={20} strokeWidth={1.75} aria-hidden className="shrink-0" />
              <span className="type-caption">{d.label}</span>
              {badge > 0 && (
                <span className="absolute top-1 left-1/2 ml-2 min-w-4 rounded-full bg-clay px-1 text-center type-caption tnum text-paper-0" data-testid={`dock-badge-${d.key}`}>
                  {badge}
                </span>
              )}
              {!d.live && <span className="type-caption text-ink-3">soon</span>}
            </>
          );
          return (
            <li key={d.key} className="relative">
              {active && <span aria-hidden className="absolute inset-x-6 top-0 h-0.5 bg-moss" />}
              {d.live ? (
                <Link
                  href={d.href}
                  ref={(el: HTMLAnchorElement | null) => {
                    items.current[i] = el;
                  }}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex h-full flex-col items-center justify-start gap-1 pt-2 pb-2",
                    active ? "text-moss-ink" : "text-ink-2",
                  )}
                  {...shared}
                >
                  {face}
                </Link>
              ) : (
                <span
                  role="link"
                  aria-disabled="true"
                  ref={(el) => {
                    items.current[i] = el;
                  }}
                  className="flex h-full flex-col items-center justify-start gap-1 pt-2 pb-2 text-ink-3"
                  {...shared}
                >
                  {face}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

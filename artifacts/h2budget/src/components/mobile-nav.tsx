import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { HomeMark } from "@/components/home-mark";
import { AccountMenu, VERSION_LABEL } from "@/components/account-menu";
import { BAR_SECTIONS, MORE_ITEMS, moreItemOf, tabsOf, type NavItem, type Section, type SectionTab } from "@/lib/navModel";
import { SETTINGS_PAGES, openSettingsSub } from "@/lib/navSettings";

/**
 * The phone drawer's content — its own chunk (the drawer opens on a tap, and
 * the landing's entry graph has no room for it). `layout.tsx` loads it with
 * `lazy()` and warms it on idle and on the trigger's hover/focus/press.
 */

function DrawerLink({
  item,
  nested = false,
  active,
  inArea = false,
  badge,
  onNavigate,
  onPrefetch,
}: {
  item: NavItem;
  /** A page beneath a section, not a section row. */
  nested?: boolean;
  active: boolean;
  /** The section you are inside while one of its pages is the lit row. */
  inArea?: boolean;
  badge: number | null;
  onNavigate: () => void;
  onPrefetch: (href: string) => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      onMouseEnter={() => onPrefetch(item.href)}
      onFocus={() => onPrefetch(item.href)}
      aria-current={active ? "page" : undefined}
      data-testid={`mobilenav-${item.testId ?? item.href.slice(1)}`}
      className={cn(
        "press relative flex items-center gap-3 rounded-control",
        nested ? "py-1.5 pl-7 pr-3 text-label" : "px-3 py-2 text-body",
        active
          ? "bg-chrome-press font-semibold text-chrome-ink"
          : inArea
            ? "font-semibold text-chrome-ink hover:bg-chrome-hover"
            : "text-chrome-ink-3 hover:bg-chrome-hover hover:text-chrome-ink",
      )}
    >
      {/* The vertical analogue of the ribbon's underline — same accent, same
          meaning: this is where you are. */}
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-brand-orange"
        />
      )}
      <span className="flex-1">{item.name}</span>
      {badge !== null && (
        <span className="rounded-full bg-brand-orange/20 px-1.5 py-0.5 font-mono text-micro leading-none tabular-nums text-brand-orange">
          {badge}
        </span>
      )}
    </Link>
  );
}

export default function MobileNav({
  location,
  search,
  section,
  litHref,
  amexCards,
  onNavigate,
  railBadge,
  onPrefetch,
}: {
  location: string;
  /** The query string: on `/settings` it says which Settings sub-page is open. */
  search: string;
  section: Section | null;
  /** The href of the lit section tab (null: none, or the page is in More). */
  litHref: string | null;
  amexCards: readonly SectionTab[];
  onNavigate: () => void;
  railBadge: (href: string) => number | null;
  onPrefetch: (href: string) => void;
}) {
  const settingsSub = openSettingsSub(location, search);
  const moreHere = section?.id === "more" ? moreItemOf(location) : null;
  const row = { onNavigate, onPrefetch };
  // (C12) Open with the lit row in view: the drawer is taller than a phone
  // now (Settings' sub-pages sit at the bottom), and a lit row you have to
  // scroll to find says nothing.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, []);
  const groupLabel =
    "px-2 pb-1.5 text-micro font-semibold uppercase tracking-wide text-chrome-ink-4";
  return (
    <div className="flex h-full flex-col bg-brand-navy text-chrome-ink">
      <div className="flex h-14 items-center border-b border-chrome-rule px-3">
        <HomeMark onNavigate={onNavigate} />
      </div>
      <nav ref={navRef} aria-label="Sections" className="flex-1 space-y-5 overflow-y-auto p-3">
        {/* The same six, in the same order as the desktop bar, each with its
            section tabs beneath it — every page a tab row reaches is here. */}
        <div>
          <ul className="space-y-1">
            {BAR_SECTIONS.map((s) => {
              const here = section?.id === s.id;
              const pages = tabsOf(s, amexCards).filter((t) => t.href !== s.href);
              return (
                <li key={s.id} data-testid={`mobilenav-area-${s.id}`}>
                  <DrawerLink
                    item={s}
                    active={here && (litHref === null || litHref === s.href)}
                    inArea={here}
                    badge={railBadge(s.href)}
                    {...row}
                  />
                  {pages.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {pages.map((p) => (
                        <li key={p.href}>
                          <DrawerLink
                            item={p}
                            nested
                            active={here && litHref === p.href}
                            badge={railBadge(p.href)}
                            {...row}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <div className={groupLabel}>More</div>
          <ul className="space-y-0.5">
            {MORE_ITEMS.map((m) => (
              <li key={m.href}>
                <DrawerLink
                  item={m}
                  active={moreHere?.href === m.href && settingsSub == null}
                  inArea={m.href === "/settings" && settingsSub != null}
                  badge={railBadge(m.href)}
                  {...row}
                />
                {/* (C12) Settings' sub-pages beneath it, as a section's pages
                    sit beneath it above. */}
                {m.href === "/settings" && (
                  <ul className="mt-0.5 space-y-0.5" data-testid="mobilenav-settings-pages">
                    {SETTINGS_PAGES.map((p) => (
                      <li key={p.href}>
                        <DrawerLink
                          item={p}
                          nested
                          active={settingsSub === p.tab}
                          badge={null}
                          onNavigate={onNavigate}
                          // A sub-page warms the Settings chunk; its own lazy
                          // tab chunk warms from the page's tab bar (warming it
                          // here would put the tab importers on the landing).
                          onPrefetch={() => onPrefetch("/settings")}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="flex items-center justify-between gap-3 border-t border-chrome-rule p-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-label font-medium text-chrome-ink-2">Account</span>
          {/* (C12) LND-09: the build, also the last item of the account menu. */}
          <span data-testid="drawer-version" className="truncate font-mono text-micro tabular-nums text-chrome-ink-4">
            {VERSION_LABEL}
          </span>
        </div>
        <AccountMenu />
      </div>
    </div>
  );
}


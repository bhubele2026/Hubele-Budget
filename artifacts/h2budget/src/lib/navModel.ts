/**
 * ⭐ THE NAV MODEL — one table, three surfaces (the global bar, the section tabs
 * under it, the breadcrumb). Pure: `layout.tsx` draws it, the tests walk it.
 *
 * - The GLOBAL BAR is the same on every route: Dashboard · Banking · Amex ·
 *   Spending · Forecast · Debt · More. Exactly one is lit: the section the
 *   route belongs to.
 * - The SECTION TABS sit underneath and never replace the bar. Each route has
 *   ONE owner (`owns`), the longest matching path wins, so /reports/debt is
 *   Debt's and /reports/spending is Spending's.
 * - The word "Home" is not a label anywhere. The logo and Dashboard both go to
 *   /home.
 */
export interface NavItem {
  name: string;
  href: string;
  /** Test-id suffix when the href cannot be one (a query string). */
  testId?: string;
}

/** A route a tab/section owns: the path itself AND its child routes. The LONGEST owned path wins. */
export interface OwnedRoute {
  path: string;
}

export interface SectionTab extends NavItem {
  /** Routes that light this tab. Default: its own path. */
  owns?: OwnedRoute[];
}

export type SectionId = "dashboard" | "banking" | "amex" | "spending" | "forecast" | "debt" | "more";

export interface Section extends NavItem {
  id: SectionId;
  tabs: SectionTab[];
  /** Routes the section owns beyond its tabs' own (a section with no tabs lists all of them). */
  owns?: OwnedRoute[];
}

/** What the More menu lists, in order. */
export const MORE_ITEMS: NavItem[] = [
  { name: "Categories", href: "/review/categories" },
  { name: "Suggestions", href: "/review/suggestions" },
  { name: "Ask", href: "/ask" },
  { name: "Mapping rules", href: "/mapping-rules" },
  { name: "Settings", href: "/settings" },
];

export const SECTIONS: Section[] = [
  { id: "dashboard", name: "Dashboard", href: "/home", tabs: [], owns: [{ path: "/home" }] },
  {
    id: "banking",
    name: "Banking",
    href: "/banking",
    tabs: [
      { name: "Review", href: "/banking" },
      { name: "Chase register", href: "/transactions" },
      { name: "Accounts", href: "/next/accounts" },
    ],
  },
  {
    id: "amex",
    name: "Amex",
    href: "/amex",
    // One tab per card is added at run time (`amexCardTabs`).
    tabs: [{ name: "All cards", href: "/amex" }],
  },
  {
    id: "spending",
    name: "Spending",
    href: "/spending/week",
    tabs: [
      { name: "This week", href: "/spending/week" },
      { name: "Monthly allowance", href: "/spending/month" },
      { name: "Budget", href: "/budget" },
      { name: "Allowances", href: "/allowances" },
      { name: "Wish list", href: "/wishlist" },
      // Owns every /reports/* page; /reports/debt is Debt's, by the longer path.
      { name: "Reports", href: "/reports" },
    ],
  },
  {
    id: "forecast",
    name: "Forecast",
    href: "/forecast/overview",
    tabs: [
      { name: "Overview", href: "/forecast/overview" },
      { name: "Forecast", href: "/forecast", owns: [{ path: "/forecast" }, { path: "/next/forecast" }] },
      // /review/categories and /review/suggestions are More's, by the longer path.
      { name: "To review", href: "/review" },
      { name: "Bills", href: "/bills" },
    ],
  },
  {
    id: "debt",
    name: "Debt",
    href: "/avalanche",
    tabs: [
      { name: "Payoff plan", href: "/avalanche" },
      { name: "Debts", href: "/debts" },
      { name: "Debt report", href: "/reports/debt" },
    ],
  },
  {
    id: "more",
    name: "More",
    href: "/settings",
    tabs: [],
    owns: MORE_ITEMS.map((m) => ({ path: m.href })),
  },
];

/** The six sections that sit in the bar itself (More is a menu, drawn apart). */
export const BAR_SECTIONS: Section[] = SECTIONS.filter((s) => s.id !== "more");

export const pathOf = (href: string): string => href.split("?")[0]!;

/** Whole path segments only: `/bills` covers `/bills/all`, never `/billsx`. */
export function isAtOrUnder(location: string, path: string): boolean {
  return location === path || location.startsWith(path + "/");
}

/** Every route a section owns: its tabs' own routes, else the `owns` it lists. */
function ownedBy(s: Section): OwnedRoute[] {
  return s.owns ?? s.tabs.flatMap((t) => t.owns ?? [{ path: pathOf(t.href) }]);
}

/** Length of the best match of `location` among `routes`, or -1. */
function matchLength(location: string, routes: readonly OwnedRoute[]): number {
  let best = -1;
  for (const r of routes) {
    if (isAtOrUnder(location, r.path) && r.path.length > best) best = r.path.length;
  }
  return best;
}

/** The section a route belongs to (longest owned path wins), or null (not found, Plaid return). */
export function sectionFor(location: string): Section | null {
  let best: Section | null = null;
  let bestLen = -1;
  for (const s of SECTIONS) {
    const len = matchLength(location, ownedBy(s));
    if (len > bestLen) {
      best = s;
      bestLen = len;
    }
  }
  return best;
}

/** The Amex card a URL names: `?card=` first, the older `?accountId=` second. */
export function amexCardOf(search: string): string | null {
  const p = new URLSearchParams(search);
  return p.get("card") || p.get("accountId") || null;
}

/** A card's tab. The id is Plaid's external account id. */
export function amexCardHref(accountId: string): string {
  return `/amex?card=${encodeURIComponent(accountId)}`;
}

/**
 * The tab lit for this URL: the section tab whose owned path matches longest;
 * on /amex the card named in the address, else "All cards". `tabs` is the
 * section's full list (Amex's with its card tabs). Null when nothing matches.
 */
export function litTabOf(
  section: Section | null,
  tabs: readonly SectionTab[],
  location: string,
  search: string,
): SectionTab | null {
  if (!section) return null;
  if (section.id === "amex") {
    const card = amexCardOf(search);
    if (card) {
      const hit = tabs.find((t) => t.href === amexCardHref(card));
      if (hit) return hit;
    }
    return tabs.find((t) => t.href === "/amex") ?? null;
  }
  let best: SectionTab | null = null;
  let bestLen = -1;
  for (const t of tabs) {
    const len = matchLength(location, t.owns ?? [{ path: pathOf(t.href) }]);
    if (len > bestLen) {
      best = t;
      bestLen = len;
    }
  }
  return best;
}

/** The More menu entry open at this route (Settings sub-pages are the caller's). */
export function moreItemOf(location: string): NavItem | null {
  let best: NavItem | null = null;
  for (const m of MORE_ITEMS) {
    if (isAtOrUnder(location, m.href) && (!best || m.href.length > best.href.length)) best = m;
  }
  return best;
}

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * `Dashboard › Section › Tab` for every route but the dashboard. The last crumb
 * is the page you are on (no link).
 */
export function crumbsFor(
  location: string,
  section: Section | null,
  tab: { name: string; href: string } | null,
): Crumb[] {
  if (!section || section.id === "dashboard") return [];
  const trail: Crumb[] = [{ label: "Dashboard", href: "/home" }];
  if (section.id === "more") {
    trail.push({ label: "More" });
    const here = moreItemOf(location);
    if (here) trail.push({ label: here.name });
    return trail;
  }
  if (!tab) {
    trail.push({ label: section.name });
    return trail;
  }
  trail.push({ label: section.name, href: section.href });
  trail.push({ label: tab.name });
  return trail;
}

/**
 * The phone's single back link: `‹ Dashboard` on a section's landing page (and
 * on More's pages), else `‹ <Section>`.
 */
export function backLinkFor(
  section: Section | null,
  tab: { href: string } | null,
): Crumb | null {
  if (!section || section.id === "dashboard") return null;
  if (section.id === "more" || !tab || tab.href === section.href) {
    return { label: "Dashboard", href: "/home" };
  }
  return { label: section.name, href: section.href };
}

/** A section's tabs, Amex's with its card tabs after "All cards". */
export function tabsOf(section: Section, amexCards: readonly SectionTab[]): SectionTab[] {
  return section.id === "amex" ? [...section.tabs, ...amexCards] : section.tabs;
}

import { Link } from "wouter";
import { Bell } from "lucide-react";
import { UserButton } from "@clerk/react";
import { prefetchRoute } from "@/lib/routePrefetch";
import { useSpine } from "@/hooks/useSpine";
import { H2Wordmark } from "@/components/h2-wordmark";
import { useLandingWarmup } from "@/hooks/useLandingWarmup";
import { APP_VERSION } from "@/lib/version";

/**
 * ⭐ THE FRONT DOOR. A door, not a dashboard.
 *
 * What this replaced fired FOUR queries before it could finish drawing — a
 * six-month spending-facts window, the bills summary, the entire forecast
 * engine, and every debt row — so that four cards could each show one figure.
 * The owner's verdict on that was "I want to open it and it just opens", and a
 * screen that waits on the forecast engine to say "Banking" cannot do that.
 *
 * ⭐ EXACTLY TWO NUMBERS LIVE HERE, AND BOTH COME FROM THE SPINE:
 *   1. the Review count on the bell, and
 *   2. **% paid** on Future Goal.
 * Everything else is words. Numbers are what the AREAS are for; a door tells
 * you which room to walk into.
 *
 * ⚠️ THE FUTURE GOAL TILE SHOWS A PERCENTAGE AND NEVER AN AMOUNT OWED. That is
 * a standing rule, and it is enforced upstream too: `/api/spine` carries
 * `debt.payoffPct` and no balance at all, so there is no owed figure on this
 * page to leak even by accident.
 *
 * Both numbers come from ONE request (`useSpine`), which is also prefetched at
 * module scope in App.tsx in parallel with clerk-js — so on a warm open they
 * are usually already in cache before this component first renders.
 */

// ── tiles ───────────────────────────────────────────────────────────────────

type TileDef = {
  testid: string;
  href: string;
  title: string;
  blurb: string;
  caption: string;
};

/**
 * ⚠️ SIX TILES, THREE ACROSS, TWO DOWN — a filled rectangle. Five would leave a
 * hole in the grid, and a hole reads as something missing rather than as
 * space. The order is daily-use frequency, left to right and top to bottom.
 */
const TILES: TileDef[] = [
  {
    testid: "banking",
    href: "/banking",
    title: "Banking",
    blurb: "Accounts, ledgers, spending.",
    caption: "Open banking",
  },
  {
    testid: "bills",
    href: "/bills",
    title: "Bills",
    blurb: "What's due, what changed.",
    caption: "See what's due",
  },
  {
    testid: "forecast",
    href: "/forecast/overview",
    title: "Forecast",
    blurb: "What's coming. Lock it in.",
    caption: "See the curve",
  },
  {
    testid: "avalanche",
    href: "/avalanche",
    title: "Future Goal",
    blurb: "The payoff plan.",
    caption: "Work the plan",
  },
  {
    testid: "budget",
    href: "/budget",
    title: "Budget",
    blurb: "Envelopes by month.",
    caption: "Open budget",
  },
  {
    testid: "settings",
    href: "/settings",
    title: "Settings",
    blurb: "Sync, rules, accounts.",
    caption: "Sync & rules",
  },
];

/**
 * The quiet second tier. Everything here is reachable and nothing here shouts:
 * a seventh loud tile would say these matter as much as Banking, and they
 * don't — they're where you go on purpose, not where you land.
 */
const MORE: Array<{ href: string; label: string }> = [
  { href: "/reports", label: "Reports" },
  { href: "/allowances", label: "Allowances" },
  { href: "/transactions", label: "Chase" },
  { href: "/amex", label: "Amex" },
  { href: "/debts", label: "Debts" },
  { href: "/mapping-rules", label: "Mapping rules" },
];

/**
 * ⚠️ THE SPOTLIGHT IS A CSS VARIABLE, NOT REACT STATE. Writing `--mx`/`--my`
 * straight onto the node on pointermove keeps the highlight at the compositor's
 * refresh rate; routing it through `useState` would re-render the whole grid on
 * every mouse pixel to move one gradient.
 */
function onTilePointerMove(e: React.PointerEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

function Tile({ def, index, badge }: { def: TileDef; index: number; badge?: React.ReactNode }) {
  return (
    <Link
      href={def.href}
      data-testid={`landing-tile-${def.testid}`}
      onMouseEnter={() => prefetchRoute(def.href)}
      onFocus={() => prefetchRoute(def.href)}
      onPointerMove={onTilePointerMove}
      aria-label={def.title}
      className="group relative isolate flex min-h-[154px] flex-col overflow-hidden rounded-card p-6 text-left ring-1 ring-brand-line surface surface-lift card-bleed bleed-sm tile-in transition-[translate,box-shadow] duration-[--dur-in] hover:-translate-y-1"
      style={{
        // `min(index, 12)` so a grid that ever grows can't schedule a tile a
        // full second after the first one.
        animationDelay: `calc(${Math.min(index, 12)} * var(--stagger))`,
      }}
    >
      {/* The cursor spotlight: navy at 10%, following the pointer, fading in on
          hover only. Pointer-events off so it never eats the click. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-[--dur-soft] group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(220px circle at var(--mx, 50%) var(--my, 50%), rgba(25,49,91,0.10), rgba(25,49,91,0) 70%)",
        }}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="text-title font-semibold text-brand-navy">{def.title}</div>
        {badge}
      </div>
      <p className="mt-1 text-label text-neutral-500">{def.blurb}</p>

      {/* mt-auto pins every caption to a shared baseline — the six tiles read as
          one row of type, not six independently-placed labels. */}
      <div className="mt-auto flex items-center gap-1 pt-5 text-micro uppercase tracking-wider text-neutral-400 transition-colors duration-[--dur-soft] group-hover:text-brand-orange">
        {def.caption}
        <span
          aria-hidden
          className="inline-block translate-x-0 transition-[translate] duration-[--dur-soft] group-hover:translate-x-1"
        >
          →
        </span>
      </div>
    </Link>
  );
}

// ── skeleton (pre-hydration / pre-Clerk) ────────────────────────────────────

/**
 * ⭐ THE SHELL THAT PAINTS BEFORE CLERK ANSWERS. Same hero, same grid geometry,
 * zero numbers — so a browser whose session turns out to be stale cannot have
 * seen a single figure. Exported for `App.tsx`, which renders it while Clerk is
 * still resolving on a returning visitor.
 */
export function LandingSkeleton() {
  return (
    <div className="relative min-h-full w-full" data-testid="landing-skeleton">
      <HeroBand />
      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map((t, i) => (
            <div
              key={t.testid}
              className="min-h-[154px] rounded-card p-6 ring-1 ring-brand-line surface tile-in"
              style={{ animationDelay: `calc(${i} * var(--stagger))` }}
            >
              <div className="skeleton h-4 w-24 rounded" />
              <div className="skeleton mt-3 h-3 w-36 rounded" />
              <div className="skeleton mt-10 h-2.5 w-20 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── hero ────────────────────────────────────────────────────────────────────

/**
 * Full-bleed navy band. The wordmark IS the headline — a greeting under a
 * logotype is two headlines competing, and the sub-line says what the app is
 * for in five words.
 *
 * `children` carries the bell + account controls, which the skeleton omits (it
 * has no count to show and no Clerk to render a UserButton from).
 */
function HeroBand({ children }: { children?: React.ReactNode }) {
  return (
    <header className="w-full bg-brand-navy text-white">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-8 sm:px-6 sm:py-10">
        <div>
          <H2Wordmark tone="white" size={30} data-testid="landing-wordmark" />
          <p className="mt-2 text-label text-white/60">Every dollar, one place.</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      </div>
    </header>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const { data: spine } = useSpine();
  const reviewCount = spine?.reviewCount ?? 0;
  const payoffPct = spine?.debt?.payoffPct ?? null;

  // Warm the area pages' data on idle, using each page's exact query keys, so
  // the first click into any area lands on cached data. Never on the critical
  // path — see the hook.
  useLandingWarmup();

  return (
    <div className="relative min-h-full w-full">
      <HeroBand>
        <Link
          href="/review"
          aria-label={reviewCount > 0 ? `${reviewCount} items to review` : "Review inbox"}
          data-testid="landing-bell"
          onMouseEnter={() => prefetchRoute("/review")}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-control text-white/70 transition-colors duration-[--dur-soft] hover:bg-white/10 hover:text-white"
        >
          <Bell className="h-4 w-4" />
          {reviewCount > 0 && (
            <span
              data-testid="landing-bell-count"
              className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-orange px-1 font-mono text-[10px] font-bold leading-none tabular-nums text-brand-navy"
            >
              {reviewCount}
            </span>
          )}
        </Link>
        <UserButton />
      </HeroBand>

      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map((def, i) => (
            <Tile
              key={def.testid}
              def={def}
              index={i}
              badge={
                // ⚠️ % PAID ONLY. Never an amount owed — not here, not ever.
                def.testid === "avalanche" && payoffPct != null ? (
                  <span
                    data-testid="landing-payoff-pct"
                    className="font-mono text-label font-semibold tabular-nums text-brand-navy"
                  >
                    {Math.round(payoffPct)}% paid
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>

        {/* The quiet tier. Reachable, not loud. */}
        <nav
          aria-label="More"
          data-testid="landing-more"
          className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-brand-line pt-5"
        >
          <span className="text-micro uppercase tracking-wider text-neutral-400">More</span>
          {MORE.map((m) => (
            <Link
              key={m.href}
              href={m.href}
              data-testid={`landing-more-${m.href.replace(/\W+/g, "-").replace(/^-/, "")}`}
              onMouseEnter={() => prefetchRoute(m.href)}
              onFocus={() => prefetchRoute(m.href)}
              className="text-label text-neutral-500 transition-colors duration-[--dur-soft] hover:text-brand-navy"
            >
              {m.label}
            </Link>
          ))}
        </nav>

        <div
          data-testid="landing-version"
          className="mt-10 font-mono text-micro tabular-nums text-neutral-400"
        >
          Version {APP_VERSION}
        </div>
      </div>

      {/* Faint brand watermark. Type, so opacity alone tones it — nothing to
          desaturate and no accent colour to lose. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed bottom-4 right-4 -z-10 select-none opacity-[0.06]"
      >
        <H2Wordmark tone="navy" size={96} />
      </div>
    </div>
  );
}

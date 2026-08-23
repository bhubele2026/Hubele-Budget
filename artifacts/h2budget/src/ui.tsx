import type { ReactNode } from "react";
import { Link } from "wouter";
import { useCountUp } from "@/hooks/useCountUp";

/**
 * The kit — shared class strings and the four components the whole app builds
 * out of. Ported from KFI-Housing's `src/web/ui.tsx`, which is the lean
 * dependency-free port of the Financial Dashboard's card/button/table language.
 *
 * `press` (index.css) carries the colour/transform transition, so every button
 * in the app answers a click on the frame it happens: one edit, all of them.
 */

/**
 * ⭐ THE PLATINUM SURFACE, ON EVERYTHING — not just the landing.
 *
 * ⚠️ ONE ELEVATION LANGUAGE. A card is a hairline ring plus the inset
 * highlight; depth arrives on hover and nowhere else. Do not add a second
 * `shadow-*` on top — two competing depth cues is what reads as cheap.
 */
export const card =
  "card-bleed surface relative overflow-hidden rounded-card ring-1 ring-brand-line";
/** ⚠️ `relative z-[1]` keeps the head above `.card-bleed::before`, which paints
 *  from the top edge down; without it the hover stain sits over the title. */
export const cardHead =
  "relative z-[1] flex items-center gap-2.5 border-b border-brand-line px-4 py-2.5";

export const btn =
  "press rounded-control bg-brand-navy px-3.5 py-1.5 text-body font-medium text-white hover:bg-brand-navy2 disabled:pointer-events-none disabled:opacity-55";
export const btnSm =
  "press rounded-control bg-brand-navy px-2.5 py-1 text-micro font-semibold text-white hover:bg-brand-navy2 disabled:pointer-events-none disabled:opacity-55";
export const btnSecondary =
  "press rounded-control bg-white px-3.5 py-1.5 text-body font-medium text-neutral-700 ring-1 ring-brand-line hover:bg-neutral-50 disabled:pointer-events-none disabled:opacity-55";
export const btnSecondarySm =
  "press rounded-control bg-white px-2.5 py-1 text-micro font-semibold text-neutral-700 ring-1 ring-brand-line hover:bg-neutral-50 disabled:pointer-events-none disabled:opacity-55";
/** ⚠️ Hover is a DEEPER ORANGE, not a dark red — `bg-bad` is #e16d3e, and a
 *  crimson hover under an orange rest state reads as two different buttons. */
export const btnDanger =
  "press rounded-control bg-bad px-3.5 py-1.5 text-body font-medium text-white hover:bg-[#c2562a] disabled:pointer-events-none disabled:opacity-55";
/**
 * ⭐ NOT A LINK. Secondary actions used to render as web-page hypertext — blue,
 * underlined, `edit` / `delete` / `+ add`. They are app controls, so they read
 * as controls: a quiet ghost chip with a hairline ring, uniform height, no
 * blue, no underline. One token, so every call site moves at once.
 */
export const btnLink =
  "press inline-flex items-center gap-1 rounded-control bg-white px-2 py-1 text-micro font-semibold text-neutral-600 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy disabled:pointer-events-none disabled:opacity-55";
export const btnLinkDanger =
  "press inline-flex items-center gap-1 rounded-control bg-white px-2 py-1 text-micro font-semibold text-bad ring-1 ring-bad/20 hover:bg-bad-bg disabled:pointer-events-none disabled:opacity-55";

/** A card that lifts on hover and dips on click — landing tiles, row cards. */
export const cardButton =
  "press group relative flex h-full flex-col overflow-hidden rounded-card surface text-left hover:-translate-y-0.5 hover:shadow-lift hover:ring-brand-navy/25";

export const input =
  "w-full rounded-control bg-white px-3 py-2 text-body ring-1 ring-brand-line focus:outline-none focus:ring-2 focus:ring-brand-navy";
export const inputInline =
  "rounded-md bg-transparent px-1.5 py-0.5 font-mono text-label tabular-nums ring-1 ring-transparent transition-colors hover:ring-brand-line focus:bg-white focus:ring-brand-navy focus:outline-none";
export const fieldLabel =
  "text-micro font-semibold uppercase tracking-wide text-neutral-500";

export const th =
  "whitespace-nowrap border-b border-brand-line px-4 py-2.5 text-left text-micro font-semibold uppercase tracking-wide text-neutral-400";
export const td = "border-b border-brand-line/70 px-4 py-2 text-body";
/** Money and counts: mono, tabular, right-aligned. They must line up down a
 *  column and must never reflow as they update. */
export const tdNum = `${td} text-right font-mono text-label tabular-nums`;

export const errorBanner =
  "mb-4 rounded-card bg-bad-bg px-4 py-2.5 text-body text-bad ring-1 ring-bad/15";
export const emptyNote = "px-4 py-5 text-center text-body text-neutral-400";

export function Page(props: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="w-full px-6 py-8 xl:px-10">
      <h1 className="text-display font-semibold text-brand-navy">{props.title}</h1>
      {props.sub && <p className="mb-6 mt-1 text-label text-neutral-500">{props.sub}</p>}
      {props.children}
    </div>
  );
}

/**
 * The trail back up. Muted app text with `›` separators — it used to be blue
 * underlined hypertext sitting on top of every page, which is exactly what made
 * the app read as a web page.
 */
export function Crumbs(props: { trail: Array<{ label: string; href?: string }> }) {
  return (
    <nav className="mb-1 flex flex-wrap items-center gap-1 text-micro text-neutral-400">
      {props.trail.map((c, i) => (
        <span key={`${c.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden className="text-neutral-300">
              ›
            </span>
          )}
          {c.href ? (
            <Link
              href={c.href}
              className="press rounded px-1 py-0.5 font-medium text-neutral-500 hover:bg-neutral-100 hover:text-brand-navy"
            >
              {c.label}
            </Link>
          ) : (
            <span className="px-1 py-0.5 text-neutral-400">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * A number and what it is — the dashboard's KpiCard geometry, exactly.
 *
 * ⚠️ `ok` AND THE DEFAULT ARE BOTH NAVY, DELIBERATELY. Under the palette rule
 * good is the resting state and does not shout; only `bad` takes a colour (deep
 * orange). That means THE LABEL has to say what the number is, because green no
 * longer does it.
 *
 * ⭐ LABEL ABOVE, VALUE BELOW, MONO NUMERALS. `hint` is the third line the old
 * stat shapes had nowhere to put — which is how context ended up as a paragraph
 * somewhere else on the page.
 */
export function Stat(props: {
  value: ReactNode;
  label: string;
  hint?: string;
  tone?: "ok" | "bad" | "navy";
  /** Staggers the entrance, one --stagger step apart, like the landing grid. */
  index?: number;
  onClick?: () => void;
  "data-testid"?: string;
}) {
  const tone = props.tone === "bad" ? "text-bad" : "text-brand-navy";
  // A plain number rises into place; anything pre-formatted ("5 / 12", money)
  // is rendered as given — never re-format someone else's string.
  const counted = useCountUp(typeof props.value === "number" ? props.value : null);
  const shown =
    typeof props.value === "number" ? Math.round(counted) : props.value;
  const clickable = props.onClick
    ? "surface-lift cursor-pointer text-left hover:ring-brand-navy/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
    : "";
  const Tag = props.onClick ? "button" : "div";
  return (
    <Tag
      {...(props.onClick ? { type: "button" as const, onClick: props.onClick } : {})}
      data-testid={props["data-testid"]}
      className={`surface tile-in min-w-[132px] rounded-card px-4 py-3 ring-1 ring-brand-line ${clickable}`}
      style={
        props.index != null
          ? { animationDelay: `calc(${Math.min(props.index, 12)} * var(--stagger))` }
          : undefined
      }
    >
      <div className={fieldLabel}>{props.label}</div>
      <div className={`mt-0.5 font-mono text-title font-semibold tabular-nums ${tone}`}>
        {shown}
      </div>
      {props.hint && <div className="mt-0.5 text-micro text-neutral-400">{props.hint}</div>}
    </Tag>
  );
}

/**
 * ⭐ WHERE THE PROSE WENT.
 *
 * The explanations do not get deleted, they get demoted: the tile face carries
 * a number and two or three words, and the sentence that says which basis it
 * uses lives one hover away. That matters, because the standing rule is that a
 * drill discloses what it is counting — deleting the disclosure to make the
 * page tidy would trade a real property of this app for a visual one.
 */
export function Help(props: { children: string; className?: string }) {
  return (
    <span
      title={props.children}
      tabIndex={0}
      role="note"
      aria-label={props.children}
      className={`press inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full text-[9px] font-semibold text-neutral-400 ring-1 ring-brand-line hover:text-brand-navy hover:ring-brand-navy/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 ${props.className ?? ""}`}
    >
      ?
    </span>
  );
}

/**
 * ⭐ ONE FOOTNOTE PER CARD, AT THE BOTTOM — the only place a full sentence is
 * allowed on a page. It says where the number came from and defines the one
 * word somebody would otherwise ask about. Two sentences is the cap; a third
 * means the content belongs in the card subtitle or nowhere.
 */
export function Foot(props: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`border-t border-brand-line px-4 py-2 text-micro text-neutral-400 ${props.className ?? ""}`}
    >
      {props.children}
    </p>
  );
}

/**
 * The ONE sanctioned coloured box.
 *
 * ⚠️ FOR A CAVEAT ABOUT THE DATA, NEVER FOR EMPHASIS. It is deep orange, which
 * on this palette means bad — so a note that is merely interesting spends the
 * only alarm colour the app has and makes the real one unreadable.
 */
export function Note(props: { children: ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-control bg-bad-bg px-3 py-2 text-micro text-bad ring-1 ring-bad/25">
      <span className="mt-px shrink-0 font-semibold uppercase tracking-wide">Note</span>
      <span className="text-neutral-600">{props.children}</span>
    </div>
  );
}

export function Field(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`mb-3 flex flex-col gap-1 ${props.className ?? ""}`}>
      <label className={fieldLabel}>{props.label}</label>
      {props.children}
    </div>
  );
}

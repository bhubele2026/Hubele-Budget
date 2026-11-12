/**
 * Chart tokens + pure helpers — the numbers and colours behind every chart.
 *
 * This module is deliberately DEPENDENCY-FREE: no React, no recharts, no
 * tailwind helpers (its one import, `./themeNow`, is a ten-line flag). That is what lets the CSS-bar primitive (`./cssBars`) and
 * the unit tests use the same palette as the recharts kit (`./charts`) without
 * dragging 450 KB of charting library along with them. `./charts` re-exports
 * everything here, so `@/lib/charts` stays the one documented import path for
 * pages that draw a real chart.
 *
 * ── THE LAWS ──────────────────────────────────────────────────────────────
 *
 * 1. **navy = good, #e16d3e (orangeDeep) = bad, grey = neutral — and the
 *    LABEL always says which.** Colour separates series and flags the one
 *    thing that wants attention. It is never the only carrier of meaning: a
 *    reader who cannot distinguish the hues must still get the answer from
 *    the text. Never encode good/bad in colour alone.
 *
 * 2. **Sequential data uses `NAVY_RAMP`, indexed by RANK — never by series.**
 *    Light = low, navy = high. Use `rampByRank()`; do not hand a ramp stop to
 *    a series as though it were a categorical colour, or a six-item chart
 *    draws six near-identical navy bands.
 *
 * 3. **Many-series charts use `CAT8`, capped at 8, with the rest rolled into
 *    "Other" (`OTHER_GREY`).** `CAT8`'s lightness alternates so adjacent
 *    series separate. A colour belongs to an ITEM (identity), so it survives
 *    a filter change; it is not reassigned by rank.
 *
 * 4. **Hover-scrubbed lists are CSS bars (`./cssBars`), NEVER recharts.**
 *    Recharts restarts its draw animation on every data-REFERENCE change, so
 *    a list driven by a hover strobes — it snaps back to zero and regrows
 *    under the cursor. `CssBars` transitions `width`/`transform` on rows that
 *    are always mounted, which glides instead.
 *
 * 5. **NO COLOUR ALIASES.** There is no `teal`/`green`/`red`/`primary` name
 *    pointing at one of these hexes. The dashboard this kit is ported from
 *    learned it the hard way: aliases let two series READ as two colours
 *    while drawing the same pixel, and four charts silently rendered two
 *    series in one colour. If you want a colour, name the colour.
 */

import { isDarkNow, quietly } from "./themeNow";

// ── Light and dark ─────────────────────────────────────────────────────────
/**
 * ⭐ EVERY COLOUR TABLE BELOW IS A VIEW, NOT A VALUE. Each keeps the name and
 * shape it always had (`CHART.navy`, `CAT8[i]`, `NAVY_RAMP`, `MARKER.bill`…),
 * so no call site changed; what it returns is the light value or the dark one,
 * whichever theme is on screen at the moment it is READ (`lib/themeNow.ts`,
 * set by `lib/theme.ts`). Light is exactly the hex it always was (the tests
 * pin them). `App.tsx` re-mounts the open page when the theme changes, so
 * every chart redraws and nothing keeps an old ink.
 *
 * ⚠️ A module-level constant that COPIES one of these freezes the light value:
 * `const X = CHART.navy` at the top of a file is navy forever. Read them at
 * render, or build a table of them with `themed(() => ({ … }))`.
 */
export function byTheme<T extends object>(light: T, dark: T): T {
  const now = (): T => (isDarkNow() ? dark : light);
  return new Proxy(light, {
    get: (_t, k) => Reflect.get(now(), k),
    has: (_t, k) => Reflect.has(now(), k),
    ownKeys: () => Reflect.ownKeys(now()),
    getOwnPropertyDescriptor: (_t, k) => Reflect.getOwnPropertyDescriptor(now(), k),
  });
}

/** A table built FROM theme-aware values (`{ income: CHART.navy, … }`), rebuilt for the theme on screen when it is read. */
export function themed<T extends object>(make: () => T): T {
  let light: T | null = null;
  let dark: T | null = null;
  const now = (): T => (isDarkNow() ? (dark ??= make()) : (light ??= make()));
  // The shape the Proxy stands on is built at load: not a draw (lib/themeNow.ts).
  return new Proxy(quietly(make), {
    get: (_t, k) => Reflect.get(now(), k),
    has: (_t, k) => Reflect.has(now(), k),
    ownKeys: () => Reflect.ownKeys(now()),
    getOwnPropertyDescriptor: (_t, k) => Reflect.getOwnPropertyDescriptor(now(), k),
  });
}

// ── Palette ────────────────────────────────────────────────────────────────
// Every series colour is navy, the orange accent, or a steel/mist step
// between. No teal, no emerald, no crimson.
// DARK: the same roles on a black card. The LEAD series is near-white, the
// second a soft blue-grey, mist stays recessive but visible (3.7:1), orange is
// unchanged (always solid, never a half-alpha that would read brown), and the
// alarm keeps its hue. The grid is a faint white hairline.
interface ChartPalette {
  readonly navy: string;
  readonly navy2: string;
  readonly mid: string;
  readonly mist: string;
  readonly steel: string;
  readonly orange: string;
  readonly orangeDeep: string;
  readonly badInk: string;
  readonly grid: string;
}
export const CHART: ChartPalette = byTheme<ChartPalette>(
  {
    navy: "#19315b", // the primary series
    navy2: "#22406e",
    mid: "#3b5c8f", // a mid navy, for a second series
    mist: "#8fa3bf", // light navy — baselines, comparison periods, "no change"
    steel: "#4d5d73", // neutral series, plan lines
    orange: "#f68d2e", // the single bright accent
    orangeDeep: "#e16d3e", // negatives / the thing that is going wrong
    // SMALL alarm TEXT on a chart (the low-point and buffer labels): mirrors
    // --color-bad-ink in index.css (a test pins them equal). Lines, areas and
    // dots keep orangeDeep.
    badInk: "#c2410c",
    grid: "#e8eaee", // gridlines, hairlines: a quiet neutral (2026-11-12)
  },
  {
    navy: "#eef1f6", // near-white: the lead line on a black card
    navy2: "#c9d3e6",
    mid: "#8fa9d6", // soft blue-grey: the second series
    mist: "#66748c", // recessive, still 3.7:1 on the card
    steel: "#aab3c2",
    orange: "#f68d2e", // unchanged
    orangeDeep: "#e16d3e", // 5.5:1 on the card as it is
    badInk: "#ee7d50", // = --color-bad-ink in the DARK block of index.css
    grid: "rgba(255, 255, 255, 0.08)",
  },
);

/**
 * The colour of a TRANSLUCENT fill: the wash under a line, a risk band, a
 * faded stack. Light: the colour itself. Dark: orange and the alarm colour
 * become a neutral grey, because their half-alpha over black is a dark orange,
 * which is brown (the one thing this palette never is). The line or edge drawn
 * over the wash keeps its real colour and still says which series it is.
 */
export function washOf(color: string): string {
  if (!isDarkNow()) return color;
  const c = color.toLowerCase();
  return c === "#f68d2e" || c === "#e16d3e" || c === "#ee7d50" ? "#9aa1ad" : color;
}

/**
 * The ink a chart draws its WORDS and FURNITURE in: tick text, a category
 * label, the plate or halo under a label (= the card), the look-back band,
 * the tooltip card, the hover cursor, text printed inside a filled cell.
 * These were hex literals spread over the chart files; they are tokens so
 * dark has a value for each.
 */
interface ChartInk {
  readonly axis: string; // tick text
  readonly label: string; // a category / value label
  readonly plate: string; // the card colour: label plates, donut gaps, dot rings
  readonly band: string; // the look-back backdrop
  readonly tooltipBg: string;
  readonly tooltipLine: string;
  readonly tooltipInk: string;
  readonly tooltipShadow: string;
  readonly onFill: string; // text inside a strongly filled cell
}
export const CHART_INK: ChartInk = byTheme<ChartInk>(
  {
    axis: "#6b7280",
    label: "#363d4a",
    plate: "#ffffff",
    band: "#f1f2f5",
    // The tooltip is a white panel with a fine border (2026-11-12): one faint neutral shadow, never navy-tinted.
    tooltipBg: "#ffffff",
    tooltipLine: "#e3e6eb",
    tooltipInk: "#1d2330",
    tooltipShadow: "0 4px 14px -4px rgb(17 24 39 / 0.12)",
    onFill: "#ffffff",
  },
  {
    axis: "#9aa1ad",
    label: "#c5c9d1",
    plate: "#17181b",
    band: "#1e2024",
    tooltipBg: "#1e2024",
    tooltipLine: "#3a3e46",
    tooltipInk: "#f3f4f6",
    tooltipShadow: "0 10px 28px -8px rgb(0 0 0 / 0.7)",
    onFill: "#0e0f11",
  },
);

/**
 * Validated 8-hue categorical set for charts that cap at 8 series + an
 * "Other" rollup. Assign IN ORDER and keep an item's slot stable across
 * filter changes — the colour marks identity, not rank.
 */
export const CAT8: readonly string[] = byTheme<readonly string[]>(
  ["#19315b", "#3b5c8f", "#f68d2e", "#4d5d73", "#8fa3bf", "#22406e", "#e16d3e", "#a9bad2"],
  // Dark: lightness still alternates down the list, every slot ≥ 3:1 on the card.
  ["#eef1f6", "#8fa9d6", "#f68d2e", "#aab3c2", "#5d7299", "#c9d3e6", "#e16d3e", "#7689a8"],
);

/**
 * Account identity accents — the same hexes as the `--color-acct-*` tokens in
 * `index.css`. Used for chart series and legends so a line is the colour of
 * the chip that names it. Distinct from each other by construction (pinned by
 * a test); `checking` is the brand navy on purpose.
 */
interface AccountAccents {
  readonly checking: string;
  readonly amex: string;
  readonly card2: string;
  readonly other: string;
}
export const ACCOUNT_ACCENT: AccountAccents = byTheme<AccountAccents>(
  { checking: "#19315b", amex: "#0f766e", card2: "#5b4bb3", other: "#5d6674" },
  // = the --color-acct-* values in the DARK block of index.css.
  { checking: "#9db8e3", amex: "#3fb8a9", card2: "#a595ee", other: "#9aa1ad" },
);
export type AccountAccent = keyof AccountAccents;

/**
 * Forecast event markers (the expanded chart). One colour per kind, each also
 * told apart by SHAPE and by the legend label, so colour is never alone:
 * payday = navy up-tick, bill = steel dot, card payment = the Amex accent
 * square, debt payment = orange diamond.
 */
interface Markers {
  readonly payday: string;
  readonly bill: string;
  readonly card: string;
  readonly debt: string;
}
export const MARKER: Markers = byTheme<Markers>(
  { payday: "#19315b", bill: "#4d5d73", card: "#0f766e", debt: "#f68d2e" },
  { payday: "#eef1f6", bill: "#aab3c2", card: "#3fb8a9", debt: "#f68d2e" },
);
export type MarkerKind = keyof Markers;

/**
 * Desaturated neutral grey for the "All others" rollup band.
 *
 * ⚠️ THIS VALUE IS LOAD-BEARING AND IS PINNED BY A TEST. It used to be
 * `#8fa3bf` — byte-identical to `CAT8[4]` and to `CHART.mist` — so any chart
 * using the kit's own documented shape (cap at 8, roll the tail into "Other")
 * drew slice 4 and the Other slice in ONE colour as soon as a fifth category
 * appeared. That is precisely the failure law 5 exists to prevent, sitting
 * inside the kit's own tokens; `SpendingPage` had to carry a local substitute
 * to dodge it.
 *
 * The replacement is chosen by measurement, not by eye. `#767b83` is a true
 * low-chroma grey (the eight identities are all navy-family or orange), and
 * its CIEDE2000 distance to the NEAREST `CAT8` member is **13.6** — against an
 * internal `CAT8` minimum separation of 5.1. The rollup is therefore further
 * from every identity than the identities are from each other, which is the
 * right hierarchy: "Other" is the absence of an identity and must never be
 * mistaken for one. It is also absent from `NAVY_RAMP` (min ΔE 15.5) and from
 * the platinum surface ramp (min ΔE 31.6), so it cannot collide with a
 * sequential encoding or vanish into a card.
 */
export const OTHER_GREY = "#767b83";

/**
 * Sequential ramp for intensity/heat encoding (light = low, navy = high).
 * Six steps graduating from the border grey into the brand navy.
 * Sequential, NOT categorical: index it by rank via `rampByRank()`.
 */
export const NAVY_RAMP: readonly string[] = byTheme<readonly string[]>(
  ["#e1e8f0", "#c4d0e2", "#a9bad2", "#8fa3bf", "#3b5c8f", "#19315b"],
  // Dark turns the anchor over: low sits near the card, high is near-white.
  ["#2c3342", "#3a4963", "#516a94", "#7690bd", "#aabfe2", "#eef1f6"],
);

/**
 * Colour for the item at `rank` out of `total`, on the sequential ramp.
 *
 * Rank 0 is the LARGEST / most intense item and gets the darkest navy;
 * increasing rank walks toward the light end. Ranks are spread across all
 * six stops, so a 3-item list uses the whole ramp rather than three
 * indistinguishable navies at one end of it.
 */
export function rampByRank(rank: number, total: number): string {
  const last = NAVY_RAMP.length - 1;
  if (!Number.isFinite(rank) || !Number.isFinite(total) || total <= 1) {
    return NAVY_RAMP[last]!;
  }
  const r = Math.min(Math.max(Math.floor(rank), 0), Math.floor(total) - 1);
  const step = Math.floor((r / Math.floor(total)) * NAVY_RAMP.length);
  return NAVY_RAMP[Math.min(Math.max(last - step, 0), last)]!;
}

/**
 * Categorical colour for the series at `index`. Anything at or past the 8th
 * slot is the "Other" rollup — cap the series list at 8 and sum the tail
 * rather than letting a 9th colour appear.
 */
export function catColor(index: number): string {
  if (!Number.isFinite(index) || index < 0 || index >= CAT8.length) {
    return OTHER_GREY;
  }
  return CAT8[Math.floor(index)]!;
}

// ── Motion ─────────────────────────────────────────────────────────────────
/**
 * One speed dial for the whole kit. Everything below is `base * SPEED`, so
 * the charts draw at the same calm pace as the rest of the app's motion.
 */
export const SPEED = 1;

/** Full entrance sweep — bars grow, lines draw, areas rise. */
export const REVEAL_MS = Math.round(700 * SPEED); // 700

/** A shape MOVING to a new value (rank change, rescale) rather than arriving. */
export const MORPH_MS = Math.round(600 * SPEED); // 600

/**
 * Recharts animates in JS, so the global CSS reduced-motion guard cannot
 * reach it — gate here instead. A module-load read is enough; the preference
 * effectively never changes mid-session. `./cssBars` reads the same flag so
 * both halves of the kit honour the preference identically.
 */
export const PREFERS_REDUCED_MOTION: boolean =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A bar growing, a line drawing and an area rising are all TRAVEL — you watch
// them move — so they take the symmetric curve. Recharts only accepts the
// named CSS keywords here, not a cubic-bezier, so "ease-in-out" is the closest
// expression of that shape.
export const ANIM_BAR = {
  isAnimationActive: !PREFERS_REDUCED_MOTION,
  animationEasing: "ease-in-out",
  animationDuration: REVEAL_MS,
} as const;
export const ANIM_LINE = ANIM_BAR;
export const ANIM_AREA = ANIM_BAR;

/**
 * ⭐ (Clean forecast line) The calm Forecast chart. It draws in ONCE with one slow
 * left-to-right sweep (the `.area-draw.draw-once` mask; `DRAW_MS` mirrors
 * `--dur-draw` in index.css), the low point answers with one ring pulse
 * (`.low-pulse`, `PULSE_MS`), and the hover card follows the pointer in
 * `FOLLOW_MS`. Stroke widths for its one line, the cushion rule, the hover
 * hairline and the payday ticks live here too, so the chart file holds none.
 */
export const DRAW_MS = Math.round(1100 * SPEED); // 1100
export const PULSE_MS = Math.round(900 * SPEED); // 900
export const FOLLOW_MS = Math.round(160 * SPEED); // 160
export const CALM_STROKE = {
  // (2026-11-12) Restrained line weights: the one balance line is 1.75 px.
  balance: 1.75,
  cushion: 1,
  hairline: 1,
  paydayTick: 2,
} as const;

/**
 * Stagger for mapped series, so a multi-series chart cascades in instead of
 * every series starting at once. `i` is the series index.
 */
export const animBegin = (i = 0): number => 140 + i * 80;

// ── Axes ───────────────────────────────────────────────────────────────────
// (2026-11-12) One label size for every chart: 12 px Inter, the app's own label step.
export const AXIS_TICK: { readonly fontSize: number; readonly fill: string } = themed(() => ({ fontSize: 12, fill: CHART_INK.axis }));
export const LEGEND_STYLE = { fontSize: 12 } as const;

/**
 * A rounded tick step with clear air above the tallest point. Two jobs:
 *
 * Without an explicit domain, recharts pins the plot ceiling to the DATA max,
 * so the tallest bar's printed value draws outside the svg and gets clipped
 * in half. And recharts' auto ticks divide that raw max by four — a series
 * topping out at 340 gets 0/85/170/255/340 where a reader wants
 * 0/100/200/300/400.
 *
 * The returned domain has **≥8% headroom by construction** (the padded max is
 * ceil'd up to a whole step), so a top-of-chart value label always has room.
 */
export function niceAxis(
  min: number,
  max: number,
): { domain: [number, number]; ticks: number[] } {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (!isFinite(hi - lo) || (hi === 0 && lo === 0)) {
    return { domain: [0, 1], ticks: [0, 1] };
  }
  const rawStep = ((hi - lo) * 1.08) / 4;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 1.5, 2, 2.5, 3, 4, 5, 8, 10]
      .map((m) => m * mag)
      .find((v) => v >= rawStep) ?? 10 * mag;
  // Ceil the PADDED max to a step multiple, so headroom is ≥8% by construction.
  const top = hi > 0 ? Math.ceil((hi * 1.08) / step) * step : 0;
  const bottom = lo < 0 ? -Math.ceil((-lo * 1.08) / step) * step : 0;
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) {
    ticks.push(Math.round(v * 1e9) / 1e9);
  }
  return { domain: [bottom, top], ticks };
}

// ── Formatting ─────────────────────────────────────────────────────────────
/**
 * Short money for axis ticks and bar labels ("$1.2K", "$3M"). Axis ticks have
 * ~55px to work with; the full `formatCurrency` does not fit and wraps.
 */
export function compactUSD(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  }
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

// ── CSS-bar geometry (shared with ./cssBars, kept pure so it is testable) ──
/**
 * A bar's width as a percentage of its track, from the row's value and the
 * largest magnitude in the visible set. Clamped to 0–100 so a stale `max`
 * can never push a bar outside its track.
 */
export function barWidthPct(value: number, max: number): number {
  const v = Math.abs(Number(value));
  const m = Math.abs(Number(max));
  if (!Number.isFinite(v) || !Number.isFinite(m) || m === 0) return 0;
  return Math.min(100, Math.max(0, (v / m) * 100));
}

/**
 * A bar's colour from the SIGN of its value: navy up, deep orange down, mist
 * for no movement. Law 1 applies — whatever renders this bar must also print
 * the number, because the colour alone is not the message.
 */
export function barColorForSign(value: number): string {
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return CHART.mist;
  return v > 0 ? CHART.navy : CHART.orangeDeep;
}

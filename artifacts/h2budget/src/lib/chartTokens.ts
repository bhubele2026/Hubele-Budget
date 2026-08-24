/**
 * Chart tokens + pure helpers — the numbers and colours behind every chart.
 *
 * This module is deliberately DEPENDENCY-FREE: no React, no recharts, no
 * tailwind helpers. That is what lets the CSS-bar primitive (`./cssBars`) and
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

// ── Palette ────────────────────────────────────────────────────────────────
// Every series colour is navy, the orange accent, or a steel/mist step
// between. No teal, no emerald, no crimson.
export const CHART = {
  navy: "#19315b", // the primary series
  navy2: "#22406e",
  mid: "#3b5c8f", // a mid navy, for a second series
  mist: "#8fa3bf", // light navy — baselines, comparison periods, "no change"
  steel: "#4d5d73", // neutral series, plan lines
  orange: "#f68d2e", // the single bright accent
  orangeDeep: "#e16d3e", // negatives / the thing that is going wrong
  grid: "#e1e8f0", // gridlines, hairlines
} as const;

/**
 * Validated 8-hue categorical set for charts that cap at 8 series + an
 * "Other" rollup. Assign IN ORDER and keep an item's slot stable across
 * filter changes — the colour marks identity, not rank.
 */
export const CAT8: readonly string[] = [
  "#19315b",
  "#3b5c8f",
  "#f68d2e",
  "#4d5d73",
  "#8fa3bf",
  "#22406e",
  "#e16d3e",
  "#a9bad2",
];

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
export const NAVY_RAMP: readonly string[] = [
  "#e1e8f0",
  "#c4d0e2",
  "#a9bad2",
  "#8fa3bf",
  "#3b5c8f",
  "#19315b",
];

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
export const SPEED = 2.2;

/** Full entrance sweep — bars grow, lines draw, areas rise. */
export const REVEAL_MS = Math.round(700 * SPEED); // 1540

/** A shape MOVING to a new value (rank change, rescale) rather than arriving. */
export const MORPH_MS = Math.round(600 * SPEED); // 1320

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
 * Stagger for mapped series, so a multi-series chart cascades in instead of
 * every series starting at once. `i` is the series index.
 */
export const animBegin = (i = 0): number => 140 + i * 80;

// ── Axes ───────────────────────────────────────────────────────────────────
export const AXIS_TICK = { fontSize: 11, fill: "#64748b" } as const;
export const LEGEND_STYLE = { fontSize: 11 } as const;

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

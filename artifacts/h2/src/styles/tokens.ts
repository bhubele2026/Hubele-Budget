/**
 * ⭐ "PAPER & RULE" — the palette as data.
 *
 * `index.css` declares these as Tailwind `@theme` colours; this file is the
 * same table in TypeScript so the contrast test and the `/design` page can
 * measure what ships. `tokens.test.ts` parses `index.css` and fails if the two
 * ever disagree, so neither copy can drift on its own.
 *
 * Light only (`color-scheme: light`). The names are semantic (paper, ink,
 * moss, clay…) so a dark set can be added later without renaming a call site.
 *
 * ⚠️ ink-3 is #6C6860, not the #77726A first drawn: #77726A measured 4.23:1 on
 * paper-1 and 3.90:1 on paper-2, under the 4.5:1 floor every ink×paper pair
 * must clear. #6C6860 is the same hue scaled 9% darker (4.54:1 on paper-2).
 */
export const PALETTE = {
  "paper-0": "#FBFAF7",
  "paper-1": "#F4F1EA",
  "paper-2": "#ECE8DF",
  rule: "#D9D4C7",
  "rule-strong": "#B9B2A2",
  ink: "#1E1C18",
  "ink-2": "#5B574E",
  "ink-3": "#6C6860",
  moss: "#2E5E4E",
  "moss-ink": "#1F4336",
  "moss-wash": "#E6EEE9",
  ochre: "#8A6A1F",
  "ochre-wash": "#F3ECD9",
  clay: "#A8432F",
  "clay-wash": "#F6E6E0",
  slate: "#4E5B6B",
  "slate-wash": "#E7EBEF",
  // Sequential: moss → #E0E7E2 in five even sRGB steps. Index by RANK.
  "ramp-1": "#2E5E4E",
  "ramp-2": "#52796C",
  "ramp-3": "#759589",
  "ramp-4": "#99B0A7",
  "ramp-5": "#BCCCC4",
  "ramp-6": "#E0E7E2",
  // Categorical identity, capped at eight; the tail rolls into cat-other.
  "cat-1": "#2E5E4E",
  "cat-2": "#8A6A1F",
  "cat-3": "#4E5B6B",
  "cat-4": "#A8432F",
  "cat-5": "#6E4A6B",
  "cat-6": "#2F6B70",
  "cat-7": "#7A5538",
  "cat-8": "#8C8A82",
  "cat-other": "#B9B2A2",
} as const;

export type ColorToken = keyof typeof PALETTE;

export const PAPERS = ["paper-0", "paper-1", "paper-2"] as const satisfies readonly ColorToken[];
export const INKS = ["ink", "ink-2", "ink-3"] as const satisfies readonly ColorToken[];
/** Accents that may set text on the page ground (paper-0). */
export const TEXT_ACCENTS = ["moss", "moss-ink", "ochre", "clay", "slate"] as const satisfies readonly ColorToken[];
export const WASHES = ["moss-wash", "ochre-wash", "clay-wash", "slate-wash"] as const satisfies readonly ColorToken[];
export const RAMP = ["ramp-1", "ramp-2", "ramp-3", "ramp-4", "ramp-5", "ramp-6"] as const satisfies readonly ColorToken[];
export const CATEGORICAL = [
  "cat-1",
  "cat-2",
  "cat-3",
  "cat-4",
  "cat-5",
  "cat-6",
  "cat-7",
  "cat-8",
] as const satisfies readonly ColorToken[];

/**
 * The type scale, as the `/design` page specimens it. Sizes/line-heights in px;
 * `phone` is the size below 640 px where it differs.
 */
export const TYPE_SCALE = [
  { name: "figure-xl", family: "mono", size: 44, line: 48, phone: [36, 40], weight: 500, note: "The one number a screen exists for. Once per screen." },
  { name: "figure", family: "mono", size: 22, line: 28, weight: 500, note: "Secondary figures." },
  { name: "figure-sm", family: "mono", size: 14, line: 20, weight: 400, note: "Figures in rows and sentences." },
  { name: "headline", family: "serif", size: 26, line: 32, weight: 500, note: "Page headline. Tracking −0.01em." },
  { name: "section", family: "serif", size: 12, line: 16, weight: 500, note: "Section labels. Uppercase, tracking 0.08em." },
  { name: "body", family: "sans", size: 14, line: 20, phone: [15, 22], weight: 400, note: "Everything ordinary." },
  { name: "label", family: "sans", size: 12.5, line: 16, weight: 500, note: "Field and figure labels." },
  { name: "caption", family: "sans", size: 11.5, line: 14, weight: 400, note: "Sub-lines and footnotes." },
] as const;

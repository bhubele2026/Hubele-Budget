import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CATEGORICAL,
  INKS,
  PALETTE,
  PAPERS,
  RAMP,
  TEXT_ACCENTS,
  type ColorToken,
} from "./tokens";
import { contrastRatio, formatRatio, luminance } from "./contrast";

/**
 * ⭐ THE PALETTE IS MEASURED, NOT ASSUMED.
 *
 * 1. Every text pair the system allows clears WCAG AA (4.5:1).
 * 2. `index.css` and `tokens.ts` declare the same palette, hex for hex.
 * 3. No colour reaches the screen from outside the palette.
 */

const PKG = [resolve(process.cwd()), resolve(process.cwd(), "artifacts/h2")].find((p) =>
  existsSync(join(p, "src/styles/index.css")),
);
if (!PKG) throw new Error("artifacts/h2 not found from cwd " + process.cwd());
const CSS = readFileSync(join(PKG, "src/styles/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const AA = 4.5;

const hex = (t: ColorToken) => PALETTE[t];

describe("contrast — every ink on every paper clears 4.5:1", () => {
  const pairs = INKS.flatMap((ink) => PAPERS.map((paper) => [ink, paper] as const));
  it.each(pairs)("%s on %s", (ink, paper) => {
    const r = contrastRatio(hex(ink), hex(paper));
    expect(r, `${ink} on ${paper} is ${formatRatio(r)}`).toBeGreaterThanOrEqual(AA);
  });
});

describe("contrast — every text accent on paper-0 clears 4.5:1", () => {
  it.each(TEXT_ACCENTS)("%s on paper-0", (accent) => {
    const r = contrastRatio(hex(accent), hex("paper-0"));
    expect(r, `${accent} on paper-0 is ${formatRatio(r)}`).toBeGreaterThanOrEqual(AA);
  });
});

describe("contrast — the pairs the kit actually draws", () => {
  const KIT_PAIRS: Array<[ColorToken, ColorToken, string]> = [
    ["paper-0", "moss", "primary button label"],
    ["paper-0", "moss-ink", "primary button, hovered"],
    ["clay", "clay-wash", "danger button, hovered"],
    ["moss-ink", "paper-0", "status: on plan / fresh"],
    ["moss-ink", "paper-1", "status: on plan on a raised row"],
    ["clay", "paper-1", "status: over on a raised row"],
    ["moss", "paper-1", "link on a raised row"],
    ["ink-2", "paper-1", "Clerk footer text"],
    ["moss-ink", "moss-wash", "text on the moss wash"],
  ];
  it.each(KIT_PAIRS)("%s on %s (%s)", (fg, bg) => {
    expect(contrastRatio(hex(fg), hex(bg))).toBeGreaterThanOrEqual(AA);
  });

  it("documents why ink-3 moved: the first-drawn #77726A fails on paper-1 and paper-2", () => {
    expect(contrastRatio("#77726A", hex("paper-1"))).toBeLessThan(AA);
    expect(contrastRatio("#77726A", hex("paper-2"))).toBeLessThan(AA);
    expect(hex("ink-3")).toBe("#6C6860");
  });

  it("measures correctly: black on white is 21:1, a colour on itself 1:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#2E5E4E", "#2E5E4E")).toBe(1);
  });
});

describe("index.css and tokens.ts declare one palette", () => {
  const theme = CSS.slice(CSS.indexOf("@theme"));
  const declared = new Map(
    Array.from(theme.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g), (m) => [
      m[1]!,
      m[2]!.toUpperCase(),
    ]),
  );

  it("declares exactly the tokens.ts palette, hex for hex", () => {
    expect(Object.fromEntries(declared)).toEqual(
      Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, v.toUpperCase()])),
    );
  });

  it("clears Tailwind's default palette, type scale, radii and shadows", () => {
    for (const ns of ["--color-*", "--text-*", "--radius-*", "--shadow-*", "--animate-*"]) {
      expect(theme, `${ns} not cleared`).toContain(`${ns}: initial;`);
    }
  });

  it("the boot frame in index.html paints only palette colours", () => {
    const html = readFileSync(join(PKG, "index.html"), "utf8");
    const used = Array.from(html.matchAll(/#[0-9a-fA-F]{6}\b/g), (m) => m[0].toUpperCase());
    const allowed = new Set(Object.values(PALETTE).map((v) => v.toUpperCase()));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((c) => !allowed.has(c))).toEqual([]);
  });
});

describe("palette structure", () => {
  it("no two semantic tokens share a hex (no aliases)", () => {
    const semantic = (Object.keys(PALETTE) as ColorToken[]).filter(
      (k) => !k.startsWith("ramp-") && !k.startsWith("cat-"),
    );
    const seen = new Map<string, string>();
    for (const k of semantic) {
      const v = hex(k).toUpperCase();
      expect(seen.get(v), `${k} repeats ${seen.get(v)}`).toBeUndefined();
      seen.set(v, k);
    }
  });

  it("the ramp runs from moss to #E0E7E2 and lightens at every step", () => {
    expect(hex(RAMP[0])).toBe(hex("moss"));
    expect(hex(RAMP[RAMP.length - 1])).toBe("#E0E7E2");
    for (let i = 1; i < RAMP.length; i++) {
      expect(luminance(hex(RAMP[i]!))).toBeGreaterThan(luminance(hex(RAMP[i - 1]!)));
    }
  });

  it("categorical identity: eight distinct colours, and cat-other is none of them", () => {
    const cats = CATEGORICAL.map((c) => hex(c).toUpperCase());
    expect(cats).toHaveLength(8);
    expect(new Set(cats).size).toBe(8);
    expect(cats).not.toContain(hex("cat-other").toUpperCase());
    expect(cats.slice(0, 4)).toEqual([hex("moss"), hex("ochre"), hex("slate"), hex("clay")]);
  });
});

describe("no colour literal outside the palette files", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "styles" ? [] : sources(p);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });
  }

  it("no #hex and no arbitrary colour class in any screen, shell or kit file", () => {
    const offenders: string[] = [];
    for (const file of sources(join(PKG, "src"))) {
      const text = readFileSync(file, "utf8");
      if (/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/.test(text.replace(/href="#[a-z-]+"/g, ""))) {
        offenders.push(`${file}: hex literal`);
      }
      if (/\b(bg|text|border|ring|outline|fill|stroke|decoration|from|to|via)-\[(#|rgb|hsl)/.test(text)) {
        offenders.push(`${file}: arbitrary colour class`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

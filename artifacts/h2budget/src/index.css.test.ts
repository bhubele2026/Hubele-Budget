import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Cascade guards for `index.css`.
 *
 * These assert STRUCTURE, not appearance, because the bug they exist for was
 * invisible in every other kind of check: a `prefers-reduced-motion` block that
 * read correctly, passed review, shipped — and did nothing, because it sat in
 * the wrong half of the cascade. jsdom cannot catch it either (it implements
 * neither `@layer` nor custom-property resolution), so the invariant is pinned
 * against the source text instead.
 */

/** Runs from the package dir under vitest, from the repo root under some IDEs. */
const CSS_PATH = [
  resolve(process.cwd(), "src/index.css"),
  resolve(process.cwd(), "artifacts/h2budget/src/index.css"),
].find(existsSync);

if (!CSS_PATH) throw new Error("index.css not found from cwd " + process.cwd());

const CSS = readFileSync(CSS_PATH, "utf8");

/** Comments are stripped first — several of them QUOTE the declarations below. */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

type Block = { header: string; start: number };

/**
 * Every declaration of `prop`, with the stack of block headers enclosing it.
 * A hand-rolled walk rather than a CSS parser: the whole point is to observe
 * the raw nesting, and a dependency-free guard cannot itself rot.
 */
function declarationsOf(prop: string): { stack: string[]; start: number }[] {
  const out: { stack: string[]; start: number }[] = [];
  const stack: Block[] = [];
  let header = "";
  for (let i = 0; i < SRC.length; i++) {
    const ch = SRC[i]!;
    if (ch === "{") {
      stack.push({ header: header.trim(), start: i });
      header = "";
    } else if (ch === "}") {
      stack.pop();
      header = "";
    } else if (ch === ";") {
      const decl = header.trim();
      if (decl.startsWith(`${prop}:`)) {
        out.push({
          stack: stack.map((b) => b.header),
          start: stack[stack.length - 1]?.start ?? i,
        });
      }
      header = "";
    } else {
      header += ch;
    }
  }
  return out;
}

const isLayered = (stack: string[]) => stack.some((h) => h.startsWith("@layer"));
const inReduceMedia = (stack: string[]) =>
  stack.some((h) => /@media[^{]*prefers-reduced-motion:\s*reduce/.test(h));

describe("index.css — the reduced-motion switch actually reaches the dials", () => {
  const speedDecls = declarationsOf("--anim-speed");

  it("declares the speed dial exactly twice: the default and the reduce override", () => {
    // Sanity/positive control — if this drifts, every assertion below is
    // inspecting something other than what it thinks it is.
    expect(speedDecls).toHaveLength(2);
  });

  it("sets the default dial to 2.2 at top level, outside every @layer", () => {
    const base = speedDecls.find((d) => !inReduceMedia(d.stack))!;
    expect(base).toBeDefined();
    expect(base.stack).toEqual([":root"]);
    expect(isLayered(base.stack)).toBe(false);
    expect(SRC).toMatch(/--anim-speed:\s*2\.2\s*;/);
  });

  /**
   * ⚠️ THE REGRESSION THIS FILE EXISTS FOR.
   *
   * In the CSS cascade, UNLAYERED declarations beat LAYERED ones outright —
   * layer order is consulted only among layered declarations. The reduce
   * override lived inside `@layer utilities`, so it lost to the unlayered
   * `:root` and `--anim-speed` still computed 2.2 under `reduce`. The failure
   * was masked by the `!important` `animation: none` list sitting beside it,
   * which killed the specific classes it happened to name while every
   * `calc(… * var(--anim-speed))` duration elsewhere kept its full length.
   */
  it("puts the reduce override UNLAYERED too, so it is not shadowed", () => {
    const reduce = speedDecls.find((d) => inReduceMedia(d.stack))!;
    expect(reduce).toBeDefined();
    expect(isLayered(reduce.stack)).toBe(false);
    expect(reduce.stack[reduce.stack.length - 1]).toBe(":root");
  });

  it("puts the reduce override AFTER the default, since a tie is settled by source order", () => {
    const base = speedDecls.find((d) => !inReduceMedia(d.stack))!;
    const reduce = speedDecls.find((d) => inReduceMedia(d.stack))!;
    expect(reduce.start).toBeGreaterThan(base.start);
  });

  it("zeroes every dial the motion system is written against, not just the speed", () => {
    for (const dial of [
      "--anim-speed",
      "--dur-press",
      "--dur-in",
      "--dur-page",
      "--stagger",
    ]) {
      const decls = declarationsOf(dial).filter((d) => inReduceMedia(d.stack));
      expect(decls, `${dial} has no reduced-motion override`).toHaveLength(1);
      expect(isLayered(decls[0]!.stack), `${dial} override is layered`).toBe(false);
    }
    // Every one of them resolves to zero time.
    const block = SRC.slice(
      SRC.indexOf("@media (prefers-reduced-motion: reduce)"),
    ).slice(0, 400);
    expect(block).toMatch(/--anim-speed:\s*0\s*;/);
    expect(block).toMatch(/--dur-press:\s*0ms\s*;/);
    expect(block).toMatch(/--dur-in:\s*0ms\s*;/);
    expect(block).toMatch(/--dur-page:\s*0ms\s*;/);
    expect(block).toMatch(/--stagger:\s*0ms\s*;/);
  });
});

describe("index.css — the literal-duration kills stay, because dials cannot reach them", () => {
  /**
   * Zeroing the dials covers everything written as `calc(… * var(--anim-speed))`
   * — but not durations spelled as literals. These two are exactly that, which
   * is why the `!important` half of the switch is NOT redundant now that the
   * dials work.
   */
  it("still kills the classes whose durations are hardcoded", () => {
    expect(SRC).toMatch(/animation-delay:\s*224ms/); // .stagger nth-child ladder
    expect(SRC).toMatch(/animation:\s*skeletonSweep\s+1\.6s/); // literal, infinite
    const kills = SRC.slice(SRC.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(kills).toMatch(/\.skeleton[^{]*\{[^}]*animation:\s*none\s*!important/s);
    expect(kills).toMatch(/\.stagger\s*>\s*\*/);
  });

  it("collapses Radix overlay lifecycles instead of removing them", () => {
    // An animation removed outright never fires `animationend`, so a Radix
    // overlay would stay mounted. Near-instant, not `none`.
    const kills = SRC.slice(SRC.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(kills).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });
});

/** Every declaration of `prop` with its value and enclosing block headers. */
function valuesOf(prop: string): { stack: string[]; value: string; at: number }[] {
  const out: { stack: string[]; value: string; at: number }[] = [];
  const stack: string[] = [];
  let header = "";
  for (let i = 0; i < SRC.length; i++) {
    const ch = SRC[i]!;
    if (ch === "{") {
      stack.push(header.trim());
      header = "";
    } else if (ch === "}") {
      stack.pop();
      header = "";
    } else if (ch === ";") {
      const decl = header.trim();
      if (decl.startsWith(`${prop}:`)) out.push({ stack: [...stack], value: decl.slice(prop.length + 1).trim(), at: i });
      header = "";
    } else {
      header += ch;
    }
  }
  return out;
}

/** "0.75rem" → 12, "12px" → 12 (the app's root font size is the browser's 16px). */
const px = (v: string) => (v.endsWith("rem") ? parseFloat(v) * 16 : parseFloat(v));
const MD = /@media\s*\(width >= 48rem\)/;

describe("index.css — the shell scroll contract (C0)", () => {
  const at = (prop: string, md: boolean) => {
    const hits = valuesOf(prop).filter((d) => d.stack[d.stack.length - 1] === ":root" && MD.test(d.stack.join(" ")) === md);
    expect(hits, `${prop} ${md ? "md" : "base"}`).toHaveLength(1);
    expect(isLayered(hits[0]!.stack)).toBe(false);
    return hits[0]!.value;
  };

  it("publishes the shell padding: p-3 below md, md:p-5 from md (Tailwind's 48rem)", () => {
    expect(px(at("--shell-pad-x", false))).toBe(12);
    expect(px(at("--shell-pad-y", false))).toBe(12);
    expect(px(at("--shell-pad-x", true))).toBe(20);
    expect(px(at("--shell-pad-y", true))).toBe(20);
    expect(at("--page-sticky-top", false)).toBe("0px");
  });

  /**
   * (C13) The legacy overshoot is retired. C0 kept the three sticky heads'
   * old 16 px / 32 px bleed (`-mx-4 -mt-4`, `md:-mx-8 md:-mt-8`) as shell pad +
   * a 4/12 px overshoot so no pixel moved; the restyles took those pixels on
   * purpose (D18): Chase and Amex dropped their heads, and the forecast head
   * now bleeds exactly the shell pad — 0 at both sizes.
   */
  it("the overshoot is 0 at both sizes: a head bleeds exactly the shell pad", () => {
    expect(at("--page-head-overshoot", false)).toBe("0px");
    // The md block no longer sets it, so it stays 0 there too.
    const mdHits = valuesOf("--page-head-overshoot").filter((d) => MD.test(d.stack.join(" ")));
    expect(mdHits).toEqual([]);
  });

  it("the head and bleed classes are built from the variables, in @layer utilities (so a parent's space-y-* cannot zero the margin)", () => {
    const of = (cls: string, prop: string) =>
      valuesOf(prop).filter((d) => d.stack[d.stack.length - 1] === cls);
    const bleedX = "calc(var(--shell-pad-x) + var(--page-head-overshoot))";
    for (const cls of [".page-sticky-head", ".page-bleed-x"]) {
      const mi = of(cls, "margin-inline");
      expect(mi, cls).toHaveLength(1);
      expect(mi[0]!.value).toBe(`calc(-1 * (var(--shell-pad-x) + var(--page-head-overshoot)))`);
      expect(of(cls, "padding-inline")[0]!.value).toBe(bleedX);
      expect(mi[0]!.stack.some((h) => h === "@layer utilities")).toBe(true);
    }
    expect(of(".page-sticky-head", "margin-top")[0]!.value).toBe(`calc(-1 * (var(--shell-pad-y) + var(--page-head-overshoot)))`);
    expect(of(".shell-pad", "padding")[0]!.value).toBe("var(--shell-pad-y) var(--shell-pad-x)");
    expect(of(".shell-scroller", "scrollbar-gutter")[0]!.value).toBe("stable");
  });

  it("a sticky-safe panel clips without becoming a scroll container", () => {
    const clip = valuesOf("overflow").filter((d) => d.stack[d.stack.length - 1] === ".panel-sticky-safe");
    expect(clip).toHaveLength(1);
    expect(clip[0]!.value).toBe("clip");
    // Same layer as .panel and AFTER its `overflow: hidden`, so it wins the tie.
    const base = valuesOf("overflow").find((d) => d.stack[d.stack.length - 1] === ".panel")!;
    expect(base.value).toBe("hidden");
    expect(clip[0]!.stack.slice(0, -1)).toEqual(base.stack.slice(0, -1));
    expect(clip[0]!.at).toBeGreaterThan(base.at);
  });

  it("no longer claims html is the scroller", () => {
    expect(CSS).not.toMatch(/`html` IS THE SOLE VERTICAL SCROLLER/);
    expect(CSS).toMatch(/Inside the signed-in shell that scroller is `<main>`/);
  });
});

describe("index.css — the milled surface keeps its depth under a ring (dashboard refinement)", () => {
  const shadowOf = (sel: string) => valuesOf("box-shadow").filter((d) => d.stack[d.stack.length - 1] === sel);

  it(".surface composes the ring variables INTO its shadow, so `ring-1` no longer wipes the depth", () => {
    const decls = shadowOf(".surface");
    expect(decls).toHaveLength(1);
    const v = decls[0]!.value.replace(/\s+/g, " ");
    expect(v).toMatch(/^var\(--tw-ring-offset-shadow, 0 0 #0000\), var\(--tw-ring-shadow, 0 0 #0000\), var\(--shadow-milled\)$/);
    // `--tw-shadow` stays out: one elevation language, no shadow-* on top.
    expect(v).not.toContain("--tw-shadow)");
  });

  it("…and it lives in @layer utilities, after the generated ring utilities, so it wins the tie", () => {
    const decl = shadowOf(".surface")[0]!;
    expect(decl.stack[0]).toBe("@layer utilities");
    // The hover lift composes the ring the same way, or the hairline vanishes under the pointer.
    const lift = shadowOf(".surface-lift:hover");
    expect(lift).toHaveLength(1);
    expect(lift[0]!.stack[0]).toBe("@layer utilities");
    expect(lift[0]!.value).toContain("var(--tw-ring-shadow, 0 0 #0000)");
  });

  it(".panel is milled too: the same rim and two-stop shadow, never a flat slab", () => {
    expect(shadowOf(".panel")[0]!.value).toBe("var(--shadow-milled)");
    expect(shadowOf(".panel-link:hover")[0]!.value).toBe("var(--shadow-milled-lift)");
  });

  it("declares the KPI step with a written reason, and hero stays a separate step", () => {
    expect(valuesOf("--text-kpi")).toHaveLength(1);
    expect(CSS).toMatch(/--text-kpi[^;]*;/);
    expect(CSS).toMatch(/Why a seventh step/);
    expect(valuesOf("--text-hero")[0]!.value).toBe("3.25rem");
  });
});

describe("index.css — the small-alarm-TEXT rust stays readable and stays rust, never brown (owner, 2026-10-09)", () => {
  const hexOf = (prop: string) => {
    const v = valuesOf(prop).find((d) => d.stack[0] === "@theme")?.value ?? "";
    expect(v, `${prop} is a plain hex token`).toMatch(/^#[0-9a-f]{6}$/i);
    return v;
  };
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (h: string) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
  const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  /** OKLCH lightness, chroma, hue (Björn Ottosson's matrices). */
  const oklch = (h: string) => {
    const [r, g, b] = rgb(h).map(lin) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(A, B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
  };

  it("clears AA (4.5:1) on the panel top and foot and on the platinum ground, top and foot", () => {
    const ink = hexOf("--color-bad-ink");
    for (const ground of ["#ffffff", "#fbfcfe", "#f7f9fc", "#eef3fa"]) {
      expect(contrast(ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is the alarm family at MORE chroma, not a darkened (desaturated) orange: not brown", () => {
    const ink = oklch(hexOf("--color-bad-ink"));
    const bad = oklch(hexOf("--color-bad"));
    expect(ink.C, "chroma at least the alarm orange's").toBeGreaterThanOrEqual(bad.C);
    expect(Math.abs(ink.H - bad.H), "same hue family (within 8°)").toBeLessThanOrEqual(8);
    expect(ink.H, "never drifting toward brown/amber (hue ≤ 45°)").toBeLessThanOrEqual(45);
    expect(ink.L, "not a dark brown (OKLCH L ≥ 0.5)").toBeGreaterThanOrEqual(0.5);
  });

  it("the alarm fill colour is unchanged, and the chart mirror equals the CSS token", async () => {
    expect(hexOf("--color-bad").toLowerCase()).toBe("#e16d3e");
    const { CHART } = await import("./lib/chartTokens");
    expect(CHART.badInk.toLowerCase()).toBe(hexOf("--color-bad-ink").toLowerCase());
    expect(CHART.orangeDeep).toBe("#e16d3e");
  });
});

describe("index.css — a picked-up surface still lifts (review #8)", () => {
  const shadowOf = (sel: string) => valuesOf("box-shadow").filter((d) => d.stack[d.stack.length - 1] === sel);
  it("the raised step (and `.surface.shadow-lift`) compose the ring with the lift shadow, AFTER `.surface` in the same layer", () => {
    const base = shadowOf(".surface")[0]!;
    const raised = shadowOf(".surface-raised,\n  .surface.shadow-lift")[0] ?? shadowOf(".surface-raised, .surface.shadow-lift")[0];
    expect(raised, "the raised rule exists").toBeTruthy();
    expect(raised!.stack[0]).toBe("@layer utilities");
    expect(raised!.stack[0]).toBe(base.stack[0]);
    expect(raised!.at).toBeGreaterThan(base.at);
    const v = raised!.value.replace(/\s+/g, " ");
    expect(v).toBe("var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--shadow-milled-lift)");
  });
  it("the three drag sites use it", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = CSS_PATH!.replace(/index\.css$/, "");
    for (const f of ["pages/mapping-rules.tsx", "pages/forecast/InboxCardView.tsx", "pages/mapping-rules/SortableRuleRow.tsx"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, f).toContain("surface-raised");
    }
  });
});

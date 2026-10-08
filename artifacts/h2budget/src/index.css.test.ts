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
   * ⚠️ PIXEL PARITY. The three sticky heads used `-mx-4 -mt-4 px-4` and
   * `md:-mx-8 md:-mt-8 md:px-8` — 16 px and 32 px. Shell pad + the legacy
   * overshoot must add up to exactly those, at both sizes, or every page under
   * those heads moves (measured: the content below a head sits 4/12 px higher
   * because of the overshoot; see the note on `:root`).
   */
  it("pad + overshoot = the heads' old 16 px / 32 px bleed, so no pixel moves", () => {
    expect(px(at("--shell-pad-x", false)) + px(at("--page-head-overshoot", false))).toBe(16);
    expect(px(at("--shell-pad-y", false)) + px(at("--page-head-overshoot", false))).toBe(16);
    expect(px(at("--shell-pad-x", true)) + px(at("--page-head-overshoot", true))).toBe(32);
    expect(px(at("--shell-pad-y", true)) + px(at("--page-head-overshoot", true))).toBe(32);
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

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

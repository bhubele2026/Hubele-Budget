import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Cascade guards for `styles/index.css`, ported from the classic app's
 * `index.css.test.ts`. They assert STRUCTURE, because the bug they exist for
 * was invisible to every other check: a reduced-motion override that read
 * correctly, passed review, shipped, and did nothing, because it sat inside a
 * `@layer` and lost to the unlayered dials. jsdom implements neither `@layer`
 * nor custom-property resolution, so the invariant is pinned on the source.
 */
const CSS_PATH = [
  resolve(process.cwd(), "src/styles/index.css"),
  resolve(process.cwd(), "artifacts/h2/src/styles/index.css"),
].find(existsSync);
if (!CSS_PATH) throw new Error("index.css not found from cwd " + process.cwd());

/** Comments are stripped first: several of them quote the declarations below. */
const SRC = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Block = { header: string; start: number };

/** Every declaration of `prop`, with the stack of block headers around it. */
function declarationsOf(prop: string): { stack: string[]; start: number; value: string }[] {
  const out: { stack: string[]; start: number; value: string }[] = [];
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
          value: decl.slice(prop.length + 1).trim(),
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

const DIALS = { "--dur-fast": "120ms", "--dur-base": "220ms" } as const;

describe("index.css — the reduced-motion switch reaches both dials", () => {
  for (const [dial, value] of Object.entries(DIALS)) {
    describe(dial, () => {
      const decls = declarationsOf(dial);

      it("is declared exactly twice: the default and the reduce override", () => {
        expect(decls).toHaveLength(2);
      });

      it(`defaults to ${value} in a top-level :root, outside every @layer`, () => {
        const base = decls.find((d) => !inReduceMedia(d.stack))!;
        expect(base.stack).toEqual([":root"]);
        expect(isLayered(base.stack)).toBe(false);
        expect(base.value).toBe(value);
      });

      /** ⚠️ THE REGRESSION THIS FILE EXISTS FOR: unlayered beats layered outright. */
      it("is overridden UNLAYERED under prefers-reduced-motion: reduce, to 0ms", () => {
        const reduce = decls.find((d) => inReduceMedia(d.stack))!;
        expect(reduce).toBeDefined();
        expect(isLayered(reduce.stack)).toBe(false);
        expect(reduce.stack[reduce.stack.length - 1]).toBe(":root");
        expect(reduce.value).toBe("0ms");
      });

      it("puts the override AFTER the default, since a :root tie is settled by source order", () => {
        const base = decls.find((d) => !inReduceMedia(d.stack))!;
        const reduce = decls.find((d) => inReduceMedia(d.stack))!;
        expect(reduce.start).toBeGreaterThan(base.start);
      });
    });
  }

  it("every animation and transition in the sheet styles runs on a dial, never a literal", () => {
    const literal = SRC.match(/\b(animation|transition)\s*:[^;]*\b\d+(\.\d+)?m?s\b/g) ?? [];
    expect(literal).toEqual([]);
  });

  it("keeps the near-instant safety net, so a Radix overlay still gets animationend", () => {
    const kills = SRC.slice(SRC.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(kills).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(kills).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("declares a light-only colour scheme", () => {
    expect(SRC).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
  });
});

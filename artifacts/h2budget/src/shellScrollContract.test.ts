import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * (C0) The shell scroll contract, as the pages use it. The CSS half (the
 * variables, the classes and the pixel arithmetic) is pinned in
 * `index.css.test.ts`; this half pins that the shell and the three pages that
 * had hard-coded the shell's geometry now read it from there.
 */
const SRC = import.meta.dirname;
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("the shell publishes its scroller and padding", () => {
  const layout = read("components/layout.tsx");
  it("<main> is marked as THE scroller and reserves its gutter", () => {
    expect(layout).toMatch(/<main\s+data-shell-scroller=""\s+className="shell-scroller [^"]*overflow-y-auto/);
  });
  it("the content column pads with .shell-pad, not hard-coded p-3 md:p-5", () => {
    expect(layout).toMatch(/className="page-in shell-pad mx-auto max-w-\[1600px\]"/);
    expect(layout).not.toMatch(/className="[^"]*p-3 md:p-5/);
  });
});

describe("the page sticky heads read the shell's geometry", () => {
  // (C9) Chase no longer has a page-wide sticky head: its pinned pane is the
  // ledger panel's (below).
  for (const page of ["pages/forecast.tsx", "pages/amex.tsx"]) {
    const src = read(page);
    it(`${page}: the head is .page-sticky-head, with no hard-coded bleed left`, () => {
      expect(src).toMatch(/"page-sticky-head sticky top-0 z-30 /);
      for (const literal of ["md:-mx-8", "md:-mt-8", "-mt-4", "md:px-8"]) {
        expect(src, `${page} still has ${literal}`).not.toContain(literal);
      }
    });
    it(`${page}: publishes the head's height as --page-sticky-top`, () => {
      expect(src).toContain('["--page-sticky-top" as string]');
    });
  }

  it("forecast: the pinned inbox sits under the head via the variable and bleeds like it", () => {
    const src = read("pages/forecast.tsx");
    expect(src).toContain('{ top: "var(--page-sticky-top, 0px)" }');
    expect(src).toMatch(/"page-bleed-x sticky z-20 /);
    expect(src).not.toMatch(/-mx-4 md:-mx-8/);
  });

  it("Chase (C9): the pinned pane is the ledger panel's, sticky at the top of <main>, its height published as --page-sticky-top", () => {
    const page = read("pages/transactions.tsx");
    const panel = read("components/account-page/ledger-panel.tsx");
    // The page measures the ledger pane and publishes it; nothing hard-codes the shell's bleed.
    expect(page).toContain('["--page-sticky-top" as string]');
    expect(page).toMatch(/usePaneHeight\(paneRef/);
    expect(page).toMatch(/<LedgerPanel[\s\S]*paneRef=\{paneRef\}/);
    expect(page).not.toContain("page-sticky-head");
    for (const literal of ["md:-mx-8", "md:-mt-8", "-mt-4", "md:px-8", "-mx-4"]) {
      expect(page, `transactions.tsx still has ${literal}`).not.toContain(literal);
    }
    // The pane sticks at the top of the scroller, inside a panel that is not a scroll container.
    expect(panel).toMatch(/className="sticky top-0 z-30 /);
    expect(panel).toMatch(/variant=\{\["sticky-safe", "flush", "static"\]\}/);
  });

  it("Chase and Amex: bulk bars and day headers pin under the head via the variable", () => {
    for (const page of ["pages/transactions.tsx", "pages/amex.tsx", "components/account-page/day-group.tsx"]) {
      expect(read(page), page).toContain('top: "var(--page-sticky-top, 0px)"');
    }
  });

  it("the old per-page variable is gone everywhere", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css)$/.test(name) && !name.endsWith(".test.ts") && read(p.slice(SRC.length + 1)).includes("--pinned-pane-h")) hits.push(p);
      }
    };
    walk(SRC);
    expect(hits).toEqual([]);
  });
});

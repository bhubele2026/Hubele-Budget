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
  // (C9, C10) Chase and Amex no longer have a page-wide sticky head: their
  // pinned pane is the ledger panel's (below). (C13) The forecast screen's
  // sticky head lives in its layout, `ForecastBody` (/forecast, /review,
  // /next/forecast).
  for (const page of ["pages/forecast/ForecastBody.tsx"]) {
    const src = read(page);
    it(`${page}: the head is .page-sticky-head, with no hard-coded bleed left`, () => {
      expect(src).toMatch(/"page-sticky-head sticky top-0 z-30 /);
      for (const literal of ["md:-mx-8", "md:-mt-8", "-mt-4", "md:px-8"]) {
        expect(src, `${page} still has ${literal}`).not.toContain(literal);
      }
    });
    it(`${page}: publishes the head's height as --page-sticky-top`, () => {
      expect(src).toContain('["--page-sticky-top" as string]');
      expect(src).toMatch(/usePaneHeight\(headRef/);
    });
  }

  it("forecast (C13): the pinned inbox sits under the head via the variable, spanning the sticky-safe register panel", () => {
    const src = read("pages/forecast.tsx");
    expect(src).toContain('{ top: "var(--page-sticky-top, 0px)" }');
    // It bleeds over the register panel's own p-4, not the shell's padding.
    expect(src).toMatch(/"-mx-4 px-4 sticky z-20 /);
    expect(src).not.toMatch(/-mx-4 md:-mx-8/);
    expect(src).not.toContain("page-bleed-x");
    // The register panel is sticky-safe, so the inbox sticks to <main>.
    expect(read("pages/forecast/ForecastBody.tsx")).toMatch(
      /variant=\{\["sticky-safe", "static"\]\}[\s\S]*data-testid="register-panel"/,
    );
  });

  it.each([
    ["pages/transactions.tsx", "C9"],
    ["pages/amex.tsx", "C10"],
  ])("%s (%s): the pinned pane is the ledger panel's, sticky at the top of <main>, its height published as --page-sticky-top", (file) => {
    const page = read(file);
    const panel = read("components/account-page/ledger-panel.tsx");
    // The page measures the ledger pane and publishes it; nothing hard-codes the shell's bleed.
    expect(page).toContain('["--page-sticky-top" as string]');
    expect(page).toMatch(/usePaneHeight\(paneRef/);
    expect(page).toMatch(/<LedgerPanel[\s\S]*paneRef=\{paneRef\}/);
    expect(page).not.toContain("page-sticky-head");
    for (const literal of ["md:-mx-8", "md:-mt-8", "-mt-4", "md:px-8", "-mx-4"]) {
      expect(page, `${file} still has ${literal}`).not.toContain(literal);
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

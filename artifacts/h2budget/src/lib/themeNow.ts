// The theme in force RIGHT NOW, for code that colours in JS (`lib/chartTokens.ts`).
// Set by `lib/theme.ts` whenever it paints. Pure on purpose: no React, no window,
// nothing at load, so `chartTokens.ts` stays dependency-free and a Node test that
// imports it reads light.
let dark = false;

// (perf phase 2) WHETHER ANYTHING HAS DRAWN WITH A JS COLOUR. Every read of the
// theme through `isDarkNow()` (the chart tables, `washOf`) notes it. While nothing
// has, the page's colours are all CSS tokens, which follow `<html data-theme>` by
// themselves, so a theme change needs no re-mount (`ThemeRepaint` in App.tsx).
// Building a `themed()` table at module load is not a draw: it runs `quietly`.
let inkRead = false;
let quiet = 0;

export const isDarkNow = (): boolean => {
  if (quiet === 0) inkRead = true;
  return dark;
};

export function setDarkNow(v: boolean): void {
  dark = v;
}

/** Run `fn` without it counting as a draw (a table built at module load). */
export function quietly<T>(fn: () => T): T {
  quiet += 1;
  try {
    return fn();
  } finally {
    quiet -= 1;
  }
}

/** True once something has read a theme colour in JS since the last `resetInkRead()`. */
export const inkWasRead = (): boolean => inkRead;
export function resetInkRead(): void {
  inkRead = false;
}

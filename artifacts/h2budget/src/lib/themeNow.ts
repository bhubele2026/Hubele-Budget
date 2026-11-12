// The theme in force RIGHT NOW, for code that colours in JS (`lib/chartTokens.ts`).
// Set by `lib/theme.ts` whenever it paints. Pure on purpose: no React, no window,
// nothing at load, so `chartTokens.ts` stays dependency-free and a Node test that
// imports it reads light.
let dark = false;

export const isDarkNow = (): boolean => dark;

export function setDarkNow(v: boolean): void {
  dark = v;
}

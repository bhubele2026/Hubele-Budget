// Global vitest setup (jsdom). Polyfills browser APIs jsdom doesn't provide
// so components that call them at render time don't crash under test.
//
// matchMedia: jsdom has no window.matchMedia, so any component (chart libs,
// responsive hooks) that calls it unguarded throws "matchMedia is not a
// function". We return matches:true for prefers-reduced-motion so animations
// (e.g. useCountUp) deterministically jump to their final value in tests
// instead of waiting on a requestAnimationFrame tick that never runs.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

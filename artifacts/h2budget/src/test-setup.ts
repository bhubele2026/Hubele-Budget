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

// ResizeObserver: jsdom does not implement it at all. The tab ribbon watches
// its own strip with one (a window resize listener alone measures a nav that
// was still full width and concludes "everything fits"), so without this any
// test that mounts the app shell dies on `new ResizeObserver`. The stub never
// fires — jsdom has no layout, so every element measures 0 and there is
// nothing real to observe; what the tests assert is the no-overflow branch.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Scrolling: jsdom implements no layout, so these are absent rather than
// no-ops, and calling one throws. The ribbon brings its active tab into view
// on every area change and scrolls by a page from the edge chevrons.
if (typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollBy) Element.prototype.scrollBy = () => {};
}

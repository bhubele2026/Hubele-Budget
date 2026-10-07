// Global vitest setup (jsdom). Polyfills for browser APIs jsdom lacks, so a
// component that calls one at render time does not crash under test. Ported
// from the classic app's test-setup.

// matchMedia: absent in jsdom. `matches: true` for every query, which also
// means "prefers reduced motion" — nothing waits on an animation in a test.
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

// ResizeObserver: not implemented by jsdom at all (Radix measures with it).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Scrolling: jsdom has no layout, so these are absent and calling one throws.
if (typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollBy) Element.prototype.scrollBy = () => {};
}

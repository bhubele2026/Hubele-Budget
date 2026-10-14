import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// wouter patches history.pushState/replaceState to fire events (as in the app); this listens to them.
import "wouter";
import { installScrollRestoration, RESTORE_GIVE_UP_MS } from "./scrollRestore";

/**
 * (W1) Scroll restoration for the shell's one scroller: a fresh push starts at
 * the top, Back/Forward returns to the saved offset once the page is tall
 * enough, and the person's own scrolling is never fought.
 *
 * jsdom has no layout, so the scroller's height is a number the test owns, and
 * animation frames are driven by fake timers.
 */
let scroller: HTMLElement;
let height = 0; // scrollHeight
let uninstall: () => void;

function setScrollerGeometry() {
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 600 });
}
/** The person scrolls: the offset moves, the scroll event fires. */
function userScrollTo(top: number) {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event("scroll"));
}
/** Click a link: the address changes by pushState (wouter fires `pushState`). */
function push(url: string) {
  window.history.pushState(null, "", url);
}
/** The Back button: the address changes, then popstate. */
function back(url: string) {
  window.history.replaceState(null, "", url); // (jsdom: no real traversal)
  window.dispatchEvent(new PopStateEvent("popstate"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"] });
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/transactions?month=2026-09-01");
  scroller = document.createElement("main");
  scroller.setAttribute("data-shell-scroller", "");
  document.body.appendChild(scroller);
  height = 5000;
  setScrollerGeometry();
  uninstall = installScrollRestoration(() => scroller);
});
afterEach(() => {
  uninstall();
  scroller.remove();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("scroll restoration", () => {
  it("a fresh push starts at the top", () => {
    userScrollTo(1200);
    push("/amex");
    expect(scroller.scrollTop).toBe(0);
  });

  it("push then Back restores the saved offset for that URL", () => {
    userScrollTo(1200);
    push("/amex");
    userScrollTo(300);
    back("/transactions?month=2026-09-01");
    vi.advanceTimersByTime(50);
    expect(scroller.scrollTop).toBe(1200);
  });

  it("Forward restores the other page's offset too", () => {
    userScrollTo(1200);
    push("/amex");
    userScrollTo(300);
    back("/transactions?month=2026-09-01");
    vi.advanceTimersByTime(300);
    push("/amex"); // (a new push to a URL seen before still starts at 0)
    expect(scroller.scrollTop).toBe(0);
    back("/transactions?month=2026-09-01");
    vi.advanceTimersByTime(50);
    expect(scroller.scrollTop).toBe(1200);
  });

  it("waits for the page's data: restores once the scroller is tall enough", () => {
    userScrollTo(1200);
    push("/amex");
    height = 400; // the skeleton
    back("/transactions?month=2026-09-01");
    vi.advanceTimersByTime(300);
    expect(scroller.scrollTop).toBe(0);
    height = 5000; // the data landed
    vi.advanceTimersByTime(100);
    expect(scroller.scrollTop).toBe(1200);
  });

  it("gives up after about 1.5 s when the page never gets tall enough", () => {
    userScrollTo(1200);
    push("/amex");
    height = 400;
    back("/transactions?month=2026-09-01");
    vi.advanceTimersByTime(RESTORE_GIVE_UP_MS + 200);
    height = 5000;
    vi.advanceTimersByTime(300);
    expect(scroller.scrollTop).toBe(0);
  });

  it("never fights the person: touching the page cancels the restore", () => {
    userScrollTo(1200);
    push("/amex");
    height = 400;
    back("/transactions?month=2026-09-01");
    vi.advanceTimersByTime(100);
    scroller.dispatchEvent(new Event("wheel"));
    height = 5000;
    vi.advanceTimersByTime(300);
    expect(scroller.scrollTop).toBe(0);
  });

  it("a replaceState (month change, ?tx stripped) keeps the offset and re-keys the page", () => {
    userScrollTo(900);
    window.history.replaceState(null, "", "/transactions?month=2026-08-01");
    expect(scroller.scrollTop).toBe(900);
    push("/amex");
    back("/transactions?month=2026-08-01");
    vi.advanceTimersByTime(50);
    expect(scroller.scrollTop).toBe(900);
  });

  it("keeps offsets in sessionStorage per URL (path + search)", () => {
    userScrollTo(700);
    push("/amex?card=ext-blue");
    const store = JSON.parse(window.sessionStorage.getItem("h2budget:scroll-by-url")!);
    expect(store).toEqual({ "/transactions?month=2026-09-01": 700 });
  });

  it("a page left at the top saves nothing, and Back to it does not move", () => {
    push("/amex");
    userScrollTo(500);
    back("/transactions?month=2026-09-01");
    vi.advanceTimersByTime(50);
    expect(scroller.scrollTop).toBe(0);
  });

  it("survives storage that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      userScrollTo(300);
      expect(() => push("/amex")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

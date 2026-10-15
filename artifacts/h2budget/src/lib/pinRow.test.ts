import { describe, it, expect, vi, afterEach } from "vitest";
import { pinRowInView, stickyClearance } from "./pinRow";

/** (Q6b) A row we scrolled to is held where it landed while the page settles; the person's own scroll wins. */
describe("pinRowInView", () => {
  let frames: Array<() => void> = [];
  const flush = () => { const f = frames; frames = []; f.forEach((cb) => cb()); };
  afterEach(() => { vi.unstubAllGlobals(); frames = []; });

  function setup(tops: number[]) {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return 0; });
    let i = 0;
    const el = { getBoundingClientRect: () => ({ top: tops[Math.min(i, tops.length - 1)]! }), scrollIntoView: vi.fn(() => { tops.push(tops[0]!); i = tops.length - 1; }) } as unknown as HTMLElement;
    return { el, next: () => { i++; } };
  }

  it("scrolls it back when content above moved it, and leaves a steady row alone", () => {
    const { el, next } = setup([120, 120, 440]);
    const cancel = pinRowInView(() => el);
    flush(); // records 120
    flush(); // 120 (i still 0)
    expect((el.scrollIntoView as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    next(); next(); // page moved the row to 440
    flush();
    expect((el.scrollIntoView as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("stops at the person's first wheel / key", () => {
    const { el, next } = setup([120, 440]);
    pinRowInView(() => el);
    flush();
    window.dispatchEvent(new Event("wheel"));
    next();
    flush();
    expect((el.scrollIntoView as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("(Q6b) held against the LIVE bottom of the sticky stack", () => {
  let frames: Array<() => void> = [];
  const flush = () => { const f = frames; frames = []; f.forEach((cb) => cb()); };
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); frames = []; });

  it("moves the row to the clearance as the pane's height changes, not to where it first landed", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return 0; });
    const by = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    let clearance = 100; // first landing under a stale pane height
    const row = { getBoundingClientRect: () => ({ top: 100 }) } as unknown as HTMLElement;
    const cancel = pinRowInView(() => row, { clearance: () => clearance });
    flush();
    expect(by).not.toHaveBeenCalled(); // on the line
    clearance = 160; // the pane grew: the line moved down
    flush();
    expect(by).toHaveBeenCalledWith(0, -60);
    cancel();
  });

  it("stickyClearance = scroll port top + pane + the row's own day head + gap", () => {
    document.body.innerHTML = `<div id="g" data-day-group="d"><div data-testid="day-head-d"></div><div id="r"></div></div><div id="pane"></div>`;
    const pane = document.getElementById("pane")!;
    Object.defineProperty(pane, "offsetHeight", { configurable: true, value: 64 });
    Object.defineProperty(document.querySelector('[data-testid="day-head-d"]')!, "offsetHeight", { configurable: true, value: 36 });
    expect(stickyClearance(document.getElementById("r")!, pane)).toBe(64 + 36 + 8);
    expect(stickyClearance(document.getElementById("r")!, null)).toBeNull();
    document.body.innerHTML = "";
  });
});

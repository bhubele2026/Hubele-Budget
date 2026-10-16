import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterScrollSettles } from "./afterScrollSettles";

let tops: number[];
let now: number;
let frames: Array<() => void>;
const el = { getBoundingClientRect: () => ({ top: tops.length > 1 ? tops.shift()! : tops[0]! }) } as unknown as Element;
const step = (ms = 16) => { now += ms; const f = frames.splice(0); f.forEach((fn) => fn()); };

beforeEach(() => {
  now = 0; frames = []; tops = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.push(fn); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("afterScrollSettles", () => {
  it("waits while the row is still moving, then calls done once its top holds", () => {
    tops = [900, 600, 300, 120, 100, 100, 100, 100, 100, 100, 100, 100];
    const done = vi.fn();
    afterScrollSettles(el, done);
    for (let i = 0; i < 5; i++) step();
    expect(done).not.toHaveBeenCalled();
    for (let i = 0; i < 12; i++) step();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it("gives up after maxMs on a row that never stops", () => {
    let t = 0;
    const moving = { getBoundingClientRect: () => ({ top: (t += 7) }) } as unknown as Element;
    const done = vi.fn();
    afterScrollSettles(moving, done, { maxMs: 100 });
    for (let i = 0; i < 20; i++) step(16);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it("cancel stops it", () => {
    tops = [5];
    const done = vi.fn();
    const cancel = afterScrollSettles(el, done);
    cancel();
    for (let i = 0; i < 20; i++) step();
    expect(done).not.toHaveBeenCalled();
  });
});

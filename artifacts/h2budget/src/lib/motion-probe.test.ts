import { describe, expect, it } from "vitest";
import { decide, fromUrl, judgeArrival, readStored, RECHECK_DAYS } from "./motion-probe";

/** Frame timestamps from a list of gaps (ms). */
const frames = (gaps: number[]): number[] => {
  const out = [0];
  for (const g of gaps) out.push(out[out.length - 1]! + g);
  return out;
};
const steady = (gap: number, n = 90) => Array.from({ length: n }, () => gap);

describe("judgeArrival — was this computer keeping up while a board arrived?", () => {
  it("calls a 60Hz arrival fast, and a 120Hz one", () => {
    expect(judgeArrival(frames(steady(16.7)))).toBe("fast");
    expect(judgeArrival(frames(steady(8.3, 180)))).toBe("fast");
  });

  it("forgives the board's own first paint — long on every machine", () => {
    expect(judgeArrival(frames([180, 120, ...steady(16.7)]))).toBe("fast");
  });

  it("forgives a hitch or two", () => {
    const gaps = steady(16.7);
    gaps[30] = 90;
    gaps[60] = 45;
    expect(judgeArrival(frames(gaps))).toBe("fast");
  });

  it("calls it slow when a quarter of the frames miss twice over", () => {
    const gaps = steady(16.7, 60).map((g, i) => (i % 4 === 3 ? 50 : g));
    expect(judgeArrival(frames(gaps))).toBe("slow");
  });

  it("calls it slow when even its quickest frames are under 25 a second", () => {
    expect(judgeArrival(frames(steady(45, 34)))).toBe("slow");
  });

  // ⚠️⚠️ Review, 2026-09-30: the first cut called this "slow" — Chrome's Energy Saver, Safari's
  // Low Power Mode, a 30Hz screen or a remote desktop would have put a smooth laptop on lite.
  it("calls a steady 30 frames a second smooth — a cap is not a stutter", () => {
    expect(judgeArrival(frames(steady(33.3, 45)))).toBe("fast");
    expect(judgeArrival(frames(steady(33.3, 45).map((g, i) => (i % 2 ? g + 1.5 : g - 1.5))))).toBe("fast");
  });

  it("but a 30-capped browser that keeps missing ITS beat is slow", () => {
    expect(judgeArrival(frames(steady(33.3, 44).map((g, i) => (i % 4 === 3 ? 66.7 : g))))).toBe("slow");
  });

  it("calls a 120Hz screen drawing at 60 under load fine", () => {
    expect(judgeArrival(frames(steady(8.3, 120).map((g, i) => (i % 2 ? 16.7 : g))))).toBe("fast");
  });

  it("calls one freeze everyone would see slow", () => {
    expect(judgeArrival(frames([...steady(16.7, 40), 700, ...steady(16.7, 40)]))).toBe("slow");
  });

  // ⭐ 2026-11-12: these are CLEARLY slow — one such arrival switches the browser on its own.
  it("calls a handful of frames in the whole sample very slow — that IS the slow computer", () => {
    // Measured at 20× CPU on Transportation: 12 frames, 113ms apart.
    expect(judgeArrival(frames(steady(113, 12)))).toBe("very-slow");
    // …and a one-second stall mid-arrival counts too.
    expect(judgeArrival(frames([...steady(20, 10), 1200, ...steady(20, 5)]))).toBe("very-slow");
  });

  it("calls half the frames missing a beat very slow, and a quarter merely slow", () => {
    expect(judgeArrival(frames(steady(16.7, 60).map((g, i) => (i % 2 ? 50 : g))))).toBe("very-slow");
    expect(judgeArrival(frames(steady(16.7, 60).map((g, i) => (i % 4 === 3 ? 50 : g))))).toBe("slow");
  });

  it("keeps the quick end under 20 a second as the line — 45ms frames are slow, 55ms very slow", () => {
    expect(judgeArrival(frames(steady(45, 34)))).toBe("slow");
    expect(judgeArrival(frames(steady(55, 28)))).toBe("very-slow");
  });

  it("says nothing about a sleeping laptop or an empty sample", () => {
    expect(judgeArrival(frames([...steady(16.7, 40), 3500, ...steady(16.7, 40)]))).toBe("unknown");
    expect(judgeArrival(frames([20, 20]))).toBe("unknown");
    expect(judgeArrival([])).toBe("unknown");
  });
});

describe("decide — one hitch never flips a fast machine", () => {
  it("switches after two slow arrivals", () => {
    expect(decide(["slow"])).toBeNull();
    expect(decide(["slow", "slow"])).toBe("lite");
    expect(decide(["slow", "fast", "slow"])).toBe("lite");
  });

  it("settles on the full motion after two fast ones", () => {
    expect(decide(["fast", "fast"])).toBe("full");
    expect(decide(["slow", "fast", "fast"])).toBe("full");
  });

  it("switches on the FIRST clearly slow arrival (2026-11-12)", () => {
    expect(decide(["very-slow"])).toBe("lite");
    expect(decide(["fast", "very-slow"])).toBe("lite");
  });

  it("counts an unknown for nothing", () => {
    expect(decide(["unknown", "unknown", "slow"])).toBeNull();
    expect(decide(["unknown", "slow", "unknown", "slow"])).toBe("lite");
  });
});

describe("readStored — remembered per browser, measured again after a month", () => {
  const at = "2026-09-30";
  const raw = (v: unknown) => JSON.stringify(v);

  it("keeps a lite that is younger than the recheck", () => {
    expect(readStored(raw({ mode: "lite", at, by: "measured" }), "2026-10-15")).toEqual({ mode: "lite", at, by: "measured" });
  });

  it(`forgets it after ${RECHECK_DAYS} days`, () => {
    expect(readStored(raw({ mode: "lite", at, by: "measured" }), "2026-10-30")).toBeNull();
  });

  it("keeps a hand-set mode the same way", () => {
    expect(readStored(raw({ mode: "full", at, by: "hand" }), at)).toEqual({ mode: "full", at, by: "hand" });
  });

  it("ignores anything it can't read, and a date from the future", () => {
    expect(readStored(null, at)).toBeNull();
    expect(readStored("not json", at)).toBeNull();
    expect(readStored(raw({ mode: "slow", at }), at)).toBeNull();
    expect(readStored(raw({ mode: "lite", at: "yesterday" }), at)).toBeNull();
    expect(readStored(raw({ mode: "lite", at: "2026-12-01" }), at)).toBeNull();
  });
});

describe("fromUrl — the link can set it (testing and support, no switch on screen)", () => {
  it("reads lite, full and auto, and nothing else", () => {
    expect(fromUrl("?motion=lite")).toBe("lite");
    expect(fromUrl("?x=1&motion=full")).toBe("full");
    expect(fromUrl("?motion=auto")).toBe("auto");
    expect(fromUrl("?motion=fast")).toBeNull();
    expect(fromUrl("")).toBeNull();
  });
});

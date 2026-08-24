import { describe, it, expect } from "vitest";
import {
  CAT8,
  CHART,
  NAVY_RAMP,
  OTHER_GREY,
  REVEAL_MS,
  MORPH_MS,
  SPEED,
  animBegin,
  barColorForSign,
  barWidthPct,
  catColor,
  compactUSD,
  niceAxis,
  rampByRank,
} from "./chartTokens";

// The chart kit's pure half. These helpers decide what every chart in the app
// looks like, so they are pinned here rather than eyeballed on a page.

describe("niceAxis — rounded ticks with headroom", () => {
  it("rounds the ceiling up to a whole step instead of pinning it to the data max", () => {
    // The bug this exists for: recharts pins the plot ceiling to the data max
    // (340), so the tallest bar's own value label draws outside the svg and is
    // sliced in half — and the auto ticks read 0/85/170/255/340.
    const { domain, ticks } = niceAxis(0, 340);
    expect(domain).toEqual([0, 400]);
    expect(ticks).toEqual([0, 100, 200, 300, 400]);
  });

  it("leaves at least 8% headroom above the tallest point, at every magnitude", () => {
    const maxes = [1, 7, 42, 99, 100, 340, 999, 1234, 25_000, 987_654, 1_250_000];
    for (const max of maxes) {
      const { domain } = niceAxis(0, max);
      expect(domain[1]).toBeGreaterThanOrEqual(max * 1.08);
    }
  });

  it("produces ticks that start at the domain floor and reach the ceiling", () => {
    for (const max of [50, 340, 9_999, 250_000]) {
      const { domain, ticks } = niceAxis(0, max);
      expect(ticks[0]).toBe(domain[0]);
      expect(ticks[ticks.length - 1]).toBe(domain[1]);
    }
  });

  it("uses an evenly-spaced step", () => {
    const { ticks } = niceAxis(0, 1234);
    const steps = ticks.slice(1).map((t, i) => t - ticks[i]!);
    for (const s of steps) expect(s).toBeCloseTo(steps[0]!, 6);
  });

  it("extends below zero for negative data and still crosses zero", () => {
    const { domain, ticks } = niceAxis(-50, 100);
    expect(domain[0]).toBeLessThanOrEqual(-50 * 1.08);
    expect(domain[1]).toBeGreaterThanOrEqual(100 * 1.08);
    expect(ticks).toContain(0);
  });

  it("never returns a degenerate axis for empty or all-zero data", () => {
    expect(niceAxis(0, 0)).toEqual({ domain: [0, 1], ticks: [0, 1] });
    expect(niceAxis(Infinity, Infinity)).toEqual({ domain: [0, 1], ticks: [0, 1] });
  });

  it("anchors the floor at zero for all-positive data", () => {
    expect(niceAxis(20, 90).domain[0]).toBe(0);
  });
});

describe("NAVY_RAMP — sequential, indexed by RANK", () => {
  it("is a six-stop ramp running light to navy", () => {
    expect(NAVY_RAMP).toHaveLength(6);
    expect(NAVY_RAMP[0]).toBe("#e1e8f0");
    expect(NAVY_RAMP[NAVY_RAMP.length - 1]).toBe(CHART.navy);
  });

  it("gives rank 0 — the largest item — the darkest navy", () => {
    for (const total of [1, 2, 3, 6, 12, 40]) {
      expect(rampByRank(0, total)).toBe(CHART.navy);
    }
  });

  it("walks toward the light end as rank grows, never backwards", () => {
    const total = 6;
    const idx = Array.from({ length: total }, (_, r) =>
      NAVY_RAMP.indexOf(rampByRank(r, total)),
    );
    expect(idx).toEqual([5, 4, 3, 2, 1, 0]);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]!).toBeLessThanOrEqual(idx[i - 1]!);
    }
  });

  it("spreads a short list across the whole ramp rather than bunching one end", () => {
    // Three near-identical navies would make a 3-row list unreadable.
    const three = [0, 1, 2].map((r) => rampByRank(r, 3));
    expect(new Set(three).size).toBe(3);
  });

  it("stays in range for a long list", () => {
    for (let r = 0; r < 40; r++) {
      expect(NAVY_RAMP).toContain(rampByRank(r, 40));
    }
  });

  it("clamps out-of-range and non-finite ranks instead of returning undefined", () => {
    expect(NAVY_RAMP).toContain(rampByRank(-3, 10));
    expect(NAVY_RAMP).toContain(rampByRank(99, 10));
    expect(NAVY_RAMP).toContain(rampByRank(Number.NaN, 10));
    expect(rampByRank(0, 0)).toBe(CHART.navy);
  });
});

describe("CAT8 — categorical, capped at 8 plus Other", () => {
  it("has exactly 8 distinct hues", () => {
    expect(CAT8).toHaveLength(8);
    expect(new Set(CAT8).size).toBe(8);
  });

  it("assigns in order and rolls everything past the 8th into Other", () => {
    expect(catColor(0)).toBe(CAT8[0]);
    expect(catColor(7)).toBe(CAT8[7]);
    expect(catColor(8)).toBe(OTHER_GREY);
    expect(catColor(99)).toBe(OTHER_GREY);
    expect(catColor(-1)).toBe(OTHER_GREY);
  });
});

describe("palette — no aliases, no collisions", () => {
  it("has no two token names pointing at the same hex", () => {
    // Aliases are how two series read as two colours while drawing one pixel.
    const hexes = Object.values(CHART);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  /**
   * ⚠️ REGRESSION GUARD FOR A REAL KIT BUG (fixed in D1).
   *
   * `OTHER_GREY` was #8fa3bf — byte-identical to `CAT8[4]` and to `CHART.mist`.
   * Any chart following the kit's own documented shape (cap at 8, roll the tail
   * into "Other") therefore drew slice 4 and the Other slice in ONE colour the
   * moment a fifth category existed. The old assertions never caught it because
   * they only checked `CHART` against itself.
   */
  it("never lets the Other rollup wear a categorical identity's colour", () => {
    expect(CAT8).not.toContain(OTHER_GREY);
    for (const hex of CAT8) expect(hex).not.toBe(OTHER_GREY);
  });

  it("draws nine distinct marks for a capped-at-8 chart plus Other", () => {
    // The exact shape law 3 prescribes — this is what used to collide.
    const ninePie = [...Array.from({ length: 8 }, (_, i) => catColor(i)), OTHER_GREY];
    expect(new Set(ninePie).size).toBe(9);
  });

  it("keeps Other out of the sequential ramp and the named series too", () => {
    // A rollup that equals a NAVY_RAMP stop collides on any page that draws a
    // ranked list beside a categorical one; equalling a CHART token is the
    // alias law 5 forbids.
    expect(NAVY_RAMP).not.toContain(OTHER_GREY);
    expect(Object.values(CHART)).not.toContain(OTHER_GREY);
  });

  it("has no duplicate hex anywhere across CAT8 + OTHER_GREY", () => {
    const all = [...CAT8, OTHER_GREY];
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps good and bad visually opposite", () => {
    expect(CHART.navy).toBe("#19315b");
    expect(CHART.orangeDeep).toBe("#e16d3e");
  });
});

describe("motion presets", () => {
  it("derives every duration from the one SPEED dial", () => {
    expect(SPEED).toBe(2.2);
    expect(REVEAL_MS).toBe(Math.round(700 * SPEED));
    expect(MORPH_MS).toBe(Math.round(600 * SPEED));
  });

  it("staggers mapped series so they cascade rather than start together", () => {
    expect(animBegin(0)).toBe(140);
    expect(animBegin(1)).toBe(220);
    expect(animBegin(3)).toBe(380);
    expect(animBegin()).toBe(140);
  });
});

describe("compactUSD — short money for axis ticks", () => {
  it("shortens thousands and millions", () => {
    expect(compactUSD(0)).toBe("$0");
    expect(compactUSD(950)).toBe("$950");
    expect(compactUSD(1_200)).toBe("$1.2K");
    expect(compactUSD(25_000)).toBe("$25K");
    expect(compactUSD(1_250_000)).toBe("$1.3M");
  });

  it("signs negatives and survives junk", () => {
    expect(compactUSD(-1_200)).toBe("-$1.2K");
    expect(compactUSD(Number.NaN)).toBe("$0");
  });
});

describe("CssBars geometry — value to width, sign to colour", () => {
  it("scales width as a percentage of the largest magnitude", () => {
    expect(barWidthPct(50, 100)).toBe(50);
    expect(barWidthPct(100, 100)).toBe(100);
    expect(barWidthPct(0, 100)).toBe(0);
  });

  it("measures negatives by magnitude, so a -80 bar is as long as an +80 bar", () => {
    expect(barWidthPct(-80, 100)).toBe(80);
    expect(barWidthPct(-80, 100)).toBe(barWidthPct(80, 100));
  });

  it("clamps to the track, so a stale max can never overflow a bar", () => {
    expect(barWidthPct(250, 100)).toBe(100);
  });

  it("returns zero width rather than NaN when there is nothing to scale against", () => {
    expect(barWidthPct(5, 0)).toBe(0);
    expect(barWidthPct(Number.NaN, 100)).toBe(0);
    expect(barWidthPct(5, Number.NaN)).toBe(0);
  });

  it("colours by sign: navy up, deep orange down, mist flat", () => {
    expect(barColorForSign(12)).toBe(CHART.navy);
    expect(barColorForSign(-12)).toBe(CHART.orangeDeep);
    expect(barColorForSign(0)).toBe(CHART.mist);
    expect(barColorForSign(Number.NaN)).toBe(CHART.mist);
  });
});

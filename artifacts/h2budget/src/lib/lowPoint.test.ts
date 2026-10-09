import { describe, it, expect } from "vitest";
import { lowPointView } from "./lowPoint";

// (dash-accuracy) The low point from `spine.forecast`. The server's verdict
// (cashSignal.ts): no_data = no balance; ready = low >= buffer + 200;
// tight = buffer <= low < buffer + 200; not_yet = low < buffer.
const f = (o: Record<string, unknown> = {}) => ({
  lowPoint: "350.00", lowPointDate: "2026-10-20", status: "not_yet", cashBuffer: "500.00", ...o,
});

describe("lowPointView", () => {
  it("not_yet is BELOW the buffer, with the value and the date (never blank)", () => {
    expect(lowPointView(f(), { buffer: "500.00" })).toEqual({
      kind: "below", value: 350, date: "2026-10-20", words: "below your $500 buffer", tone: "neutral", stale: false,
    });
  });
  it("a negative low point carries the bad tone", () => {
    const v = lowPointView(f({ lowPoint: "-120.55" }), { buffer: 500 });
    expect(v).toMatchObject({ kind: "below", value: -120.55, tone: "bad" });
  });
  it("tight is just above the buffer; ready is above it", () => {
    expect(lowPointView(f({ lowPoint: "620.00", status: "tight" }), { buffer: "500" })).toMatchObject({
      kind: "tight", value: 620, words: "just above your $500 buffer", tone: "neutral",
    });
    expect(lowPointView(f({ lowPoint: "2400.10", status: "ready" }), { buffer: "500" })).toMatchObject({
      kind: "ok", value: 2400.1, words: "above your $500 buffer",
    });
  });
  it("no_data is the only `none`: no value, no date, no $0", () => {
    const v = lowPointView(f({ lowPoint: "0.00", lowPointDate: null, status: "no_data" }), { buffer: "500" });
    expect(v).toEqual({ kind: "none", value: null, date: null, words: "No bank balance yet, so no forecast", tone: "neutral", stale: false });
    expect(lowPointView(null).kind).toBe("none");
    expect(lowPointView(f({ lowPoint: null })).kind).toBe("none");
  });
  it("a stale bank keeps the figure and says it in words", () => {
    const v = lowPointView(f(), { buffer: "500", stale: true });
    expect(v).toMatchObject({ kind: "below", value: 350, date: "2026-10-20", stale: true });
    expect(v.words).toBe("below your $500 buffer, from an out-of-date bank balance");
  });
  it("buffer: from opts, else the forecast's own; cents kept when not whole; 'your buffer' when missing", () => {
    expect(lowPointView(f({ cashBuffer: "750.00" })).words).toBe("below your $750 buffer");
    expect(lowPointView(f(), { buffer: "512.50" }).words).toBe("below your $512.50 buffer");
    expect(lowPointView(f({ cashBuffer: null })).words).toBe("below your buffer");
  });
});

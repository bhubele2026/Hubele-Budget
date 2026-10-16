import { describe, expect, it } from "vitest";
import { bufferBox, bufferLabelAbove, lowBox, overlaps, placeLowLabel } from "./chartLabelPlacement";

const plot = { plotTop: 14, plotH: 300, plotLeft: 56, plotRight: 380 };
const buf = (y: number) => bufferBox(380, y, 110);

describe("(E4) low-point label placement", () => {
  it("below the dot in the top half", () => {
    expect(placeLowLabel({ ...plot, dotX: 200, dotY: 60, anchor: "middle", lowWidth: 150, buffer: buf(250) }).below).toBe(true);
  });
  it("above the dot in the bottom half, clear of the buffer label", () => {
    const r = placeLowLabel({ ...plot, dotX: 120, dotY: 280, anchor: "middle", lowWidth: 150, buffer: buf(100) });
    expect(r).toEqual({ below: false, anchor: "middle", hideBuffer: false });
  });
  it("a dot at the buffer line near the right edge: the label never overlaps the buffer label, or the buffer label yields", () => {
    for (const dotY of [150, 190, 200, 212, 230]) {
      for (const anchor of ["start", "middle", "end"] as const) {
        const b = buf(200);
        const r = placeLowLabel({ ...plot, dotX: 350, dotY, anchor, lowWidth: 150, buffer: b });
        if (!r.hideBuffer) expect(overlaps(lowBox(350, dotY, 150, anchor, r.below), b)).toBe(false);
      }
    }
  });
  it("hides the buffer label when neither side clears it", () => {
    const b = { x0: 0, x1: 400, y0: 0, y1: 400 };
    expect(placeLowLabel({ ...plot, dotX: 200, dotY: 200, anchor: "middle", lowWidth: 150, buffer: b }).hideBuffer).toBe(true);
  });
  it("below, the other way round: when the buffer label sits to the right the label turns left", () => {
    const b = buf(200);
    const r = placeLowLabel({ ...plot, dotX: 200, dotY: 200, anchor: "middle", lowWidth: 170, buffer: b });
    expect(r.hideBuffer).toBe(false);
    expect(overlaps(lowBox(200, 200, 170, r.anchor, r.below), b)).toBe(false);
  });
  it("a buffer line at the plot's bottom puts its label above the line, off the x ticks", () => {
    expect(bufferLabelAbove(305, 314)).toBe(true);
    expect(bufferLabelAbove(200, 314)).toBe(false);
    const box = bufferBox(380, 305, 100, true);
    expect(box.y1).toBeLessThan(305);
  });
  it("no buffer label: nothing to avoid", () => {
    expect(placeLowLabel({ ...plot, dotX: 200, dotY: 200, anchor: "middle", lowWidth: 150, buffer: null }).hideBuffer).toBe(false);
  });
});

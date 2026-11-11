import { describe, expect, it } from "vitest";
import { AIR, BUF_CHAR_PX, bufferBox, bufferLabelAbove, FOOT, LOW_CHAR_PX, lowBox, overlaps, PLATE_PAD, placeCalmLabels, placeLowLabel, type Box } from "./chartLabelPlacement";

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

describe("(Clean forecast line) the calm chart's three plated labels", () => {
  // A 390 px phone: the chart is about 326 px wide, so the plot runs x 56…310, y 14…314.
  const phone: Box = { x0: 56, x1: 310, y0: 14, y1: 314 };
  const desktop: Box = { x0: 56, x1: 878, y0: 14, y1: 414 };
  const lowW = "Low $1,542.90 · Dec 31".length * LOW_CHAR_PX;
  const cushW = "Cushion $1,500.00".length * BUF_CHAR_PX + 2 * PLATE_PAD;
  const todayW = "Today".length * BUF_CHAR_PX + 2 * PLATE_PAD;
  /** A curve that sits `gap` px above the low dot everywhere except at the dot itself. */
  const vee = (dotX: number, dotY: number) => (x0: number, x1: number) =>
    x0 <= dotX && x1 >= dotX ? { y0: dotY - 120, y1: dotY } : { y0: dotY - 160, y1: dotY - 40 };
  const hit = (a: Box | null | undefined, b: Box | null | undefined) => !!a && !!b && overlaps(a, b, 0);

  it("Today sits at the top, right of its rule; left of it at the right edge", () => {
    const a = placeCalmLabels({ plot: phone, todayX: 56, todayWidth: todayW, low: null, cushion: null });
    expect(a.today).toEqual({ x0: 61, x1: 61 + todayW, y0: 16, y1: 30 });
    const b = placeCalmLabels({ plot: phone, todayX: 305, todayWidth: todayW, low: null, cushion: null });
    expect(b.today!.x1).toBeLessThanOrEqual(300);
  });

  it("the low label goes under its dot when nothing is in the way", () => {
    const r = placeCalmLabels({ plot: desktop, todayX: 56, todayWidth: todayW, low: { dotX: 400, dotY: 200, width: lowW, anchor: "middle" }, cushion: { y: 380, width: cushW }, curveSpan: vee(400, 200) });
    expect(r.low).toMatchObject({ below: true, anchor: "middle", dy: 0 });
    expect(r.cushion).toMatchObject({ end: "right", above: false });
  });

  it("a low point just over the cushion: the label drops under the rule, never on it", () => {
    const r = placeCalmLabels({ plot: desktop, todayX: 56, todayWidth: todayW, low: { dotX: 400, dotY: 300, width: lowW, anchor: "middle" }, cushion: { y: 304, width: cushW }, curveSpan: vee(400, 300) });
    expect(r.low!.below).toBe(true);
    expect(r.low!.dy).toBeGreaterThan(0);
    expect(r.low!.box.y0).toBeGreaterThan(304 + 2);
    expect(hit(r.low!.box, r.cushion?.box)).toBe(false);
  });

  it("390 px: the low label and the cushion label never collide, wherever the low point falls", () => {
    for (const cushionY of [120, 200, 260, 290, 300]) {
      for (const dotY of [40, 150, cushionY - 30, cushionY - 4, cushionY + 8]) {
        for (const frac of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
          const dotX = phone.x0 + frac * (phone.x1 - phone.x0);
          const anchor = frac <= 0.2 ? "start" : frac >= 0.8 ? "end" : "middle";
          const r = placeCalmLabels({ plot: phone, todayX: 56, todayWidth: todayW, low: { dotX, dotY, width: lowW, anchor }, cushion: { y: cushionY, width: cushW }, curveSpan: vee(dotX, dotY) });
          const at = `cushion ${cushionY}, dot ${dotY}, x ${frac}`;
          expect(hit(r.low!.box, r.cushion?.box), at).toBe(false);
          expect(hit(r.low!.box, r.today), at).toBe(false);
          expect(hit(r.cushion?.box, r.today), at).toBe(false);
          // Every plate stays inside the plot, off the payday ticks along the bottom edge.
          for (const b of [r.low!.box, r.cushion?.box, r.today]) {
            if (!b) continue;
            expect(b.x0, at).toBeGreaterThanOrEqual(phone.x0);
            expect(b.x1, at).toBeLessThanOrEqual(phone.x1);
          }
          if (r.cushion) expect(r.cushion.box.y1, at).toBeLessThanOrEqual(phone.y1 - FOOT);
        }
      }
    }
  });

  it("the cushion label keeps clear air from the curve: it changes side, then end, then yields", () => {
    // The curve runs right through the spot under the rule at the right end: the label goes above the rule.
    const through = (y: number) => () => ({ y0: y, y1: y + 6 });
    const a = placeCalmLabels({ plot: desktop, todayX: 56, todayWidth: todayW, low: null, cushion: { y: 200, width: cushW }, curveSpan: through(210) });
    expect(a.cushion).toMatchObject({ end: "right", above: true });
    expect(a.cushion!.box.y1).toBeLessThanOrEqual(210 - AIR);
    // A narrow plot, the rule near the bottom edge, the low label just above it: no place clears the low label,
    // so the cushion label is dropped, never overlapped.
    const tight = placeCalmLabels({ plot: { x0: 56, x1: 180, y0: 14, y1: 314 }, todayX: 56, todayWidth: todayW, low: { dotX: 118, dotY: 270, width: 110, anchor: "middle" }, cushion: { y: 300, width: 110 } });
    expect(tight.low).toMatchObject({ below: true, dy: 0 });
    expect(tight.cushion).toBeNull();
  });
});

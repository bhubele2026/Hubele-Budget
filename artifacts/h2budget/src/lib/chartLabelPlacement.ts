/**
 * (E4) Where the expanded cash chart puts its low-point label so it never lands on the buffer label.
 * Pure geometry on pixel boxes: no money, no data. The chart measures its plot, this picks a side.
 *
 * The rule: the label sits BELOW the dot when the dot is in the top half of the plot or within
 * `NEAR` px of the buffer label, else ABOVE it; the other side is the fallback. When neither side clears
 * the buffer label, the buffer label is hidden (the legend still names the buffer).
 */
export interface Box { x0: number; x1: number; y0: number; y1: number }

export const NEAR = 20;
/** Average glyph widths (px per character) of the two label fonts, a little generous. */
export const LOW_CHAR_PX = 6.6;
export const BUF_CHAR_PX = 5.9;

export const overlaps = (a: Box, b: Box, pad = 2): boolean =>
  a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;

export type LowAnchor = "start" | "middle" | "end";

export function lowBox(dotX: number, dotY: number, width: number, anchor: LowAnchor, below: boolean): Box {
  const x0 = anchor === "start" ? dotX : anchor === "end" ? dotX - width : dotX - width / 2;
  // The text baseline is 12 px above the dot or 18 px below it; the font is 11 px.
  return below ? { x0, x1: x0 + width, y0: dotY + 7, y1: dotY + 18 } : { x0, x1: x0 + width, y0: dotY - 23, y1: dotY - 12 };
}

/** The buffer label: right-anchored, just under the buffer line (insideTopRight), or just above it (insideBottomRight). */
export function bufferBox(plotRight: number, bufY: number, width: number, above = false): Box {
  const x1 = plotRight - 5;
  return above ? { x0: x1 - width, x1, y0: bufY - 17, y1: bufY - 5 } : { x0: x1 - width, x1, y0: bufY + 5, y1: bufY + 17 };
}

/** A buffer line this close to the plot's bottom would put its label on the x-axis ticks: the label goes above the line. */
export const bufferLabelAbove = (bufY: number, plotBottom: number): boolean => bufY > plotBottom - 22;

/**
 * Pick the low label's side and anchor. The preferred side first (the default anchor, then the two others that
 * stay inside the plot), then the other side; the first that clears the buffer label wins. None clears: the
 * buffer label is hidden.
 */
export function placeLowLabel(g: {
  dotX: number;
  dotY: number;
  plotTop: number;
  plotH: number;
  plotLeft: number;
  plotRight: number;
  anchor: LowAnchor;
  lowWidth: number;
  buffer: Box | null;
}): { below: boolean; anchor: LowAnchor; hideBuffer: boolean } {
  const { dotX, dotY, plotTop, plotH, plotLeft, plotRight, anchor, lowWidth, buffer } = g;
  const topHalf = dotY - plotTop < plotH / 2;
  const nearBuffer = buffer != null && dotY >= buffer.y0 - NEAR - 11 && dotY <= buffer.y1 + NEAR;
  const preferBelow = topHalf || nearBuffer;
  const anchors = [anchor, ...(["end", "start", "middle"] as const).filter((a) => a !== anchor)].filter((a) => {
    const b = lowBox(dotX, dotY, lowWidth, a, false);
    return a === anchor || (b.x0 >= plotLeft && b.x1 <= plotRight);
  });
  for (const below of [preferBelow, !preferBelow]) {
    for (const a of anchors) {
      if (buffer == null || !overlaps(lowBox(dotX, dotY, lowWidth, a, below), buffer)) return { below, anchor: a, hideBuffer: false };
    }
  }
  return { below: preferBelow, anchor, hideBuffer: true };
}

/**
 * ⭐ (Clean forecast line) The calm Forecast chart's THREE plated labels: Today, the low point and the cushion.
 * Same pixel geometry as above, placed together:
 *
 *  - Today sits at the top of the plot, right of its rule (left of it when the rule is at the right edge).
 *  - The low label goes BELOW its dot first: the curve is above the low point everywhere, so nothing crosses the
 *    words. When the cushion rule runs through that spot the label drops just under the rule instead; above the
 *    dot comes last, because there the plate would sit on the curve's own walls. The plate is slid sideways
 *    to stay inside the plot, and it keeps off the payday ticks along the bottom edge.
 *  - The cushion label then takes an end of its rule (right first) and a side of it (below first) that clears
 *    the other two labels and the curve. When no place clears them it is dropped, never overlapped.
 */
export const PLATE_PAD = 4;
/** Clear air kept between a plate and the curve. */
export const AIR = 4;
/** Room kept clear above the plot's bottom edge: the payday ticks stand there. */
export const FOOT = 12;

export type CalmLabels = {
  today: Box | null;
  cushion: { box: Box; above: boolean; end: "left" | "right" } | null;
  /** `dy`: extra px the label is moved down from its usual place under the dot (to sit under the cushion rule). */
  low: { box: Box; below: boolean; anchor: LowAnchor; dy: number } | null;
};

export function placeCalmLabels(g: {
  /** The plot rectangle (inside the axes). */
  plot: Box;
  todayX: number | null;
  todayWidth: number;
  low: { dotX: number; dotY: number; width: number; anchor: LowAnchor } | null;
  cushion: { y: number; width: number } | null;
  /** The curve's top and bottom (px) between two x positions; null when it is not known. */
  curveSpan?: (x0: number, x1: number) => { y0: number; y1: number } | null;
}): CalmLabels {
  const { plot, todayX, todayWidth, low, cushion, curveSpan } = g;
  let today: Box | null = null;
  if (todayX != null) {
    const right = todayX + 5 + todayWidth <= plot.x1;
    const x0 = right ? todayX + 5 : Math.max(plot.x0, todayX - 5 - todayWidth);
    today = { x0, x1: x0 + todayWidth, y0: plot.y0 + 2, y1: plot.y0 + 16 };
  }
  const inPlot = (b: Box) => b.x0 >= plot.x0 && b.x1 <= plot.x1 && b.y0 >= plot.y0 && b.y1 <= plot.y1 - FOOT;
  const clearOf = (b: Box, other: Box | null) => other == null || !overlaps(b, other);
  const offCurve = (b: Box) => {
    const span = curveSpan?.(b.x0 - 2, b.x1 + 2);
    return !span || span.y1 < b.y0 - AIR || span.y0 > b.y1 + AIR;
  };
  const offRule = (b: Box) => !cushion || cushion.y < b.y0 - 2 || cushion.y > b.y1 + 2;

  let lowOut: CalmLabels["low"] = null;
  if (low) {
    // The plate around the words; slid sideways when it would leave the plot (a low point near an edge).
    const pad = (b: Box, dy = 0): Box => {
      const x0 = Math.max(plot.x0 + 2, Math.min(b.x0 - PLATE_PAD, plot.x1 - 2 - (b.x1 - b.x0 + 2 * PLATE_PAD)));
      return { x0, x1: x0 + (b.x1 - b.x0) + 2 * PLATE_PAD, y0: b.y0 - 2 + dy, y1: b.y1 + 2 + dy };
    };
    const anchors = ["middle", ...(["start", "end"] as const)].sort((a, b) => Number(b === low.anchor) - Number(a === low.anchor)) as LowAnchor[];
    // Under the dot; under the cushion rule when the rule runs through that spot; above the dot.
    const under = lowBox(low.dotX, low.dotY, low.width, "middle", true);
    const drop = cushion && cushion.y >= low.dotY && cushion.y <= under.y1 + 4 ? Math.ceil(cushion.y + 3 - (under.y0 - 2)) : 0;
    const sides: Array<{ below: boolean; dy: number }> = [{ below: true, dy: 0 }, ...(drop > 0 ? [{ below: true, dy: drop }] : []), { below: false, dy: 0 }];
    const all = sides.flatMap(({ below, dy }) =>
      anchors.map((anchor) => ({ below, anchor, dy, box: pad(lowBox(low.dotX, low.dotY, low.width, anchor, below), dy) })),
    );
    const ok = all.filter((c) => inPlot(c.box) && clearOf(c.box, today));
    lowOut = ok.find((c) => offRule(c.box) && offCurve(c.box)) ?? ok.find((c) => offCurve(c.box)) ?? ok[0] ?? all[0]!;
  }

  let cush: CalmLabels["cushion"] = null;
  if (cushion) {
    const first = bufferLabelAbove(cushion.y, plot.y1);
    const right = (above: boolean) => bufferBox(plot.x1, cushion.y, cushion.width, above);
    const left = (above: boolean): Box => {
      const r = right(above);
      return { x0: plot.x0 + 5, x1: plot.x0 + 5 + cushion.width, y0: r.y0, y1: r.y1 };
    };
    const all = [
      { end: "right" as const, above: first, box: right(first) },
      { end: "right" as const, above: !first, box: right(!first) },
      { end: "left" as const, above: first, box: left(first) },
      { end: "left" as const, above: !first, box: left(!first) },
    ];
    const ok = all.filter((c) => inPlot(c.box) && clearOf(c.box, today) && clearOf(c.box, lowOut?.box ?? null));
    cush = ok.find((c) => offCurve(c.box)) ?? ok[0] ?? null;
  }
  return { today, cushion: cush, low: lowOut };
}

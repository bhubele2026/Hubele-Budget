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

/**
 * WCAG 2.x relative luminance and contrast ratio for #RRGGBB colours.
 * Pure and dependency-free: the contrast test and the `/design` page both
 * measure with it, so the ratio printed on a swatch is the one the test pins.
 */
function channel(hex: string, offset: number): number {
  const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`not a #RRGGBB colour: ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The ratio as the design page prints it: two decimals, truncated not rounded up. */
export function formatRatio(r: number): string {
  return `${(Math.floor(r * 100) / 100).toFixed(2)}:1`;
}

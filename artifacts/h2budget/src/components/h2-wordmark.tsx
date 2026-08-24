/**
 * ⭐ THE WORDMARK IS TYPE, NOT AN IMAGE.
 *
 * What it replaced was a 39 KB PNG of a violet-and-orange "H2" with a running
 * figure through it — a mark from a different app, in two colours the palette
 * does not contain, which the navy/platinum flip left stranded on the sign-in
 * card and in the browser tab. A raster logo also cannot answer the two sizes
 * this app actually needs it at: 26px in the header rail and ~400px as the
 * landing watermark. Type does both from one source, at any DPI, with no
 * bytes on the wire.
 *
 * ⚠️ NO CSS FILTER TRICK. Recolouring a PNG with `invert`/`brightness` to get a
 * second tone is what makes a mark look approximate — the edges go grey and the
 * anti-aliasing carries the old hue. Both tones here are drawn, not derived.
 *
 * ⭐ THE "2" CARRIES THE ONE ACCENT COLOUR, AND THAT IS THE WHOLE DECORATION.
 * H2 is the household — two people — so the 2 is the part of the name that
 * means something, and it takes brand orange in both tones. Nothing else in the
 * lockup is coloured: at 16px in a browser tab the word is gone entirely and
 * the navy box with an orange glint is the entire identity, which is the size a
 * mark has to survive.
 *
 * ⚠️ EVERY DIMENSION DERIVES FROM `size`, so the lockup is one shape scaled and
 * never a set of hand-tuned variants that drift apart. The one exception is the
 * ring, which scales on the SQUARE ROOT of the box — a stroke scaled linearly
 * reads as hairline at 26px and as a heavy frame at 400px. Optical scaling is
 * why a 1px rail ring becomes ~4px on the watermark instead of 15px.
 */

const NAVY = "#19315b";
const ORANGE = "#f68d2e";

export function H2Wordmark({
  tone,
  size = 26,
  className,
  "data-testid": testId,
}: {
  /**
   * `white` = on the navy chrome (header, hero band): the box is a white ring
   * on the navy it sits on, so the band shows through it.
   * `navy` = on platinum/white surfaces (sign-in card, watermark): the box is
   * solid navy with the letters knocked out of it.
   */
  tone: "white" | "navy";
  /** Height of the "H2" box in px. Everything else is a ratio of it. */
  size?: number;
  className?: string;
  "data-testid"?: string;
}) {
  const S = size;
  // At the default rail size this lands on 8px — `--radius-control` exactly —
  // and then keeps that proportion up to the watermark, where a fixed 8px would
  // read as a sharp-cornered slab.
  const radius = Math.max(3, Math.round(S * 0.28));
  const ring = Math.max(1, Math.round(Math.sqrt(S / 26) * 10) / 10);

  const boxStyle: React.CSSProperties =
    tone === "navy"
      ? { background: NAVY, borderRadius: radius }
      : { borderRadius: radius, boxShadow: `inset 0 0 0 ${ring}px rgba(255,255,255,0.82)` };

  return (
    <span
      role="img"
      aria-label="H2 Budget"
      data-testid={testId}
      className={`inline-flex select-none items-center whitespace-nowrap font-sans ${className ?? ""}`}
      style={{ gap: S * 0.32 }}
    >
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center justify-center"
        style={{
          width: S,
          height: S,
          ...boxStyle,
          fontSize: S * 0.5,
          fontWeight: 700,
          letterSpacing: "-0.045em",
          lineHeight: 1,
          color: "#ffffff",
        }}
      >
        {/* The `2` is nudged a hair right: the H's tight tracking pulls it in
            far enough to touch at large sizes, where a logo is read as a shape
            rather than as two letters. */}
        H<span style={{ color: ORANGE, marginLeft: S * 0.012 }}>2</span>
      </span>
      <span
        aria-hidden
        style={{
          fontSize: S * 0.56,
          fontWeight: 600,
          letterSpacing: "-0.025em",
          lineHeight: 1,
          color: tone === "navy" ? NAVY : "#ffffff",
        }}
      >
        Budget
      </span>
    </span>
  );
}

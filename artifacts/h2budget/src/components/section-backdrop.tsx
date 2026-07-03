/**
 * Per-section frosted backdrop — pulls the landing's mesh canvas onto the inner
 * pages, tinted by section so each area has its own identity:
 *   Banking → green · Bills → red · Forecast → orange · Avalanche → blue
 *
 * Kept SUBTLE (a light hue wash + a faint recoloured mesh) so it reads as an
 * identity tint, not a color flood, and never fights the app's money colors.
 * Decorative only: absolute, pointer-events-none, sits behind page content.
 * Mounted once in AppLayout behind <main>.
 */

export type SectionHue =
  | "green"
  | "red"
  | "orange"
  | "blue"
  | "brightBlue"
  | "snow"
  | "teal";

// tint = very light hue wash for the page ground; filter = recolour the gray-blue
// mesh img toward the hue (sepia primes it, then hue-rotate/saturate). Faint
// (mesh at ~5% opacity), tuned live.
const HUE: Record<SectionHue, { tint: string; filter: string }> = {
  green: { tint: "150 32% 97.5%", filter: "sepia(1) saturate(1.8) hue-rotate(75deg)" },
  red: { tint: "350 45% 97.5%", filter: "sepia(1) saturate(2.6) hue-rotate(-60deg)" },
  orange: { tint: "30 55% 97.5%", filter: "sepia(1) saturate(2.4) hue-rotate(-18deg)" },
  blue: { tint: "205 45% 97.5%", filter: "sepia(0.6) saturate(1.8) hue-rotate(165deg)" },
  // Bills: a BRIGHT, vivid blue (owner's ask) — clearly bluer/more saturated
  // than Avalanche's soft frost-blue, so the section reads unmistakably blue.
  brightBlue: { tint: "212 92% 95%", filter: "sepia(1) saturate(4) hue-rotate(178deg)" },
  // Avalanche: "fresh snow on a ski hill" — near-white ground with a soft icy
  // pale-blue mesh. Bright, clean, wintry (owner's pick). Lightest hue.
  snow: { tint: "205 55% 98.5%", filter: "sepia(0.5) saturate(1.4) hue-rotate(170deg)" },
  // Forecast: "deep horizon teal" — a cool, calm, forward-looking teal-green
  // wash across the whole forecast area (Overview/Review/Forecast/Debrief).
  teal: { tint: "185 45% 96.5%", filter: "sepia(0.7) saturate(2.4) hue-rotate(120deg)" },
};

export function SectionBackdrop({ hue }: { hue: SectionHue }) {
  const cfg = HUE[hue];
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      style={{
        background: `linear-gradient(to bottom, white, hsl(${cfg.tint}) 45%, hsl(${cfg.tint}))`,
      }}
    >
      {/* faint recoloured mesh flowing behind the page content */}
      <img
        src="/landing-bg.webp"
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full select-none object-cover object-center opacity-[0.05]"
        style={{ filter: cfg.filter }}
      />
      {/* soft hero band at the very top, tinted + faded — echoes the landing crown */}
      <img
        src="/landing-bg.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 top-0 max-h-[300px] w-full select-none object-cover object-top opacity-[0.5]"
        style={{
          filter: cfg.filter,
          WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,0.5) 20%, rgba(0,0,0,0) 100%)",
          maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.5) 20%, rgba(0,0,0,0) 100%)",
        }}
      />
    </div>
  );
}

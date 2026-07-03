/**
 * The launcher background: one continuous frosted canvas that matches the
 * reference mockup. The real mockup mesh (public/landing-bg.webp) forms a soft
 * hero band across the very top that fades seamlessly into a cool off-white
 * ground, with a faint echo of the line-art at the bottom margins so the page
 * reads as one surface — never "header + white void", and never a hard seam.
 *
 * Over that sits an ultra-faint "data-exhaust" layer: scattered domain labels
 * living in the outer gutters (wide screens) so the page feels like a live
 * financial canvas. Decorative only — aria-hidden, no real figures, no numbers
 * that could read as a balance; pointer-events none; content sits above at z-10.
 *
 * Seam fix: the hero image is height-capped + object-cover object-top so on wide
 * monitors it stays a proportional band (instead of ballooning into a huge
 * gappy strip), and the fade runs long (to 70%) so there is no visible cut line.
 */

// Ambient telemetry-style tokens in the margins. Domain words / node marks only.
const AMBIENT: Array<{ t: string; pos: string; cls?: string }> = [
  { t: "plaid · synced", pos: "left-[2.5%] top-[24%]", cls: "-rotate-6" },
  { t: "avalanche", pos: "left-[5%] top-[37%]" },
  { t: "· · ·", pos: "left-[3.5%] top-[45%] text-[16px]" },
  { t: "free-by", pos: "left-[2%] top-[57%] rotate-3" },
  { t: "runway", pos: "left-[6%] top-[70%]" },
  { t: "north-star · debt", pos: "left-[3%] bottom-[9%] -rotate-3 text-[10px]" },
  { t: "cadence", pos: "right-[5.5%] top-[22%] rotate-3" },
  { t: "chase · amex", pos: "right-[2.5%] top-[34%]" },
  { t: "· · ·", pos: "right-[6%] top-[43%] text-[16px]" },
  { t: "buckets", pos: "right-[3%] top-[55%] -rotate-6" },
  { t: "heloc · figure", pos: "right-[4.5%] top-[68%] text-[10px]" },
  { t: "payoff · locked", pos: "right-[2.5%] bottom-[12%] rotate-2" },
];

export function LandingBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-gradient-to-b from-[hsl(var(--frost-page))] via-[hsl(var(--frost-page))] to-background"
    >
      {/* Hero mesh — full-bleed band, height-capped so wide monitors don't
          balloon it, faded long so there's no seam. */}
      <img
        src="/landing-bg.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 top-0 max-h-[360px] w-full select-none object-cover object-top"
        style={{
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 100%)",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 100%)",
        }}
      />
      {/* Faint mirrored echo along the lower page so the canvas feels continuous
          behind the cards. */}
      <img
        src="/landing-bg.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-0 max-h-[320px] w-full -scale-y-100 select-none object-cover object-top opacity-[0.06]"
        style={{
          WebkitMaskImage:
            "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)",
          maskImage:
            "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)",
        }}
      />
      {/* Data-exhaust layer: ultra-faint labels in the outer gutters (lg+). */}
      <div className="absolute inset-0 hidden select-none font-mono text-[11px] font-medium tracking-tight text-[hsl(var(--frost-ink))] opacity-[0.08] lg:block">
        {AMBIENT.map((l, i) => (
          <span key={i} className={`absolute whitespace-nowrap ${l.pos} ${l.cls ?? ""}`}>
            {l.t}
          </span>
        ))}
      </div>
    </div>
  );
}

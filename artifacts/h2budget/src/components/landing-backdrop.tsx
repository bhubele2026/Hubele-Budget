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

// Ambient telemetry tokens scattered in the margins — faint "data-exhaust" like
// the mockup. Deliberately NON-monetary (node ids, coords, deltas, sync marks,
// versions) so nothing reads as a real balance or %; pure decorative texture.
const AMBIENT: Array<{ t: string; pos: string; cls?: string }> = [
  { t: "53.05.10", pos: "left-[2.5%] top-[22%]", cls: "-rotate-6" },
  { t: "node · 54", pos: "left-[5%] top-[33%]" },
  { t: "· · ·", pos: "left-[3.5%] top-[41%] text-[15px]" },
  { t: "≈ 61d", pos: "left-[2%] top-[52%] rotate-3" },
  { t: "0x3f9a", pos: "left-[6%] top-[63%]" },
  { t: "seq 7 / 12", pos: "left-[3%] top-[74%] -rotate-3 text-[10px]" },
  { t: "sync · 03:02", pos: "left-[4%] bottom-[9%]" },
  { t: "Δ 0.42", pos: "right-[5.5%] top-[20%] rotate-3" },
  { t: "40.71 · -89.6", pos: "right-[2.5%] top-[31%] text-[10px]" },
  { t: "· · ·", pos: "right-[6%] top-[40%] text-[15px]" },
  { t: "+0.128", pos: "right-[3%] top-[51%] -rotate-6" },
  { t: "v2.1.4", pos: "right-[5%] top-[62%]" },
  { t: "node · 21", pos: "right-[3%] top-[73%] text-[10px]" },
  { t: "seq 3 / 9", pos: "right-[4%] bottom-[12%] rotate-2" },
  { t: "· · ·", pos: "left-[46%] bottom-[5%] text-[15px]" },
  { t: "0x1c4", pos: "right-[42%] bottom-[6%] -rotate-3 text-[10px]" },
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
      <div className="absolute inset-0 hidden select-none font-mono text-[11px] font-medium tracking-tight text-[hsl(var(--frost-ink))] opacity-[0.05] lg:block">
        {AMBIENT.map((l, i) => (
          <span key={i} className={`absolute whitespace-nowrap ${l.pos} ${l.cls ?? ""}`}>
            {l.t}
          </span>
        ))}
      </div>
    </div>
  );
}

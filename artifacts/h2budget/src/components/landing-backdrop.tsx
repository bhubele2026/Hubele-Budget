/**
 * The launcher background: one continuous cool canvas. The real mockup mesh
 * (public/landing-bg.webp) forms a soft hero at the top that fades seamlessly
 * into a cool off-white ground, with a very faint echo of the line-art at the
 * bottom margins so the page reads as a single frosted surface — never
 * "header + white void".
 *
 * Over that sits an ultra-faint "data-exhaust" layer: scattered domain labels
 * and node marks living in the outer gutters (wide screens only) so the page
 * feels like a live financial canvas, matching the reference mockup. Purely
 * decorative — aria-hidden, no real figures (never dollar amounts/percentages
 * that could read as data), pointer-events none.
 *
 * Decorative only: absolute inset-0 at z-0 (never a negative z — that hid it
 * behind the app background), inside an `isolate` landing root; pointer-events
 * none; content sits above at z-10. Swap the art by replacing the webp.
 */

// Ambient telemetry-style tokens scattered in the margins. Domain words + node
// marks only — deliberately no numbers, so nothing reads as a real balance.
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
      {/* Hero mesh — soft, tall, fading into the ground with no hard seam. */}
      <img
        src="/landing-bg.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 top-0 w-full select-none"
        style={{
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 100%)",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 100%)",
        }}
      />
      {/* Faint echo of the line-art along the lower page, mirrored + ~5% so the
          canvas feels continuous behind the cards. */}
      <img
        src="/landing-bg.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-0 w-full -scale-y-100 select-none opacity-[0.05]"
        style={{
          WebkitMaskImage:
            "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)",
          maskImage:
            "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)",
        }}
      />
      {/* Data-exhaust layer: ultra-faint labels in the outer gutters. Wide
          screens only (xl+) so they live beside the grid, never over it. */}
      <div className="absolute inset-0 hidden select-none font-mono text-[11px] font-medium tracking-tight text-[hsl(var(--frost-ink))] opacity-[0.07] xl:block">
        {AMBIENT.map((l, i) => (
          <span key={i} className={`absolute whitespace-nowrap ${l.pos} ${l.cls ?? ""}`}>
            {l.t}
          </span>
        ))}
      </div>
    </div>
  );
}

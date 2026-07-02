/**
 * The launcher background: one continuous cool canvas. The real mockup mesh
 * (public/landing-bg.webp) forms a soft hero at the top that fades seamlessly
 * into a cool off-white ground, with a very faint echo of the line-art at the
 * bottom margins so the page reads as a single frosted surface — never
 * "header + white void".
 *
 * Decorative only: absolute inset-0 at z-0 (never a negative z — that hid it
 * behind the app background), inside an `isolate` landing root; pointer-events
 * none; content sits above at z-10. Swap the art by replacing the webp.
 */
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
    </div>
  );
}

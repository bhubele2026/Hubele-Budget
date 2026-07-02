/**
 * The landing page's background: the real mockup artwork — the flowing wire-mesh
 * + constellation band cropped straight from the approved Gemini mockup
 * (public/landing-bg.webp) — rendered full-bleed across the top and faded into
 * the page. A pale cool gradient carries the rest of the page beneath it.
 *
 * Decorative only: absolutely positioned at z-0 (NOT negative — a negative
 * z-index escaped the container and hid it behind the app's opaque background),
 * inside a landing root that is `isolate` so the stacking stays contained.
 * pointer-events-none; content sits above at z-10.
 *
 * To swap the artwork, just replace public/landing-bg.webp — no code change.
 */
export function LandingBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-gradient-to-b from-[hsl(210_40%_97%)] via-background to-background"
    >
      <img
        src="/landing-bg.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 top-0 w-full select-none"
        style={{
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 62%, rgba(0,0,0,0) 100%)",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 62%, rgba(0,0,0,0) 100%)",
        }}
      />
    </div>
  );
}

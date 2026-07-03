/**
 * The launcher background: minimal. A single, very subtle cool wash from the
 * frosted page tone into the app background — no imagery, no mesh, no labels.
 * Clean ground for the cards to sit on.
 *
 * Decorative only: absolute inset-0 at z-0, pointer-events none; content sits
 * above at z-10.
 */
export function LandingBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 bg-gradient-to-b from-[hsl(var(--frost-page))] to-background"
    />
  );
}

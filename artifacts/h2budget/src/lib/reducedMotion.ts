/** The `behavior` for a programmatic scroll: instant when the person asked for less motion (read at call time). */
export const scrollBehavior = (): ScrollBehavior =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

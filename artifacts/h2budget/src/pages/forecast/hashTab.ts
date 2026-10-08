/**
 * (D6) The Forecast and the Review bucket are two routes of one page
 * (`/forecast`, `/review`). Old deep links used `/forecast#bucket` and
 * `/forecast#register`; this maps a hash to the route that shows it, or null
 * when the current route already is the one the hash names.
 */
export function hashTabRedirect(
  mode: "overall" | "review",
  hash: string,
): string | null {
  if (mode === "overall" && hash === "#bucket") return "/review";
  if (mode === "review" && hash === "#register") return "/forecast";
  return null;
}

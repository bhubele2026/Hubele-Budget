import ForecastPanel from "./ForecastPanel";

/**
 * The forecast graph, the only panel after the four numbers and "More", as ONE
 * lazy chunk. (Home is four numbers, 2026-11-11) The "Pay this week" box moved
 * out of here to sit directly under the header, in its own lazy chunk. The
 * other panels (coming up, spending pace, debt progress, needs attention,
 * recent activity) no longer render on /home; their files stay for the pages
 * that reuse them.
 */
export function ForecastRow() {
  return <ForecastPanel />;
}

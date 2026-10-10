// (WP7) Its own module, re-exported by the `components/next` barrel. The
// landing's dashboard helpers (`pages/next/dashboard/shared.tsx`) use it, and
// while it lived in TxnTable.tsx the whole table rode along on the open path
// although only lazy panels draw it (Rollup keeps a module whole in the chunk
// of anything that uses one of its exports).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-08" -> "Oct 8", with no Date object so no timezone can shift it. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

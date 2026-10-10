/**
 * (WP7) A link to one row of a ledger: `?tx=<id>`, with the month the row is in
 * (`?month=YYYY-MM-01`, which `lib/accountRoute.ts` always adds) and, rarely, an
 * account (`?account=`). Both ledgers (Chase and Amex) read it once, when the
 * page opens, and open MONTH mode on that month — Week mode would hide a row
 * from earlier in the month — and say so: "Showing October 2026 for the row
 * you opened".
 */
export type RowDeepLink = {
  /** The row's id, or null when the page was not opened on a row. */
  tx: string | null;
  /** The row's month (YYYY-MM-01), or null when the link named none. */
  month: string | null;
  /** `?account=`, or null. */
  account: string | null;
};

export function readRowDeepLink(search: string): RowDeepLink {
  const params = new URLSearchParams(search);
  const month = params.get("month");
  return {
    tx: params.get("tx") || null,
    month: month && /^\d{4}-\d{2}-01$/.test(month) ? month : null,
    account: params.get("account") || null,
  };
}

/** The page's own search string, once (empty outside a browser). */
export function currentRowDeepLink(): RowDeepLink {
  return readRowDeepLink(typeof window === "undefined" ? "" : window.location.search);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "October 2026" for a month key (`month` is 0-based), with no Date object. */
export function monthWords(m: { year: number; month: number }): string {
  return `${MONTH_NAMES[m.month] ?? ""} ${m.year}`.trim();
}

/** The status line a ledger shows while it is on the month a row link opened. */
export function rowDeepLinkStatus(m: { year: number; month: number }): string {
  return `Showing ${monthWords(m)} for the row you opened`;
}

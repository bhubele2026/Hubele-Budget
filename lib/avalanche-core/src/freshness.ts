// ⭐ HOW OLD IS TOO OLD — one answer for the server and the browser.
//
// The API's `computeBankFreshness` called a quiet Plaid feed "old" after 48
// hours, while the dashboard's per-bank line called a bank "out of date" after
// 36: for twelve hours a day the header could say a bank was out of date while
// the balance beside it was served as fresh. Both read these now.
//
// A subpath of its own (`@workspace/avalanche-core/freshness`), like
// `householdTime`, so a page imports two numbers and never the payoff
// simulator behind the package root. No dependency.

/**
 * A bank feed silent this long — no balance re-read and no successful sync — is
 * out of date: the bank has stopped talking to us.
 */
export const PLAID_FEED_QUIET_MS = 48 * 60 * 60 * 1000;

/** A typed-in bank balance older than this is out of date (a live feed does not refresh it). */
export const MANUAL_SNAPSHOT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

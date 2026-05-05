// (#262) Shared Plaid re-auth error code set used by both the route
// layer (frontend gates the "Reconnect" button on this) and the daily
// disconnect-reminder sweep (skips items already in a re-auth code
// because the page-top banner already alerts them). Lives in `lib/`
// so the reminder library does not have to import from `routes/`,
// which would create a circular dependency once `routes/plaid.ts`
// imports the reminder entry points.
//
// Codes (per Plaid):
//   ITEM_LOGIN_REQUIRED — saved password / MFA is no longer valid.
//   PENDING_EXPIRATION — OAuth consent will expire soon; user should
//     re-authorize before that happens.
//   PENDING_DISCONNECT — Plaid has flagged this connection for shutdown
//     (data partner change, deprecated integration); user must reconnect
//     before the cutoff.
export const PLAID_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
]);

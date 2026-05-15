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
//   INVALID_ACCESS_TOKEN — (#654) Plaid rejected the stored access token
//     itself. In practice this happens when the token was issued for a
//     different Plaid environment than the one the server is currently
//     running against (e.g. a sandbox-prefixed token on a production
//     server). Plaid will never accept this token again, so the only
//     path forward is for the user to reconnect via Plaid Link in the
//     active environment — exactly the same affordance the other reauth
//     codes need. Treating it as a reauth code lights up the existing
//     Reconnect button on items already stamped with this code without
//     waiting for the next sync cycle to re-stamp them.
export const PLAID_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "INVALID_ACCESS_TOKEN",
]);

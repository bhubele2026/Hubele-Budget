/**
 * Plaid re-authentication words and predicates, PURE (no React, no hooks).
 *
 * (WP4, bundle) Moved verbatim from `components/plaid-reconnect-button.tsx`,
 * which re-exports every name, so existing imports keep working. The landing's
 * dashboard (bank lines, the Accounts panel, the debt tile) needs only these;
 * importing them from the button's module kept the whole Plaid Link button in
 * the entry chunk.
 */
// Plaid error codes that mean "the user must re-authenticate this item via
// Plaid Link in update mode". Mirrors PLAID_REAUTH_ERROR_CODES on the server
// (artifacts/api-server/src/routes/plaid.ts) — keep in sync.
export const PLAID_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  // (#654) Plaid hard-rejects the stored access_token itself — most
  // commonly because it was issued for a different Plaid environment
  // than the server is now talking to (e.g. a sandbox-prefixed token
  // on a production server). The only fix is for the user to re-link
  // the bank in the active environment, so this code surfaces the
  // same Reconnect CTA as the other reauth codes. Mirrors the server
  // set in artifacts/api-server/src/lib/plaidReauthCodes.ts.
  "INVALID_ACCESS_TOKEN",
]);

export function isPlaidReauthCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return PLAID_REAUTH_ERROR_CODES.has(code);
}

// (#710) Mirrors the server-side `isSyntheticPlaidItem` helper in
// artifacts/api-server/src/lib/plaid.ts. Synthetic seed rows (e.g. the
// April-2026 Chase synthetic placeholder row) are not
// real Plaid connections — they exist only to anchor the bank-snapshot
// tile before the user has completed OAuth. Their itemId always starts
// with `seed-`. We never want the reauth banner / Connect-a-bank guard
// / sync popover to surface them as "needs reconnect", because there's
// no Plaid Link update-mode flow that can heal a row Plaid has never
// heard of (clicking Reconnect would silently no-op). Keep the prefix
// in sync with SYNTHETIC_ITEM_ID in syntheticSeedIds.ts.
export function isSyntheticPlaidItem(
  item: { itemId?: string | null } | null | undefined,
): boolean {
  const id = item?.itemId ?? "";
  return id.startsWith("seed-");
}

// (#228) Friendly per-code copy that the page-top reconnect banner, the
// DebtReauthBanner, and the Settings "Needs reconnect" badge all share so
// the user knows *why* the Plaid Link popup is about to ask for credentials
// again before they click Reconnect. Keep keys aligned with
// PLAID_REAUTH_ERROR_CODES above.
//
// Codes (per Plaid):
//   ITEM_LOGIN_REQUIRED — saved password / MFA is no longer valid (most
//     common case; happens after a password change at the bank or an idle
//     session timeout).
//   PENDING_EXPIRATION — OAuth consent for this institution will expire
//     soon and the user should re-authorize before that happens.
//   PENDING_DISCONNECT — Plaid has flagged this connection for shutdown
//     (data partner change, deprecated integration); user must reconnect
//     before the cutoff or the link goes dead.
export const PLAID_REAUTH_ERROR_REASONS: Record<string, string> = {
  ITEM_LOGIN_REQUIRED:
    "Your saved login expired — sign in again to keep transactions in sync.",
  PENDING_EXPIRATION:
    "This bank's connection is about to expire — re-authorize to keep it linked.",
  PENDING_DISCONNECT:
    "Plaid will disconnect this bank soon — reconnect now to keep it linked.",
  // (#654) Worded so a non-technical user knows what to do without
  // exposing the underlying "wrong Plaid environment" detail.
  INVALID_ACCESS_TOKEN:
    "This bank's saved login is no longer valid — reconnect to bring in new transactions.",
};

const PLAID_REAUTH_FALLBACK_REASON =
  "Plaid needs you to re-authorize this bank.";

/**
 * (#238) Format a Plaid `consent_expiration_time` ISO string into the
 * short, locale-aware date the dated PENDING_EXPIRATION /
 * PENDING_DISCONNECT subline copy uses ("May 21" when same calendar
 * year as today, "May 21, 2027" otherwise so an out-of-year cutoff
 * isn't ambiguous). Returns null for any unparseable / missing input
 * so callers can safely fall back to the date-less copy.
 */
export function formatPlaidConsentExpirationDate(
  iso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

/**
 * Returns a one-line, user-facing reason explaining why an item needs to be
 * reconnected. Falls back to a generic "needs re-authorization" message for
 * any code we don't have specific copy for (including null / unknown codes
 * that still landed in a re-auth state via some other signal).
 *
 * (#238) When `consentExpirationAt` is provided AND the code is one of the
 * dated re-auth states (PENDING_EXPIRATION / PENDING_DISCONNECT) the copy
 * inlines the actual cutoff date so the user knows how urgent the
 * reconnect is ("Chase will disconnect on May 21 — reconnect now to keep
 * it linked.") instead of the vague "soon". For any other code, or when
 * Plaid did not report a cutoff for this item, falls back to the original
 * date-less per-code copy.
 *
 * `institutionName` makes the dated copy name the actual bank ("Chase
 * will disconnect on May 21") instead of a generic pronoun. Falls back
 * to "This bank" when the caller has no institution name to thread
 * through (e.g. an unnamed item).
 */
export function plaidReauthReason(
  code: string | null | undefined,
  opts: {
    consentExpirationAt?: string | null;
    institutionName?: string | null;
  } = {},
): string {
  if (!code) return PLAID_REAUTH_FALLBACK_REASON;
  const dated =
    code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT";
  if (dated) {
    const dateLabel = formatPlaidConsentExpirationDate(
      opts.consentExpirationAt,
    );
    if (dateLabel) {
      const subject = opts.institutionName?.trim() || "This bank";
      const verb =
        code === "PENDING_DISCONNECT" ? "disconnect" : "expire";
      return `${subject} will ${verb} on ${dateLabel} — reconnect now to keep it linked.`;
    }
  }
  return PLAID_REAUTH_ERROR_REASONS[code] ?? PLAID_REAUTH_FALLBACK_REASON;
}

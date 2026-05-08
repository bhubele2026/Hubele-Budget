import type { PlaidItemDetail } from "@workspace/api-client-react";

/**
 * (#387) Mobile mirror of artifacts/h2budget/src/components/plaid-reconnect-button.tsx
 * helpers (`PLAID_REAUTH_ERROR_CODES`, `isPlaidReauthCode`,
 * `formatPlaidConsentExpirationDate`, `plaidReauthReason`) plus the
 * banner-level `findPlaidItemsNeedingReauth`. Duplicated rather than
 * shared because the web copies live alongside web-only deps
 * (react-plaid-link, the web Button, etc.) and the mobile artifact
 * cannot import from a sibling artifact.
 *
 * Keep in sync with the web file when re-auth copy / codes change.
 */

export const PLAID_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
]);

export function isPlaidReauthCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return PLAID_REAUTH_ERROR_CODES.has(code);
}

export const PLAID_REAUTH_ERROR_REASONS: Record<string, string> = {
  ITEM_LOGIN_REQUIRED:
    "Your saved login expired — sign in again to keep transactions in sync.",
  PENDING_EXPIRATION:
    "This bank's connection is about to expire — re-authorize to keep it linked.",
  PENDING_DISCONNECT:
    "Plaid will disconnect this bank soon — reconnect now to keep it linked.",
};

const PLAID_REAUTH_FALLBACK_REASON =
  "Plaid needs you to re-authorize this bank.";

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
      const verb = code === "PENDING_DISCONNECT" ? "disconnect" : "expire";
      return `${subject} will ${verb} on ${dateLabel} — reconnect now to keep it linked.`;
    }
  }
  return PLAID_REAUTH_ERROR_REASONS[code] ?? PLAID_REAUTH_FALLBACK_REASON;
}

export type PlaidItemsReauthSummary = {
  items: PlaidItemDetail[];
  worst: PlaidItemDetail | null;
};

export function findPlaidItemsNeedingReauth(
  items: PlaidItemDetail[] | null | undefined,
): PlaidItemsReauthSummary {
  const affected = (items ?? []).filter((it) =>
    isPlaidReauthCode(it.lastSyncErrorCode),
  );
  const sorted = [...affected].sort((a, b) => {
    const an = a.institutionName ?? "";
    const bn = b.institutionName ?? "";
    if (an !== bn) return an.localeCompare(bn);
    return a.id.localeCompare(b.id);
  });
  return {
    items: sorted,
    worst: sorted[0] ?? null,
  };
}

/**
 * (#387) Mirror of artifacts/h2budget/src/hooks/use-plaid-sync.tsx
 * `formatPlaidErrorForDisplay` — kept identical so the mobile
 * "Couldn't verify disconnect date: …" subline reads the same as the
 * web banner's.
 */
export function formatPlaidErrorForDisplay(msg: string): string {
  if (!msg) return msg;
  return msg.startsWith("Plaid:") ? msg : `Plaid: ${msg}`;
}

/**
 * (#387) Pure derivation of the props the mobile <PlaidReauthBanner>
 * actually needs to render. Lifted out of the component so vitest can
 * pin both the dated subline copy AND the consentExpirationLastRefreshError
 * subline (the whole point of #387) without spinning up a React Native
 * test renderer.
 */
export type PlaidReauthBannerProps = {
  show: boolean;
  worstId: string | null;
  headline: string;
  subline: string;
  consentRefreshError: string | null;
  dismissKey: string;
};

export function derivePlaidReauthBannerProps(
  items: PlaidItemDetail[] | null | undefined,
): PlaidReauthBannerProps {
  const summary = findPlaidItemsNeedingReauth(items);
  const dismissKey = summary.items.map((i) => i.id).sort().join("|");
  if (!summary.worst) {
    return {
      show: false,
      worstId: null,
      headline: "",
      subline: "",
      consentRefreshError: null,
      dismissKey,
    };
  }
  const worst = summary.worst;
  const worstName = worst.institutionName ?? "Your bank";
  const otherCount = summary.items.length - 1;
  const headline =
    otherCount > 0
      ? `${worstName} and ${otherCount} more bank${otherCount === 1 ? "" : "s"} need reconnecting`
      : `${worstName} needs reconnecting`;
  const subline = plaidReauthReason(worst.lastSyncErrorCode, {
    consentExpirationAt: worst.consentExpirationAt,
    institutionName: worst.institutionName,
  });
  const consentRefreshError = worst.consentExpirationLastRefreshError ?? null;
  return {
    show: true,
    worstId: worst.id,
    headline,
    subline,
    consentRefreshError,
    dismissKey,
  };
}

import { describe, expect, it } from "vitest";
import type { PlaidItemDetail } from "@workspace/api-client-react";

import { derivePlaidReauthBannerProps } from "./plaidReauth";

function makeItem(
  overrides: Partial<PlaidItemDetail> & { id: string },
): PlaidItemDetail {
  return {
    itemId: `external-${overrides.id}`,
    institutionId: null,
    institutionName: "Chase",
    institutionSlug: "chase",
    lastSyncedAt: null,
    lastSyncError: null,
    lastSyncErrorCode: null,
    stillPreparing: false,
    stillPreparingSince: null,
    accounts: [],
    ...overrides,
  } as PlaidItemDetail;
}

describe("(#387) derivePlaidReauthBannerProps — consent-refresh subline", () => {
  it("renders 'Couldn't verify disconnect date: …' when consentExpirationLastRefreshError is set", () => {
    // Mirrors the web banner's #320 behavior on the mobile reauth surface
    // — without this line, a mobile-only user has no way to tell that
    // the dated 'Chase will disconnect on May 21' subline may be reading
    // off a stale cutoff.
    const props = derivePlaidReauthBannerProps([
      makeItem({
        id: "i-stale-consent",
        institutionName: "Chase",
        lastSyncErrorCode: "PENDING_DISCONNECT",
        consentExpirationAt: "2026-05-21T15:30:00.000Z",
        consentExpirationLastRefreshError: "ITEM_LOGIN_REQUIRED",
      }),
    ]);
    expect(props.show).toBe(true);
    expect(props.worstId).toBe("i-stale-consent");
    expect(props.consentRefreshError).toBe("ITEM_LOGIN_REQUIRED");
    // Subline still inlines the dated cutoff so the user sees both —
    // 'will disconnect on May 21' AND 'Couldn't verify disconnect date'.
    expect(props.subline).toContain("Chase will disconnect on");
  });

  it("clears the consent-refresh subline once a healthy refresh nulls the error", () => {
    // The whole point of the test: a successful /item/get refresh nulls
    // out `consentExpirationLastRefreshError`, the parent refetches,
    // and the inline warning must disappear so the banner doesn't lie
    // about the cutoff being unverifiable.
    const broken = derivePlaidReauthBannerProps([
      makeItem({
        id: "i-recovers",
        institutionName: "Chase",
        lastSyncErrorCode: "PENDING_DISCONNECT",
        consentExpirationAt: "2026-05-21T15:30:00.000Z",
        consentExpirationLastRefreshError: "ITEM_LOGIN_REQUIRED",
      }),
    ]);
    expect(broken.consentRefreshError).toBe("ITEM_LOGIN_REQUIRED");

    const healthy = derivePlaidReauthBannerProps([
      makeItem({
        id: "i-recovers",
        institutionName: "Chase",
        lastSyncErrorCode: "PENDING_DISCONNECT",
        consentExpirationAt: "2026-05-21T15:30:00.000Z",
        consentExpirationLastRefreshError: null,
      }),
    ]);
    // Banner is still shown (the item still needs reconnecting) — only
    // the consent-refresh line went away.
    expect(healthy.show).toBe(true);
    expect(healthy.consentRefreshError).toBeNull();
  });

  it("does not surface the consent-refresh line when the field is null to begin with", () => {
    const props = derivePlaidReauthBannerProps([
      makeItem({
        id: "i-clean",
        institutionName: "Chase",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        consentExpirationLastRefreshError: null,
      }),
    ]);
    expect(props.show).toBe(true);
    expect(props.consentRefreshError).toBeNull();
  });

  it("hides the banner entirely when no item is in re-auth", () => {
    const props = derivePlaidReauthBannerProps([
      makeItem({ id: "i1", lastSyncErrorCode: null }),
    ]);
    expect(props.show).toBe(false);
    expect(props.consentRefreshError).toBeNull();
  });

  it("uses the alphabetically-first failing institution as the 'worst' so consentRefreshError tracks that item", () => {
    // Same tie-break as the web banner — Amex sorts before Chase, so
    // when Amex is the failing item its consent-refresh error is the
    // one shown (not Chase's).
    const props = derivePlaidReauthBannerProps([
      makeItem({
        id: "i-chase",
        institutionName: "Chase",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        consentExpirationLastRefreshError: "OTHER_ERROR",
      }),
      makeItem({
        id: "i-amex",
        institutionName: "Amex",
        lastSyncErrorCode: "PENDING_DISCONNECT",
        consentExpirationAt: "2026-05-21T15:30:00.000Z",
        consentExpirationLastRefreshError: "ITEM_LOGIN_REQUIRED",
      }),
    ]);
    expect(props.worstId).toBe("i-amex");
    expect(props.consentRefreshError).toBe("ITEM_LOGIN_REQUIRED");
  });
});

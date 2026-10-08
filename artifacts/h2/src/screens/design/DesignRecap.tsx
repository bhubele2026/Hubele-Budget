import { Link, useSearch } from "wouter";
import type {
  HealthStatus,
  Invitation,
  MeResponse,
  Member,
  PlaidEnvironmentInfo,
  PlaidItemDetail,
  RecapDeliveryItem,
  RecapHistoryItem,
  RecapSettings,
} from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";
import { Note } from "@/kit/Note";
import { BanksView, type BanksData } from "@/screens/household/Household";
import { MembersView, type MembersData } from "@/screens/household/Members";
import { RecapView, type RecapData } from "@/screens/recap/Recap";

/**
 * ⭐ /design/recap — HOUSEHOLD AND RECAP ON MADE-UP DATA, for judging the
 * composition without signing in. Public, lazy, no network on load. `?page=`
 * picks the screen (recap, banks, members); `?state=` picks a state of it
 * (recap: new, verified, history-failed; banks: empty). Every name, number and
 * message is invented; the phone number is the reserved +1 555 01xx kind.
 */
const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday, 10:00 in Chicago
const loaded = <T,>(data: T): Read<T> => ({ data, state: "loaded", isFetching: false, refetch: () => {} });

const DELIVERY_NEW: RecapSettings["delivery"] = {
  mode: "preview",
  providerConfigured: false,
  phoneVerified: false,
  scheduled: false,
  sendTimeLocal: "07:00",
  timezone: "America/Chicago",
  lastDelivery: null,
};
const SETTINGS_NEW: RecapSettings = {
  delivery: DELIVERY_NEW,
  enabled: false,
  sendTimeLocal: "07:00",
  timezone: "America/Chicago",
  phoneLast4: null,
  verified: false,
  pausedUntil: null,
  skipWeekends: false,
  extraAlerts: false,
  consentedAt: null,
  optedOutAt: null,
  consentText: "By tapping Send code you agree to get one H2 text each morning at the time you choose, plus a verification code. Message and data rates may apply. Reply STOP to opt out.",
  consentTextVersion: "2026-10-sample",
};
const SETTINGS_ON: RecapSettings = {
  ...SETTINGS_NEW,
  enabled: true,
  phoneLast4: "0100",
  verified: true,
  skipWeekends: true,
  consentedAt: "2026-10-05T14:00:00Z",
  // The sample is in preview mode: the last text was written to the log, never sent.
  delivery: { ...DELIVERY_NEW, phoneVerified: true, scheduled: true, lastDelivery: { status: "previewed", provider: "console", at: "2026-10-07T12:00:00Z" } },
};

const history = (id: string, forDate: string, text: string, over: Partial<RecapHistoryItem>): RecapHistoryItem => ({
  id,
  forDate,
  text,
  source: "template",
  status: "sent",
  generatedAt: `${forDate}T12:00:00Z`,
  delivery: { status: "delivered", provider: "twilio", createdAt: `${forDate}T12:30:00Z` },
  ...over,
});
const HISTORY: RecapHistoryItem[] = [
  history("h1", "2026-10-07", "Good morning. You have $145 to spend today and the electric bill lands Friday.", { source: "model" }),
  history("h2", "2026-10-06", "Good morning. You are on plan this week. Nothing is due today.", { delivery: { status: "undelivered", provider: "twilio", createdAt: "2026-10-06T12:30:00Z" } }),
  history("h3", "2026-10-05", "Good morning. A quiet Monday.", { status: "skipped", delivery: null }),
];
const DELIVERIES: RecapDeliveryItem[] = [{ id: "d1", kind: "test", forDate: null, status: "delivered", provider: "twilio", createdAt: "2026-10-07T13:00:00Z" }];
const HEALTH_OFF = { status: "ok", version: "sample", jobs: { mode: "off", started: false, failedLast24h: null, dlq: null }, ai: { enabled: false, configured: false, provider: "fake" }, sms: { provider: "console", configured: false, mode: "preview" } } as HealthStatus;

const recap = (settings: RecapSettings, hist: RecapHistoryItem[] | undefined, state: "loaded" | "failed" = "loaded"): RecapData => ({
  settings: loaded(settings),
  history: state === "failed" ? { data: undefined, state: "failed", isFetching: false, refetch: () => {} } : loaded(hist ?? []),
  deliveries: loaded(DELIVERIES),
  health: loaded(HEALTH_OFF),
});

const acct = (id: string, name: string, mask: string, subtype: string) => ({ id, accountId: `${id}-a`, name, mask, subtype, type: "depository" });
const item = (id: string, name: string, over: Partial<PlaidItemDetail>): PlaidItemDetail =>
  ({ id, itemId: `item-${id}`, institutionName: name, institutionSlug: name.toLowerCase().replace(/\W+/g, "-"), lastSyncedAt: "2026-10-07T14:48:00Z", accounts: [], ...over }) as PlaidItemDetail;
const ITEMS: PlaidItemDetail[] = [
  item("p1", "Sample Bank", { accounts: [acct("p1a", "Checking", "0100", "checking"), acct("p1b", "Savings", "0101", "savings")] }),
  item("p2", "Sample Credit Union", { lastSyncedAt: "2026-10-04T14:48:00Z", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED", lastSyncError: "login required", accounts: [acct("p2a", "Visa", "0200", "credit card")] }),
  item("p3", "Sample Card Co", { stillPreparing: true, lastSyncedAt: null, accounts: [acct("p3a", "Rewards card", "0300", "credit card")] }),
  item("p4", "Sample Savings Bank", { lastSyncError: "The bank is not answering", lastSyncedAt: "2026-10-06T14:48:00Z", accounts: [acct("p4a", "Savings", "0400", "savings")] }),
];
const ENV = { env: "production", configured: true, nonProdItemCount: 0, nonProdItems: [] } as PlaidEnvironmentInfo;
const banks = (items: PlaidItemDetail[]): BanksData => ({ items: loaded(items), env: loaded(ENV) });

const ME = { userId: "u1", isOwner: true, displayName: "Sam (sample)", email: "sam@example.com" } as MeResponse;
const MEMBERS = [
  { id: "u1", displayName: "Sam (sample)", email: "sam@example.com", isOwner: true, createdAt: 1_790_000_000_000, lastSignInAt: 1_791_390_000_000 },
  { id: "u2", displayName: "Alex (sample)", email: "alex@example.com", isOwner: false, createdAt: 1_790_500_000_000, lastSignInAt: 1_791_300_000_000 },
] as Member[];
const INVITES = [
  { id: "i1", emailAddress: "jo@example.com", status: "pending", createdAt: 1_791_350_000_000, updatedAt: 1_791_350_000_000 },
  { id: "i2", emailAddress: "alex@example.com", status: "accepted", createdAt: 1_790_450_000_000, updatedAt: 1_790_500_000_000 },
] as Invitation[];
const members: MembersData = { me: loaded(ME), members: loaded(MEMBERS), invitations: loaded(INVITES) };

const PAGES = ["recap", "banks", "members"] as const;

export default function DesignRecap() {
  const params = new URLSearchParams(useSearch());
  const page = params.get("page") ?? "recap";
  const state = params.get("state") ?? "";
  return (
    <div className="flex flex-col gap-6" data-testid="page-design-recap">
      <Note kind="empty" data-testid="sample-note">
        Sample — every name and message on this page is made up.
      </Note>
      <p className="flex flex-wrap gap-4 type-label" data-testid="sample-pages">
        {PAGES.map((p) => (
          <Link key={p} href={`/design/recap?page=${p}`} className={p === page ? "text-ink" : "text-moss underline decoration-1 underline-offset-4"}>
            {p}
          </Link>
        ))}
      </p>
      {page === "banks" ? (
        <BanksView data={banks(state === "empty" ? [] : ITEMS)} now={NOW} />
      ) : page === "members" ? (
        <MembersView data={members} now={NOW} />
      ) : (
        <RecapView data={recap(state === "new" ? SETTINGS_NEW : SETTINGS_ON, state === "history-failed" ? undefined : HISTORY, state === "history-failed" ? "failed" : "loaded")} now={NOW} />
      )}
    </div>
  );
}

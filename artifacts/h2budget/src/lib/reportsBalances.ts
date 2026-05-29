// (Play B) Pure helpers behind the four at-a-glance balance tiles atop
// the Reports page. Extracted from the retired Dashboard so the tile
// math has a single, testable home and the numbers stay in lock-step
// with the rest of the app.

// The Amex tile sources the two revolving Amex cards from the actual
// Amex card *accounts* (the Plaid liability-accounts endpoint), NOT from
// the household debts list. Sourcing from debts was the root cause of
// task #875: a "Capital One Platinum" debt matched the `/platinum/i`
// matcher and its balance was reported as the Amex total. Reading from
// the Amex-scoped account source makes a non-Amex "Platinum" impossible
// to fold in, and the issuer guard below is defense in depth.
//
// This shape is structurally compatible with `PlaidLiabilityAccount`
// rows from `@workspace/api-client-react` so the caller can pass them
// straight through without converting.
export type AmexCardAccountLike = {
  name?: string | null;
  officialName?: string | null;
  mask?: string | null;
  balance?: string | number | null;
  type?: string | null;
  subtype?: string | null;
  liabilityKind?: string | null;
  institutionName?: string | null;
  institutionSlug?: string | null;
  // Carried by debt-like rows; the account source has no notion of
  // "status" but we keep it optional so any active/inactive flag is
  // honored if present.
  status?: string | null;
};

// Amex revolving-balance matchers. The tile sums the two revolving Amex
// cards — "Blue Cash Preferred" (1006) and "Platinum Card" (1009) — and
// intentionally excludes:
//   - Delta SkyMiles Gold (a charge card / pay-in-full, so its statement
//     balance is NOT revolving debt), and
//   - "Blue Cash Everyday" (a different, lower-tier card).
// A bare "Blue Cash" name is treated as the Preferred card. Matching on
// name keeps this independent of whether the row carries a mask —
// critical here because the Platinum Card and Delta SkyMiles Gold BOTH
// end in 1009, so they can only be distinguished by name (or Plaid id).
const BLUE_CASH_RE = /blue\s*cash/i;
const PLATINUM_RE = /platinum/i;
const DELTA_RE = /delta/i;
const EVERYDAY_RE = /everyday/i;

// Issuer guard (defense in depth). Only rows that are unambiguously
// Amex-issued are ever considered. We accept a row whose issuer
// (institutionName / institutionSlug) or name says Amex / American
// Express, and we hard-reject any row whose issuer or name names a
// known non-Amex issuer — so even if a "Capital One Platinum" row ever
// reached this helper it could never be folded into the Amex total.
const AMEX_ISSUER_RE = /amex|american\s*express/i;
const NON_AMEX_ISSUER_RE =
  /capital\s*one|\bchase\b|\bciti\b|citibank|discover|wells\s*fargo|bank\s*of\s*america|\bbofa\b|barclay|synchrony|\bus\s*bank\b|usbank|navy\s*federal|\bpnc\b|truist|\bamex\s*loan\b/i;

export function parseAmount(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isActive(status: string | null | undefined): boolean {
  const s = (status ?? "active").toLowerCase();
  return s !== "paid" && s !== "closed" && s !== "archived" && s !== "inactive";
}

function cardName(row: AmexCardAccountLike): string {
  return (row.name ?? row.officialName ?? "").trim();
}

// True only when the row is unambiguously Amex-issued. Rejects any row
// whose issuer or name matches a known non-Amex issuer first, then
// requires a positive Amex signal from either the issuer fields or the
// card name.
function isAmexIssued(row: AmexCardAccountLike): boolean {
  const issuer = `${row.institutionName ?? ""} ${row.institutionSlug ?? ""}`;
  const name = cardName(row);
  if (NON_AMEX_ISSUER_RE.test(issuer) || NON_AMEX_ISSUER_RE.test(name)) {
    return false;
  }
  return AMEX_ISSUER_RE.test(issuer) || AMEX_ISSUER_RE.test(name);
}

function isBlueCashPreferred(name: string): boolean {
  return BLUE_CASH_RE.test(name) && !EVERYDAY_RE.test(name);
}

// Platinum Card: match by name. Delta SkyMiles Gold also ends 1009 but
// its name never contains "platinum", and we guard against it explicitly.
function isPlatinum(name: string): boolean {
  return PLATINUM_RE.test(name) && !DELTA_RE.test(name);
}

export type AmexCardAvailability = {
  // A matching Amex-issued card row was found in the Amex-scoped source.
  // This is what distinguishes a "genuinely-expected but unavailable"
  // card (present, no usable balance) from one that simply isn't linked.
  present: boolean;
  // Whether the matched card carried a usable (non-null) balance. When
  // false the card contributes 0 to the total; if it is also `present`
  // it counts as "unavailable" for the partial-result subnote.
  available: boolean;
  balance: number | null;
  // Real mask of the matched card (first match), used to derive the
  // tile sub-line (e.g. "Blue Cash ••1006").
  mask: string | null;
};

function resolveCard<T extends AmexCardAccountLike>(
  rows: ReadonlyArray<T>,
  predicate: (name: string) => boolean,
): AmexCardAvailability {
  const matches = rows.filter((r) => {
    if (!isActive(r.status)) return false;
    if ((r.type ?? "").toLowerCase() === "loan") return false;
    if (!isAmexIssued(r)) return false;
    return predicate(cardName(r));
  });
  if (matches.length === 0) {
    return { present: false, available: false, balance: null, mask: null };
  }
  const mask = (matches[0].mask ?? "").trim() || null;
  const usable = matches.filter(
    (r) =>
      r.balance !== null &&
      r.balance !== undefined &&
      String(r.balance).trim() !== "",
  );
  if (usable.length === 0) {
    return { present: true, available: false, balance: null, mask };
  }
  const usableMask = (usable[0].mask ?? "").trim() || mask;
  const balance = usable.reduce((acc, r) => acc + parseAmount(r.balance), 0);
  return { present: true, available: true, balance, mask: usableMask };
}

export type AmexRevolvingBalance = {
  // Combined revolving balance of the available cards.
  total: number;
  // True when at least one of the two cards is available.
  found: boolean;
  blueCash: AmexCardAvailability;
  platinum: AmexCardAvailability;
  // How many of the two cards were available (0, 1, or 2).
  availableCount: number;
};

// Sum the current balance of the revolving Amex cards — Blue Cash
// Preferred (1006) and Platinum Card (1009) — from the Amex card-account
// source, excluding Delta SkyMiles Gold (a charge card, also ending
// 1009) and Blue Cash Everyday, and excluding any non-Amex-issued row
// (defense in depth). Returns per-card availability so the tile can
// render a partial result when only one card has a usable balance, and
// `found: false` only when neither is available.
export function resolveAmexRevolvingBalance<T extends AmexCardAccountLike>(
  rows: ReadonlyArray<T> | null | undefined,
): AmexRevolvingBalance {
  const empty: AmexCardAvailability = {
    present: false,
    available: false,
    balance: null,
    mask: null,
  };
  if (!rows || rows.length === 0) {
    return {
      total: 0,
      found: false,
      blueCash: empty,
      platinum: empty,
      availableCount: 0,
    };
  }
  const blueCash = resolveCard(rows, isBlueCashPreferred);
  const platinum = resolveCard(rows, isPlatinum);
  const total =
    (blueCash.available ? (blueCash.balance ?? 0) : 0) +
    (platinum.available ? (platinum.balance ?? 0) : 0);
  const availableCount =
    (blueCash.available ? 1 : 0) + (platinum.available ? 1 : 0);
  return {
    total,
    found: availableCount > 0,
    blueCash,
    platinum,
    availableCount,
  };
}

// Derive the tile sub-line from the cards actually found in the
// Amex-scoped source, using their real masks (e.g.
// "Blue Cash ••1006 + Platinum ••1009"). "(N card unavailable)" is
// appended only for cards that were genuinely found (present) but had no
// usable balance — never because a card simply isn't linked.
export function describeAmexRevolvingCards(b: AmexRevolvingBalance): string {
  const part = (label: string, card: AmexCardAvailability): string | null => {
    if (!card.present) return null;
    return card.mask ? `${label} ••${card.mask}` : label;
  };
  const parts = [
    part("Blue Cash", b.blueCash),
    part("Platinum", b.platinum),
  ].filter((p): p is string => p !== null);
  const unavailableCount =
    (b.blueCash.present && !b.blueCash.available ? 1 : 0) +
    (b.platinum.present && !b.platinum.available ? 1 : 0);
  if (parts.length === 0) return "No Amex cards linked";
  const base = parts.join(" + ");
  if (unavailableCount > 0) {
    return `${base} (${unavailableCount} card${unavailableCount === 1 ? "" : "s"} unavailable)`;
  }
  return base;
}

// (#884) The /reports Amex tile and the /amex page header intentionally
// surface two *different* numbers, and each must label itself so the gap
// never reads as a bug or a sync glitch:
//   - /reports shows the **current** revolving balance, summed live from
//     the Plaid liability-account source (`resolveAmexRevolvingBalance`
//     above) — i.e. "what the cards owe right now".
//   - /amex shows the **ending balance** for the selected month: an
//     anchor rolled forward by that month's transactions
//     (`makeAmexBalanceAtEndOf` in `amexEndingBalance.ts`) — i.e. the
//     projected balance at the close of the month.
// Because one is "right now" and the other is "projected end of month",
// they can legitimately drift mid-month and from each other's anchor
// source. Centralizing the copy here is the single source of truth that
// keeps both surfaces describing the distinction the same way instead of
// silently diverging.
export const AMEX_BALANCE_DISTINCTION = {
  // Prefix for the /reports tile sub-line, so it reads as the current
  // (live) balance rather than the Amex page's end-of-month figure.
  reportsSubPrefix: "Current balance",
  // Hover copy for the /reports tile explaining why it can differ from
  // the Amex page.
  reportsTooltip:
    "Current balance, summed live from your Amex card accounts. The Amex page shows the projected end-of-month balance, so the two can differ mid-month.",
  // Note appended to the /amex Ending balance tooltip explaining the
  // reciprocal distinction.
  amexTooltipNote:
    "This is the projected end-of-month balance. The Reports page shows the current live balance, so the two can differ mid-month.",
} as const;

// Build the /reports Amex tile sub-line: the live-card description
// (`describeAmexRevolvingCards`) prefixed with the shared
// "Current balance" label so the tile reads unambiguously as the
// current balance — distinct from the Amex page's end-of-month figure.
// When no card is found we keep the plain "No Amex cards linked" message
// (no point labeling a missing balance as "current").
export function describeReportsAmexTileSub(b: AmexRevolvingBalance): string {
  const cards = describeAmexRevolvingCards(b);
  if (!b.found) return cards;
  return `${AMEX_BALANCE_DISTINCTION.reportsSubPrefix} · ${cards}`;
}

// Map the cash-signal status to the tile's label + tone. Mirrors the
// language used by <AvalancheReadyCard/> ("Ready" / "Tight" / "Not Yet").
export type CashSignalStatus = "ready" | "tight" | "not_yet" | "no_data";

export function cashBufferStatusMeta(status: CashSignalStatus): {
  label: string;
  tone: "good" | "amber" | "bad" | "default";
} {
  switch (status) {
    case "ready":
      return { label: "Ready", tone: "good" };
    case "tight":
      return { label: "Tight", tone: "amber" };
    case "not_yet":
      return { label: "Not Yet", tone: "bad" };
    default:
      return { label: "No Snapshot", tone: "default" };
  }
}

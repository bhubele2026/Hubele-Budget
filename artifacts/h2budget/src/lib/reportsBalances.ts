// (Play B) Pure helpers behind the four at-a-glance balance tiles atop
// the Reports page. Extracted from the retired Dashboard so the tile
// math has a single, testable home and the numbers stay in lock-step
// with the rest of the app.

export type BlueCashDebtLike = {
  name: string;
  balance: string | number | null | undefined;
  status?: string | null;
  type?: string | null;
};

// Amex revolving-balance matchers. The tile sums the two revolving Amex
// cards — "Blue Cash Preferred" (1006) and "Platinum Card" (1009) — and
// intentionally excludes:
//   - Delta SkyMiles Gold (a charge card / pay-in-full, so its statement
//     balance is NOT revolving debt), and
//   - "Blue Cash Everyday" (a different, lower-tier card).
// A bare "Blue Cash" name is treated as the Preferred card. Matching on
// name keeps this independent of whether the debt row carries a mask —
// critical here because the Platinum Card and Delta SkyMiles Gold BOTH
// end in 1009, so they can only be distinguished by name (or Plaid id).
const BLUE_CASH_RE = /blue\s*cash/i;
const PLATINUM_RE = /platinum/i;
const DELTA_RE = /delta/i;
const EVERYDAY_RE = /everyday/i;

export function parseAmount(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isActive(status: string | null | undefined): boolean {
  const s = (status ?? "active").toLowerCase();
  return s !== "paid" && s !== "closed" && s !== "archived" && s !== "inactive";
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
  // Whether a matching active card row was found AND carried a usable
  // (non-null) balance. When false the card contributes 0 to the total
  // and counts as "unavailable" for the partial-result subnote.
  available: boolean;
  balance: number | null;
};

function resolveCard<T extends BlueCashDebtLike>(
  debts: ReadonlyArray<T>,
  predicate: (name: string) => boolean,
): AmexCardAvailability {
  const matches = debts.filter((d) => {
    if (!isActive(d.status)) return false;
    if ((d.type ?? "").toLowerCase() === "loan") return false;
    return predicate(d.name);
  });
  if (matches.length === 0) return { available: false, balance: null };
  const usable = matches.filter(
    (d) =>
      d.balance !== null &&
      d.balance !== undefined &&
      String(d.balance).trim() !== "",
  );
  if (usable.length === 0) return { available: false, balance: null };
  const balance = usable.reduce((acc, d) => acc + parseAmount(d.balance), 0);
  return { available: true, balance };
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
// Preferred (1006) and Platinum Card (1009) — excluding Delta SkyMiles
// Gold (a charge card, also ending 1009) and Blue Cash Everyday. Returns
// per-card availability so the tile can render a partial result when only
// one card has a usable balance, and `found: false` only when neither is
// available.
export function resolveAmexRevolvingBalance<T extends BlueCashDebtLike>(
  debts: ReadonlyArray<T> | null | undefined,
): AmexRevolvingBalance {
  const empty: AmexCardAvailability = { available: false, balance: null };
  if (!debts || debts.length === 0) {
    return {
      total: 0,
      found: false,
      blueCash: empty,
      platinum: empty,
      availableCount: 0,
    };
  }
  const blueCash = resolveCard(debts, isBlueCashPreferred);
  const platinum = resolveCard(debts, isPlatinum);
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

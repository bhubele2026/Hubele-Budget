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

// Amex Blue Cash PREFERRED matcher. We intentionally match ONLY the
// "Blue Cash Preferred" card and exclude:
//   - Delta SkyMiles Gold / Platinum (work-reimbursement-inflated, not
//     part of day-to-day spend), and
//   - "Blue Cash Everyday" (a different, lower-tier card).
// A bare "Blue Cash" name is treated as the Preferred card. Matching on
// name keeps this independent of whether the debt row carries a mask.
const BLUE_CASH_RE = /blue\s*cash/i;
const DELTA_OR_PLATINUM_RE = /(delta|platinum)/i;
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

// Sum the current balance of the Blue Cash Preferred card(s). Returns
// `found: false` when no matching card exists so the tile can show "—".
export function resolveBlueCashPreferredBalance<T extends BlueCashDebtLike>(
  debts: ReadonlyArray<T> | null | undefined,
): { total: number; found: boolean } {
  if (!debts || debts.length === 0) return { total: 0, found: false };
  const matches = debts.filter((d) => {
    if (!isActive(d.status)) return false;
    if ((d.type ?? "").toLowerCase() === "loan") return false;
    if (DELTA_OR_PLATINUM_RE.test(d.name)) return false;
    if (EVERYDAY_RE.test(d.name)) return false;
    return BLUE_CASH_RE.test(d.name);
  });
  if (matches.length === 0) return { total: 0, found: false };
  const total = matches.reduce((acc, d) => acc + parseAmount(d.balance), 0);
  return { total, found: true };
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memoryLocation } from "wouter/memory-location";

// ⭐ (Home is four numbers, 2026-11-11) "More": closed by default; opened, it
// holds what the home page used to open with — the six tiles, each bank's sync
// line, "Can we afford something?" and the morning text — with the same words.
// (The sync-line, afford and morning-text assertions moved here from the
// header's tests in dashboard.test.tsx.) Every value below is invented.

const h = vi.hoisted(() => ({
  Q: {} as Record<string, unknown>,
  asked: [] as string[],
  spine: { data: undefined as unknown, state: "loaded", refetch: () => {} },
}));
const ok = (data: unknown) => ({ data, isError: false, isLoading: false, refetch: () => {} });
const loading = { data: undefined, isError: false, isLoading: true, refetch: () => {} };
const get = (k: string) => { h.asked.push(k); return h.Q[k] ?? loading; };
vi.mock("./queries", () => ({
  usePlaidItemsQ: () => get("items"),
  useDebtsQ: () => get("debts"),
  useMoneyPositionQ: () => get("pos"),
  useLiabilityAccountsQ: () => get("liab"),
  useCashSignalQ: () => get("cash"),
}));
vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useGetSettings: () => ({ data: undefined }),
  useGetMe: () => ({ data: { isOwner: true }, isLoading: false }),
}));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => h.spine }));
vi.mock("@/components/data-state", () => ({ FreshnessLine: () => <span>fresh</span> }));
vi.mock("@/lib/routePrefetch", () => ({ prefetchRoute: () => {} }));
vi.mock("./RecapPreview", () => ({ default: () => <div data-testid="recap-stub">morning text</div> }));
vi.mock("./AmexWeekCharges", () => ({ default: () => <div data-testid="weekcharges-stub">Purchases this week</div> }));

import MoreDrawer from "./MoreDrawer";

const bank = {
  balance: "1234.00", asOfDate: "2026-11-10T20:00:00Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null,
  snapshot: { balance: "1234.00", at: "2026-11-10T20:00:00Z", source: "plaid" },
  sinceSnapshot: { net: "0.00", count: 0, through: "2026-11-10" },
  account: { rowId: "c1", externalId: "p-c1", name: "Checking A", mask: "0001", subtype: "checking", via: "sole checking" },
};
const spine = () => ({
  asOf: "2026-11-10T15:00:00Z", bank, spentMonth: 300, spentWeek: 40,
  nextBill: { name: "Rent", amount: "900.00", dueDate: "2026-11-12" }, billsDueCount: 1,
  forecast: { lowPoint: "600.00", lowPointDate: "2026-11-16", runwayDays: null, cashBuffer: "500.00", status: "tight" },
  debt: { payoffPct: 25.4, nextMilestone: null, paidDownMtd: 300, confirmedPaymentsMtd: 300, newChargesMtd: 0 },
  reviewCount: 2,
  position: { safeToSpendNow: "100.00", remainingWeek: "160.00", knownWeek: "40.00", unresolvedWeek: "0.00", provisional: false, remainingWeekKnown: "160.00", availableUntilPayday: "500.00", paydayDate: "2026-11-13", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false, weekAdjustment: null },
  monthAllowance: { plan: "1000.00", actual: "300.00", status: "within", remaining: "700.00", over: "0.00" },
});
const fresh = (state: string, fetchedAt: string | null) => ({ state, stale: state !== "ok", staleReason: null, fetchedAt, lastContactAt: fetchedAt, lastFailureAt: null });
const item = (id: string, institutionName: string, slug: string, accounts: unknown[], freshness: unknown) => ({
  id, itemId: `i-${id}`, institutionName, institutionSlug: slug, lastSyncedAt: null, lastSyncError: null, lastSyncErrorCode: null, accounts, freshness,
});
const acct = (id: string, o: Record<string, unknown>) => ({ id, accountId: `p-${id}`, name: null, mask: null, type: "depository", subtype: "checking", ...o });

function setup() {
  const mem = memoryLocation({ path: "/home", record: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Router hook={mem.hook}><MoreDrawer /></Router></QueryClientProvider>);
}
/** Open the native disclosure the way a tap does: the element opens, then says so. */
function open() {
  const d = screen.getByTestId("dash-more") as HTMLDetailsElement;
  d.open = true;
  fireEvent(d, new Event("toggle"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T17:00:00Z"));
  h.asked = [];
  h.spine = { data: spine(), state: "loaded", refetch: () => {} };
  h.Q = {
    pos: ok({ weekCap: "200.00" }),
    cash: ok({ hookReserves: [] }),
    debts: ok([{ id: "d1", name: "Card A", balance: "1500.00", originalBalance: "2000.00", status: "active", minPayment: "0", plaidAccountId: "x1" }]),
    items: ok([
      item("a", "Bank A", "bank-a", [acct("c1", { name: "Checking A", mask: "0001" })], fresh("ok", "2026-11-10T15:00:00Z")),
      item("b", "Bank B", "amex", [acct("x1", { name: "Card A", mask: "0002", type: "credit", subtype: "credit card" })], fresh("needs_reconnect", null)),
    ]),
  };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("More", () => {
  it("is a native disclosure, closed by default, and nothing inside is mounted or asked for until it opens", () => {
    setup();
    const d = screen.getByTestId("dash-more") as HTMLDetailsElement;
    expect(d.tagName).toBe("DETAILS");
    expect(d.open).toBe(false);
    expect(d.className).toContain("span-12");
    expect(screen.getByTestId("dash-more-summary").tagName).toBe("SUMMARY");
    expect(screen.getByTestId("dash-more-summary").textContent).toBe("Accounts, allowances and tools");
    expect(d.textContent).toBe("Accounts, allowances and tools");
    // The body slides open (index.css `.disclose`; off under reduced motion).
    expect(d.className).toContain("disclose");
    expect(screen.queryByTestId("dash-more-body")).toBeNull();
    expect(screen.queryByTestId("tile-banking")).toBeNull();
    expect(h.asked).toEqual([]);
  });

  it("opened: the six old tiles, as they were (titles, chips, fine print, Why?, links)", async () => {
    setup();
    open();
    const body = screen.getByTestId("dash-more-body");
    expect(body.className).toContain("grid-12");
    const tiles = ["banking", "amex", "week", "month", "forecast", "debt"];
    expect(Array.from(body.querySelectorAll("[data-testid^='tile-'][data-testid$='-link']"), (e) => e.getAttribute("data-testid"))).toEqual(tiles.map((t) => `tile-${t}-link`));
    expect(Array.from(body.querySelectorAll("h2"), (e) => e.textContent)).toEqual(["Banking", "Amex", "This week", "Monthly allowance", "Forecast", "Debt"]);
    for (const t of tiles) expect(screen.getByTestId(`tile-${t}`).className, t).toContain("span-4");
    // The words the four boxes left out are all still here.
    expect(screen.getByTestId("tile-banking-status").textContent).toBe("2 need you");
    expect(screen.getByTestId("tile-banking-account").textContent).toBe("Checking A ••0001");
    expect(screen.getByTestId("tile-banking-balance").textContent).toBe("$1,234.00");
    expect(screen.getByTestId("tile-week-status").textContent).toBe("On plan");
    expect(screen.getByTestId("tile-week-plan").textContent).toBe("$200.00");
    expect(screen.getByTestId("tile-week-left").textContent).toBe("$160.00 left");
    expect(screen.getByTestId("tile-week").textContent).toContain("Why?");
    expect(screen.getByTestId("tile-month-left").textContent).toBe("$700.00 left");
    expect(screen.getByTestId("tile-forecast-status").textContent).toBe("Near buffer");
    expect(screen.getByTestId("tile-forecast-next").textContent).toBe("Next: Rent$900.00");
    expect(screen.getByTestId("tile-debt-pct").textContent).toBe("25%");
    expect(screen.getByTestId("tile-debt-mtd").textContent).toBe("$300.00");
    expect(screen.getByTestId("tile-amex-owed").textContent).toBe("$1,500.00");
    expect(screen.getByTestId("tile-banking-link").getAttribute("href")).toBe("/banking?account=c1");
    expect(screen.getByTestId("tile-debt-link").getAttribute("href")).toBe("/avalanche");
    // (W4) The Amex tile's "Purchases this week" still arrives, in its own chunk.
    await waitFor(() => expect(screen.getByTestId("weekcharges-stub")).toBeTruthy());
  });

  it("opened: each bank's sync line, with the header's old words", () => {
    setup();
    open();
    const banks = screen.getByTestId("dash-bank-fresh");
    expect(banks.textContent).toContain("Bank A · synced 2 h ago");
    expect(banks.textContent).toContain("Bank B · needs reconnecting");
    expect(Array.from(banks.querySelectorAll("li"), (li) => li.getAttribute("data-state"))).toEqual(["ok", "reauth"]);
    // the connection lines are label size
    expect(banks.className).toContain("text-label");
    // The check, updated and pending still live once, on the Banking tile.
    expect(screen.queryByTestId("dash-bank-confidence")).toBeNull();
    expect(screen.queryByTestId("dash-bank-check")).toBeNull();
  });

  it("(Q5 fix) the bank dots follow the server's word: a connection it calls ok is never 'not synced yet' for a null lastSyncedAt", () => {
    h.Q.items = ok([item("a", "Bank A", "bank-a", [acct("c1", { name: "Checking A", mask: "0001" })], fresh("ok", "2026-11-10T15:00:00Z"))]);
    setup();
    open();
    const li = screen.getByTestId("dash-bank-fresh").querySelector("li")!;
    expect(li.getAttribute("data-state")).toBe("ok");
    expect(li.textContent).not.toContain("not synced yet");
  });

  it("no bank linked: no sync list, and both links stay", () => {
    h.Q.items = ok([]);
    setup();
    open();
    expect(screen.queryByTestId("dash-bank-fresh")).toBeNull();
    expect(screen.getByTestId("afford-open").textContent).toBe("Can we afford something?");
    expect(screen.getByTestId("dash-recap-toggle").textContent).toBe("Morning text");
  });

  it("opened: 'Can we afford something?' and the morning text, which only loads when asked for", async () => {
    setup();
    open();
    expect(screen.getByTestId("afford-open").textContent).toBe("Can we afford something?");
    expect(screen.queryByTestId("recap-stub")).toBeNull();
    const t = screen.getByTestId("dash-recap-toggle");
    expect(t.textContent).toBe("Morning text");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    // Same row as Afford, after it.
    expect(t.parentElement).toBe(screen.getByTestId("afford-open").parentElement);
    fireEvent.click(t);
    await waitFor(() => expect(screen.getByTestId("recap-stub")).toBeTruthy());
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(t.textContent).toBe("Hide morning text");
  });

  it("closing it keeps what was loaded (no second mount on the next open)", () => {
    setup();
    open();
    const d = screen.getByTestId("dash-more") as HTMLDetailsElement;
    const body = screen.getByTestId("dash-more-body");
    d.open = false;
    fireEvent(d, new Event("toggle"));
    expect(screen.getByTestId("dash-more-body")).toBe(body);
  });
});

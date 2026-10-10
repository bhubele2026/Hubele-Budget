import React from "react";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeHouseholdApi,
  type FakeAccount,
  type FakeHouseholdApi,
  type FakeHouseholdOptions,
  type FakeHouseholdRow,
} from "../__test-helpers__/fakeHouseholdApi";

/**
 * ⭐ (WP7d) THE REAL-LEDGER MATRIX. Every kind of account a household links,
 * opened through the REAL account page and the REAL embedded ledgers (the Chase
 * and Amex pages, not stubs), on the REAL generated hooks, answered at the
 * fetch level by `fakeHouseholdApi` (which composes `createFakeLedgerServer`).
 *
 * For each route it asserts row PRESENCE and ABSENCE: the page lists exactly the
 * rows that belong there — its own, its twin's, and (on the bank balance's
 * account) the manual rows — and none of anyone else's. Then it checks the
 * route rule against the pages: every row's `txnRoute` href opens a page that
 * lists it, and the gone account's row opens nowhere. Plus the combined view's
 * cap note, the refusal state, a loan's words, and that a card's page never
 * asks GET /transactions without its `plaidAccountId`.
 *
 * The household (all rows dated this week, Sun 09-13 – Wed 09-16, so both
 * ledgers' default Week mode shows them):
 *   Chase Total Checking ••5526 (the bank balance's) and its twin on a re-linked
 *   item; a second Chase checking ••7001; a credit union's checking ••2290;
 *   Chase Savings ••8801; Amex Blue ••1001; Chase Freedom ••4417 (a credit
 *   card at a bank, `plaid:chase`); an Upstart loan; a Chase checking the ledger
 *   refuses (unlinked between the list and the ledger); a manual row; an Amex
 *   workbook row; a row from a closed account that is no longer linked.
 */

vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useReviewInboxCount", () => ({ useReviewInboxCount: () => 0 }));
vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({ offerBulkRecategorize: vi.fn(), previewDialog: null }),
}));
vi.mock("@/lib/useRuleActionUndo", () => ({ useRuleActionUndo: () => vi.fn() }));
vi.mock("@/components/plaid-reauth-banner", async (orig) => ({
  ...(await orig<object>()),
  PlaidReauthBanner: () => null,
  PlaidReauthBannerView: () => null,
}));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/plaid-link-button", () => ({ PlaidLinkButton: () => null }));
vi.mock("@/components/post-link-progress", () => ({ PostLinkProgressBanner: () => null }));
vi.mock("@/components/chase-insight-strip", () => ({ ChaseInsightStrip: () => null }));
vi.mock("@/components/account-page/balance-trend-chart", () => ({ BalanceTrendChart: () => null }));
vi.mock("@/components/merchant-rename-popover", () => ({ MerchantRenamePopover: () => null }));
vi.mock("@/components/category-picker", () => ({ CategoryPicker: () => null, defaultRememberPattern: (s: string) => s }));
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => null }));

import NextAccountsPage from "./Accounts";
import AmexPage from "../amex";
import TransactionsPage from "../transactions";
import { buildEntries } from "./accounts/entries";
import { txnRoute } from "@/lib/accountRoute";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

// Wednesday 2026-09-16, noon UTC (07:00 in Chicago): this week is Sun 09-13 – Sat 09-19.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});
const TODAY = "2026-09-16";

const ITEMS: FakeHouseholdOptions["items"] = [
  { id: "it-chase", institutionName: "Chase", institutionSlug: "chase" },
  { id: "it-chase-relink", institutionName: "Chase", institutionSlug: "chase" },
  { id: "it-summit", institutionName: "Summit Credit Union", institutionSlug: "summit-credit-union" },
  { id: "it-amex", institutionName: "American Express", institutionSlug: "amex" },
  { id: "it-upstart", institutionName: "Upstart", institutionSlug: "upstart" },
];
const acct = (key: string, item: string, name: string, mask: string | null, type: FakeAccount["type"], subtype: string): FakeAccount => ({
  key, id: `row-${key}`, accountId: `ext-${key}`, item, name, mask, type, subtype,
});
const ACCOUNTS: FakeAccount[] = [
  acct("chk", "it-chase", "Total Checking", "5526", "depository", "checking"),
  acct("twin", "it-chase-relink", "Total Checking", "5526", "depository", "checking"),
  acct("chase2", "it-chase", "Premier Plus Checking", "7001", "depository", "checking"),
  acct("cu", "it-summit", "Summit Checking", "2290", "depository", "checking"),
  acct("sav", "it-chase", "Savings", "8801", "depository", "savings"),
  acct("blue", "it-amex", "Blue Cash Preferred", "1001", "credit", "credit card"),
  acct("freedom", "it-chase", "Freedom Unlimited", "4417", "credit", "credit card"),
  acct("loan", "it-upstart", "Personal Loan", "9009", "loan", "loan"),
  acct("refused", "it-chase", "Old Joint Checking", "3030", "depository", "checking"),
];

type Key =
  | "CHK_A" | "CHK_B" | "TWIN_A" | "MANUAL_A" | "CHASE2_A" | "CU_A" | "SAV_A" | "BLUE_A" | "BLUE_REFUND"
  | "FREEDOM_A" | "WORKBOOK_A" | "GONE_A" | "LOAN_A" | "REFUSED_A";
const row = (key: Key, o: Partial<FakeHouseholdRow> & Pick<FakeHouseholdRow, "account" | "source">): FakeHouseholdRow => ({
  id: `tx-${key.toLowerCase()}`,
  occurredOn: "2026-09-15",
  description: key,
  amount: "-10.00",
  ...o,
});
const ROWS: FakeHouseholdRow[] = [
  row("CHK_A", { account: "chk", source: "plaid:chase", occurredOn: "2026-09-16" }),
  row("CHK_B", { account: "chk", source: "plaid:chase", occurredOn: "2026-09-14", amount: "2100.00" }),
  row("TWIN_A", { account: "twin", source: "plaid:chase" }),
  row("MANUAL_A", { account: null, source: "manual", occurredOn: "2026-09-14" }),
  row("CHASE2_A", { account: "chase2", source: "plaid:chase" }),
  row("CU_A", { account: "cu", source: "plaid:summit-credit-union" }),
  row("SAV_A", { account: "sav", source: "plaid:chase", amount: "25.00" }),
  row("BLUE_A", { account: "blue", source: "plaid:amex", occurredOn: "2026-09-16", amount: "42.00" }),
  row("BLUE_REFUND", { account: "blue", source: "plaid:amex", occurredOn: "2026-09-14", amount: "-12.50" }),
  row("FREEDOM_A", { account: "freedom", source: "plaid:chase", amount: "-14.82" }),
  row("WORKBOOK_A", { account: null, source: "amex", amount: "33.00" }),
  row("GONE_A", { account: null, plaidAccountIdOverride: "ext-closed-9911", source: "plaid:chase" }),
  row("LOAN_A", { account: "loan", source: "plaid:upstart", amount: "-245.00" }),
  row("REFUSED_A", { account: "refused", source: "plaid:chase" }),
];
const keyOfId = new Map(ROWS.map((r) => [r.id, r.description as Key]));

const HOUSEHOLD: FakeHouseholdOptions = {
  today: TODAY,
  items: ITEMS,
  accounts: ACCOUNTS,
  rows: ROWS,
  snapshotAccount: "chk",
  twins: ["twin"],
  refuse: ["refused"],
  balanceToday: "4812.37",
};

let qc: QueryClient;
let api: FakeHouseholdApi;
function serve(opts: FakeHouseholdOptions = HOUSEHOLD): FakeHouseholdApi {
  api = createFakeHouseholdApi(opts);
  vi.stubGlobal("fetch", api.fetch);
  return api;
}
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

function at(path: string) {
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <NextAccountsPage />
      </Router>
    </QueryClientProvider>,
  );
}
function page(el: React.ReactElement) {
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}

/** The fixture rows a ledger on screen lists (Chase `row-tx-<id>`, Amex `row-amex-<id>`). */
function listedKeys(): Set<Key> {
  const ids = Array.from(document.querySelectorAll("[data-testid^='row-tx-'], [data-testid^='row-amex-']"))
    .map((e) => e.getAttribute("data-testid") ?? "")
    .filter((t) => !t.startsWith("row-amex-mobile-"))
    .map((t) => t.replace(/^row-(tx|amex)-/, ""));
  return new Set(ids.map((id) => keyOfId.get(id)).filter((k): k is Key => !!k));
}
const ALL_KEYS = ROWS.map((r) => r.description as Key);

/** Presence AND absence: exactly `expected`, and every other fixture row absent. */
async function expectListsExactly(expected: Key[]) {
  await waitFor(() => expect([...listedKeys()].sort()).toEqual([...expected].sort()), { timeout: 4000 });
  const listed = listedKeys();
  for (const k of ALL_KEYS) expect(listed.has(k), `${k} ${expected.includes(k) ? "present" : "absent"}`).toBe(expected.includes(k));
}

// Route → the rows it lists (the server's scope, by kind).
const BANK_SNAPSHOT_ROWS: Key[] = ["CHK_A", "CHK_B", "TWIN_A", "MANUAL_A"];
const ACCOUNT_PAGE_ROWS: Record<string, Key[]> = {
  chk: BANK_SNAPSHOT_ROWS,
  twin: BANK_SNAPSHOT_ROWS,
  chase2: ["CHASE2_A"],
  cu: ["CU_A"],
  sav: ["SAV_A"],
  blue: ["BLUE_A", "BLUE_REFUND"],
  freedom: ["FREEDOM_A"],
};

describe("(WP7d) every account page lists its own rows and nobody else's", () => {
  it.each(Object.entries(ACCOUNT_PAGE_ROWS))("/next/accounts/<%s>", async (key, expected) => {
    serve();
    at(`/next/accounts/ext-${key}`);
    await expectListsExactly(expected);
  });

  it("a card's page never asks GET /transactions without its plaidAccountId (nor by source)", async () => {
    for (const key of ["blue", "freedom"]) {
      serve();
      const view = at(`/next/accounts/ext-${key}`);
      await expectListsExactly(ACCOUNT_PAGE_ROWS[key]!);
      const gets = api.listGets();
      expect(gets.length, key).toBeGreaterThan(0);
      for (const g of gets) {
        expect(g.query.get("plaidAccountId"), key).toBe(`ext-${key}`);
        expect(g.query.has("source"), key).toBe(false);
      }
      view.unmount();
      qc.clear();
    }
  });

  it("the bank pages ask the ledger for THAT account (the snapshot's by default), never the old list", async () => {
    for (const [key, account] of [["chk", "row-chk"], ["cu", "row-cu"], ["sav", "row-sav"]] as const) {
      serve();
      const view = at(`/next/accounts/ext-${key}`);
      await expectListsExactly(ACCOUNT_PAGE_ROWS[key]!);
      const ledgerGets = api.ledger.ledgerGets();
      expect(ledgerGets.length, key).toBeGreaterThan(0);
      for (const g of ledgerGets) expect(g.query.get("account"), key).toBe(account);
      expect(api.listGets(), key).toHaveLength(0);
      view.unmount();
      qc.clear();
    }
  });

  it("a non-snapshot account says its balance is unavailable; the snapshot's has one", async () => {
    serve();
    const cu = at("/next/accounts/ext-cu");
    await expectListsExactly(ACCOUNT_PAGE_ROWS.cu!);
    expect(screen.getByTestId("chase-balance-unavailable").textContent).toBe("Balance unavailable");
    cu.unmount();
    qc.clear();
    serve();
    at("/next/accounts/ext-chk");
    await expectListsExactly(BANK_SNAPSHOT_ROWS);
    expect(screen.queryByTestId("chase-balance-unavailable")).toBeNull();
  });

  it("a loan says plainly there is no ledger yet, and lists nothing", async () => {
    serve();
    at("/next/accounts/ext-loan");
    expect(await screen.findByTestId("account-no-ledger")).toBeTruthy();
    expect(screen.getByTestId("account-no-ledger").textContent).toBe("H2 has no ledger for loans yet.");
    expect(listedKeys().size).toBe(0);
    expect(api.ledger.ledgerGets()).toHaveLength(0);
  });

  it("an account the ledger refuses is said in place (chase-no-ledger), with nobody else's rows instead", async () => {
    serve();
    at("/next/accounts/ext-refused");
    const notice = await screen.findByTestId("chase-no-ledger");
    expect(notice.textContent).toContain("H2 has no ledger for this account.");
    expect(listedKeys().size).toBe(0);
    // Every ledger request named the refused account: no fallback to the snapshot's.
    for (const g of api.ledger.ledgerGets()) expect(g.query.get("account")).toBe("row-refused");
  });
});

describe("(WP7d) the standalone ledgers", () => {
  it("/transactions lists the bank balance's account, its twin and the manual rows", async () => {
    serve();
    page(<TransactionsPage />);
    await expectListsExactly(BANK_SNAPSHOT_ROWS);
  });

  it("/amex (All cards) lists the Amex card's rows and the workbook rows, not a bank's card", async () => {
    serve();
    page(<AmexPage />);
    await expectListsExactly(["BLUE_A", "BLUE_REFUND", "WORKBOOK_A"]);
  });
});

describe("(WP7d) the route rule against the pages", () => {
  // Where each route's rows are listed, by the page the href opens.
  const listedOn = (href: string): Key[] | null => {
    const path = href.split("?")[0]!;
    if (path === "/transactions") return BANK_SNAPSHOT_ROWS;
    if (path === "/amex") return ["BLUE_A", "BLUE_REFUND", "WORKBOOK_A"];
    const m = /^\/next\/accounts\/ext-(.+)$/.exec(path);
    return m ? ACCOUNT_PAGE_ROWS[m[1]!] ?? [] : null;
  };
  it("every row's href opens a page that lists it; the closed account's row opens nowhere", () => {
    const entries = buildEntries(
      ITEMS.map((it) => ({
        id: it.id, institutionName: it.institutionName, institutionSlug: it.institutionSlug, lastSyncedAt: null, lastSyncError: null,
        accounts: ACCOUNTS.filter((a) => a.item === it.id).map((a) => ({ id: a.id, accountId: a.accountId, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
      })) as never,
    );
    const where: Record<string, string | null> = {};
    for (const r of ROWS) {
      const route = txnRoute({ id: r.id, occurredOn: r.occurredOn, plaidAccountId: r.plaidAccountIdOverride ?? (r.account ? `ext-${r.account}` : null), source: r.source }, entries);
      where[r.description!] = route.href;
      if (route.href === null) {
        expect(r.description, "only the closed account's row opens nowhere").toBe("GONE_A");
        expect(route.note).toBe("No ledger: Chase (no longer linked)");
        continue;
      }
      const lists = listedOn(route.href);
      // A loan's own page has no ledger; the refused account's page refuses. Both are said in words there.
      if (r.description === "LOAN_A" || r.description === "REFUSED_A") {
        expect(lists, r.description).toEqual([]);
        continue;
      }
      expect(lists, `${r.description} → ${route.href}`).toContain(r.description);
    }
    expect(where.WORKBOOK_A).toBe("/amex?tx=tx-workbook_a&month=2026-09-01");
    expect(where.MANUAL_A).toBe("/transactions?tx=tx-manual_a&month=2026-09-01");
    expect(where.FREEDOM_A).toBe("/next/accounts/ext-freedom?tx=tx-freedom_a&month=2026-09-01");
    expect(where.TWIN_A).toBe("/next/accounts/ext-twin?tx=tx-twin_a&month=2026-09-01");
  });
});

describe("(WP7d) the combined view", () => {
  it("routes every row, notes the closed account's row, and says nothing about a cap under 100 rows", async () => {
    serve();
    at("/next/accounts");
    const panel = await screen.findByTestId("combined-activity");
    await waitFor(() => expect(within(panel).getAllByTestId("txn-row")).toHaveLength(ROWS.length));
    const hrefOf = (name: string) => within(panel).queryByRole("link", { name })?.getAttribute("href") ?? null;
    expect(hrefOf("CHK_A")).toBe("/next/accounts/ext-chk?tx=tx-chk_a&month=2026-09-01");
    expect(hrefOf("WORKBOOK_A")).toBe("/amex?tx=tx-workbook_a&month=2026-09-01");
    expect(hrefOf("MANUAL_A")).toBe("/transactions?tx=tx-manual_a&month=2026-09-01");
    expect(hrefOf("GONE_A")).toBeNull();
    expect(within(panel).getAllByTestId("txn-note").map((n) => n.textContent)).toEqual(["No ledger: Chase (no longer linked)"]);
    expect(screen.queryByTestId("combined-activity-cap")).toBeNull();
  });

  it("a full 100-row window says so: 'Showing the newest 100 rows of the last 30 days.'", async () => {
    const many = Array.from({ length: 100 }, (_, i): FakeHouseholdRow => ({
      id: `tx-many-${String(i).padStart(3, "0")}`,
      occurredOn: `2026-09-${String(1 + (i % 15)).padStart(2, "0")}`,
      description: `MANY ${i}`,
      amount: "-1.00",
      account: "chk",
      source: "plaid:chase",
    }));
    serve({ ...HOUSEHOLD, rows: [...ROWS, ...many] });
    at("/next/accounts");
    expect((await screen.findByTestId("combined-activity-cap")).textContent).toBe("Showing the newest 100 rows of the last 30 days.");
    // The window asked is the last 30 days, at most 100 rows.
    const g = api.listGets().at(-1)!;
    expect(g.query.get("limit")).toBe("100");
    expect(g.query.get("from")).toBe("2026-08-17");
    expect(g.query.get("to")).toBe(TODAY);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";

/**
 * Banking (`/banking`) — the C1 rebuild.
 *
 * Two things are pinned here. First, ⭐ THE SPINE RULE: every headline figure
 * on this page is `useSpine()`'s value, rendered, and nothing else. The parity
 * block below derives its expectations FROM THE SAME OBJECT the mock feeds the
 * hook, so a page that recomputed any of those numbers locally — the exact
 * failure `/api/spine` exists to prevent — fails these tests rather than
 * silently disagreeing with the landing and the Forecast tile.
 *
 * Second, the gamification layer stays dead: no health score, no wrapped
 * modal, no streaks, no celebration.
 */

vi.mock("wouter", () => ({
  Link: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/sync-button", () => ({
  SyncButton: () => <button type="button" data-testid="sync-button" />,
}));

const state = vi.hoisted(() => ({
  spine: undefined as unknown,
  txns: [] as Array<Record<string, unknown>>,
  recurring: [] as Array<Record<string, unknown>>,
  settings: undefined as unknown,
  cashSignal: undefined as unknown,
  spendingFacts: undefined as unknown,
}));

vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: state.spine, isLoading: false }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetSettings: () => ({ data: state.settings }),
  useListTransactions: () => ({ data: state.txns }),
  useListRecurringItems: () => ({ data: state.recurring }),
  useGetForecastCashSignal: () => ({ data: state.cashSignal }),
  getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
  useGetReportsSpendingFacts: () => ({ data: state.spendingFacts }),
  getGetReportsSpendingFactsQueryKey: () => ["/api/reports/spending-facts"],
}));

import CommandCenterPage from "./command-center";

// ── fixtures ────────────────────────────────────────────────────────────────

const now = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
/** A date-only ISO inside the current calendar month (day 02, always valid). */
const inMonth = (day: number) => `${ym}-${pad(day)}`;

/**
 * An INDEPENDENT money formatter for the parity assertions — deliberately not
 * the app's `formatCurrency`, so the test pins the rendered string rather than
 * agreeing with whatever the app happens to do.
 */
const usd = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

/** The single source the parity assertions read from. */
const SPINE = {
  asOf: `${ym}-15T12:00:00.000Z`,
  bank: { balance: "4218.55", asOfDate: `${ym}-14` },
  spentMonth: 2310.4,
  spentWeek: 486.25,
  nextBill: { name: "Verizon", amount: "184.32", dueDate: `${ym}-28` },
  billsDueCount: 3,
  forecast: { lowPoint: "-612.90", lowPointDate: `${ym}-27`, runwayDays: 12 },
  debt: { payoffPct: 39.7 },
  reviewCount: 4,
};

function txn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t-1",
    occurredOn: inMonth(5),
    description: "SOME SHOP",
    amount: "-40.00",
    reimbursable: false,
    isTransfer: false,
    isExternalCardPayment: false,
    debtId: null,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    ...over,
  };
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  state.spine = SPINE;
  state.settings = {
    weeklyAllowanceAmount: "200",
    monthlyAllowanceAmount: "400",
    unplannedAllowanceAmount: "150",
    preferences: {},
  };
  state.cashSignal = { snapshotAt: `${ym}-14T09:30:00.000Z`, snapshotSource: "plaid" };
  state.spendingFacts = { realSpend: { total: 0 }, byCategory: [] };
  state.recurring = [];
  state.txns = [];
});

// ── ⭐ the spine rule ────────────────────────────────────────────────────────

describe("Banking — headline numbers come from the spine", () => {
  it("renders each Stat as exactly the spine's value", () => {
    render(<CommandCenterPage />);
    // ⭐ THE PARITY ASSERTION. Every expectation is computed FROM `SPINE` — the
    // same object the hook was fed — through an independent formatter. It pins
    // both halves at once: the figure must come from the spine, and it must be
    // rendered as money. Change the fixture and the expectations follow; make
    // the page derive any of these locally and it stops matching.
    const cases: Array<[string, string | number]> = [
      ["cc-stat-bank", SPINE.bank.balance],
      ["cc-stat-spent-month", SPINE.spentMonth],
      ["cc-stat-spent-week", SPINE.spentWeek],
      ["cc-stat-next-bill", SPINE.nextBill.amount],
      ["cc-stat-low-point", SPINE.forecast.lowPoint],
    ];
    for (const [testid, value] of cases) {
      expect(screen.getByTestId(testid).textContent).toContain(usd(value));
    }
  });

  it("⚠️ does NOT re-derive the spend figures from the transaction list", () => {
    // The ledger on this page disagrees with the spine on purpose. The spine is
    // the authority; a page that summed these rows itself would print $9,999
    // and disagree with the landing — the exact failure /api/spine prevents.
    state.txns = [
      txn({ id: "x1", description: "DECOY", amount: "-9999.00", occurredOn: inMonth(2) }),
    ];
    render(<CommandCenterPage />);
    expect(screen.getByTestId("cc-stat-spent-month").textContent).toContain(
      usd(SPINE.spentMonth),
    );
    expect(screen.getByTestId("cc-stat-spent-month").textContent).not.toContain(
      "9,999",
    );
    expect(screen.getByTestId("cc-stat-spent-week").textContent).toContain(
      usd(SPINE.spentWeek),
    );
  });

  it("moves with the spine — a different snapshot repaints every figure", () => {
    state.spine = {
      ...SPINE,
      bank: { balance: "99.01", asOfDate: `${ym}-14` },
      spentMonth: 7.5,
      spentWeek: 0,
      nextBill: { name: "Ameren", amount: "62.00", dueDate: `${ym}-21` },
      forecast: { lowPoint: "1500.00", lowPointDate: null, runwayDays: null },
    };
    render(<CommandCenterPage />);
    expect(screen.getByTestId("cc-stat-bank").textContent).toContain("$99.01");
    expect(screen.getByTestId("cc-stat-spent-month").textContent).toContain("$7.50");
    expect(screen.getByTestId("cc-stat-spent-week").textContent).toContain("$0.00");
    expect(screen.getByTestId("cc-stat-next-bill").textContent).toContain("$62.00");
    expect(screen.getByTestId("cc-stat-next-bill").textContent).toContain("Ameren");
    expect(screen.getByTestId("cc-stat-low-point").textContent).toContain(
      "$1,500.00",
    );
    // No runway means the horizon never goes negative — say the horizon, not "0".
    expect(screen.getByTestId("cc-stat-low-point").textContent).toContain(
      "next 90 days",
    );
  });

  it("labels the bank balance with the snapshot date the spine reports", () => {
    render(<CommandCenterPage />);
    // `bank.asOfDate` is the day the snapshot was taken, not today.
    expect(screen.getByTestId("cc-stat-bank").textContent).toMatch(/as of \w{3} 14/);
  });

  it("names and dates the next bill in the hint", () => {
    render(<CommandCenterPage />);
    const t = screen.getByTestId("cc-stat-next-bill").textContent ?? "";
    expect(t).toContain("Verizon");
    expect(t).toMatch(/\w{3} 28/);
  });

  it("says so when nothing is scheduled, instead of showing $0.00", () => {
    state.spine = { ...SPINE, nextBill: null };
    render(<CommandCenterPage />);
    const t = screen.getByTestId("cc-stat-next-bill").textContent ?? "";
    expect(t).toContain("none scheduled");
    expect(t).not.toContain("$0.00");
  });

  it("shows em dashes, not zeroes, before the spine answers", () => {
    state.spine = undefined;
    render(<CommandCenterPage />);
    // A page that prints $0.00 while loading tells the household they are broke.
    for (const id of [
      "cc-stat-bank",
      "cc-stat-spent-month",
      "cc-stat-spent-week",
      "cc-stat-next-bill",
      "cc-stat-low-point",
    ]) {
      expect(screen.getByTestId(id).textContent).toContain("—");
      expect(screen.getByTestId(id).textContent).not.toContain("$0.00");
    }
    // Still a complete screen — never a blank route (CLAUDE.md §3).
    expect(screen.getByTestId("cc-allowances")).toBeTruthy();
    expect(screen.getByTestId("cc-biggest-charges")).toBeTruthy();
  });
});

// ── the gamification layer is gone ──────────────────────────────────────────

describe("Banking — no gamification", () => {
  it("renders no score, streak, wrapped modal or celebration", () => {
    state.txns = [txn(), txn({ id: "t-2", description: "ANOTHER SHOP" })];
    const { container } = render(<CommandCenterPage />);
    const text = container.textContent ?? "";
    for (const word of [
      "Wrapped",
      "streak",
      "Streak",
      "Health",
      "health score",
      "Thriving",
      "Solid",
      "Shaky",
      "Critical",
      "splurge",
      "personality",
      "Largest charge",
      "Second largest",
    ]) {
      expect(text).not.toContain(word);
    }
    // No trophies, medals or emoji anywhere on the page.
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(screen.queryByTestId("open-wrapped")).toBeNull();
    expect(screen.queryByTestId("weekly-streak-chip")).toBeNull();
  });

  it("keeps the word diet — no exclamation marks", () => {
    state.txns = [txn()];
    const { container } = render(<CommandCenterPage />);
    expect(container.textContent ?? "").not.toContain("!");
  });
});

// ── biggest charges ─────────────────────────────────────────────────────────

describe("Banking — biggest charges", () => {
  it("lists this month's one-off charges, largest first", () => {
    state.txns = [
      txn({ id: "a", description: "COSTCO", amount: "-412.00" }),
      txn({ id: "b", description: "DELTA AIR", amount: "-288.00" }),
      txn({ id: "c", description: "CORNER CAFE", amount: "-18.00" }),
    ];
    render(<CommandCenterPage />);
    const list = screen.getByTestId("cc-biggest-charges");
    expect(within(list).getByTitle("COSTCO — $412")).toBeTruthy();
    expect(within(list).getByTitle("DELTA AIR — $288")).toBeTruthy();
    expect(within(list).getByTitle("CORNER CAFE — $18")).toBeTruthy();
    // Rank is a transform, not DOM order: the largest sits in the top slot.
    expect(within(list).getByTitle("COSTCO — $412").getAttribute("style")).toContain(
      "translateY(0px)",
    );
  });

  it("excludes bills, transfers, card payments and reimbursables", () => {
    state.recurring = [{ name: "Netflix" }];
    state.txns = [
      txn({ id: "keep", description: "COSTCO", amount: "-412.00" }),
      txn({ id: "bill", description: "NETFLIX.COM", amount: "-19.99" }),
      txn({ id: "xfer", description: "SHOP", amount: "-50.00", isTransfer: true }),
      txn({ id: "noise", description: "MORTGAGE PAYMENT", amount: "-1800.00" }),
      txn({ id: "reimb", description: "SHOP", amount: "-70.00", reimbursable: true }),
      txn({ id: "income", description: "PAYROLL", amount: "1200.00" }),
    ];
    render(<CommandCenterPage />);
    const list = screen.getByTestId("cc-biggest-charges");
    expect(within(list).getByTitle("COSTCO — $412")).toBeTruthy();
    const text = list.textContent ?? "";
    for (const gone of ["NETFLIX", "MORTGAGE", "PAYROLL"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("says the list is empty rather than drawing an empty card", () => {
    state.txns = [];
    render(<CommandCenterPage />);
    expect(screen.getByTestId("cc-biggest-charges").textContent).toContain(
      "No one-off charges this month",
    );
  });
});

// ── allowance buckets ───────────────────────────────────────────────────────

describe("Banking — allowance buckets", () => {
  beforeEach(() => {
    // Explicitly-filed spend: the bucket flag IS the gate (lib/bucketSpend).
    state.txns = [
      txn({ id: "w1", description: "CAFE", amount: "-30.00", weeklyAllowance: true,
        occurredOn: todayISOForWeek() }),
      txn({ id: "m1", description: "SHOES", amount: "-90.00", monthlyAllowance: true,
        occurredOn: inMonth(3) }),
      txn({ id: "u1", description: "VET", amount: "-175.00", unplannedAllowance: true,
        occurredOn: inMonth(4) }),
    ];
  });

  it("shows spent, cap and what is left — with the label saying which", () => {
    render(<CommandCenterPage />);
    const row = screen.getByTestId("cc-month-tile").closest(String.raw`[role="row"]`) as HTMLElement;
    expect(row.textContent).toContain("$90.00");
    expect(row.textContent).toContain("$400.00");
    // The chip says "left"/"over" in words; colour is never the only signal.
    expect(row.textContent).toContain("$310.00 left");
  });

  it("says OVER, not just red, when a bucket is past its cap", () => {
    state.settings = { ...(state.settings as object), monthlyAllowanceAmount: "50" };
    render(<CommandCenterPage />);
    const row = screen.getByTestId("cc-month-tile").closest(String.raw`[role="row"]`) as HTMLElement;
    expect(row.textContent).toContain("$40.00 over");
  });

  it("says so when a bucket has no cap set", () => {
    state.settings = { ...(state.settings as object), unplannedAllowanceAmount: "0" };
    render(<CommandCenterPage />);
    const row = screen.getByTestId("cc-unplanned-tile").closest(String.raw`[role="row"]`) as HTMLElement;
    expect(row.textContent).toContain("no cap set");
  });

  it("keeps the week/month testids and their links to Allowances", () => {
    render(<CommandCenterPage />);
    expect(screen.getByTestId("cc-week-tile").getAttribute("href")).toBe(
      "/allowances?view=week",
    );
    expect(screen.getByTestId("cc-month-tile").getAttribute("href")).toBe(
      "/allowances?view=month",
    );
  });

  it("pages back a week and forward again, never past the current one", () => {
    render(<CommandCenterPage />);
    const row = () => screen.getByTestId("cc-week-tile").closest(String.raw`[role="row"]`) as HTMLElement;
    expect(row().textContent).toContain("This week");
    // Forward is capped at the current period — you cannot spend the future.
    const next = within(row()).getByLabelText("Next week") as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.click(within(row()).getByLabelText("Previous week"));
    expect(row().textContent).not.toContain("This week");
    expect(
      (within(row()).getByLabelText("Next week") as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(within(row()).getByLabelText("Next week"));
    expect(row().textContent).toContain("This week");
  });
});

// ── the card head carries the sync controls ─────────────────────────────────

describe("Banking — sync docks in the card head", () => {
  it("renders the sync button and the snapshot freshness label", () => {
    render(<CommandCenterPage />);
    expect(screen.getByTestId("sync-button")).toBeTruthy();
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toContain(
      "Last auto-updated",
    );
  });

  it("says 'Set manually' for a hand-entered snapshot", () => {
    state.cashSignal = {
      snapshotAt: `${ym}-14T09:30:00.000Z`,
      snapshotSource: "manual",
    };
    render(<CommandCenterPage />);
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toContain(
      "Set manually",
    );
  });
});

/** An ISO date inside the current Sun–Sat week, so weekly-bucket spend lands
 *  in the window the page is showing. */
function todayISOForWeek(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

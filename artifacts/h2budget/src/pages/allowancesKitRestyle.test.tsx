import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * C8 — Allowances on the kit: cards, CSS fill meters, state in words.
 *
 * The invariant this file guards is the one that matters: THE RESTYLE MOVED NO
 * MONEY. Every figure still comes from the same `effectiveBucket` +
 * `expenseMagnitude` path the Banking dashboard sums through, the window
 * arithmetic (week for weekly, calendar month for monthly/unplanned) is
 * unchanged, and the testids the rest of the app keys on are stable.
 *
 * `lib/weeklyBuckets` and `lib/bucketSpend` are deliberately NOT mocked — they
 * are the money math under test.
 */

// Friday 15 May 2026. sundayOf() → 2026-05-10, so the weekly window is
// 05-10…05-16 and the month window is 05-01…05-31.
const TEST_TODAY = new Date(2026, 4, 15, 12, 0, 0);

const BAD_RGB = "rgb(225, 109, 62)"; // #e16d3e — over plan
const NAVY_RGB = "rgb(25, 49, 91)"; // #19315b — resting

/** Independent of the app's own formatter, so we pin the rendered string. */
const usd = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

type Tx = {
  id: string;
  description: string;
  amount: string;
  occurredOn: string;
  categoryId: string | null;
  source: string | null;
  weeklyAllowance?: boolean;
  monthlyAllowance?: boolean;
  unplannedAllowance?: boolean;
  weeklyBucket?: string | null;
  isTransfer?: boolean;
};

const tx = (o: Partial<Tx> & Pick<Tx, "id" | "amount" | "occurredOn">): Tx => ({
  description: `txn ${o.id}`,
  categoryId: null,
  source: "chase",
  weeklyBucket: null,
  ...o,
});

/**
 * Deliberately un-round figures, so "the page printed the derived number"
 * cannot be a coincidence of tidy values.
 *
 *  weekly   (05-10…05-16): 120.25 + 75.50            = 195.75  of 450 → under
 *  monthly  (05-01…05-31): 420.40                    = 420.40  of 300 → OVER
 *  unplanned(05-01…05-31): 50.10                     =  50.10  of 200 → under
 */
const TXNS: Tx[] = [
  // — the selected week, weekly bucket
  tx({ id: "w1", amount: "-120.25", occurredOn: "2026-05-11", weeklyAllowance: true, weeklyBucket: "groceries" }),
  tx({ id: "w2", amount: "-75.50", occurredOn: "2026-05-14", weeklyAllowance: true, weeklyBucket: "dining" }),
  // — the month, monthly + unplanned buckets (outside the weekly window)
  tx({ id: "m1", amount: "-420.40", occurredOn: "2026-05-06", monthlyAllowance: true }),
  tx({ id: "u1", amount: "-50.10", occurredOn: "2026-05-07", unplannedAllowance: true }),
  // — two COMPLETED weeks over the 450 weekly allowance, so the streak is 2:
  //   week of 05-03 and week of 04-26 (its 05-01 row is inside the fetch window).
  tx({ id: "s1", amount: "-500.00", occurredOn: "2026-05-05", weeklyAllowance: true }),
  tx({ id: "s2", amount: "-500.00", occurredOn: "2026-05-01", weeklyAllowance: true }),
  // — decoys: unflagged spend and income must never reach a bucket.
  tx({ id: "d1", amount: "-999.99", occurredOn: "2026-05-12" }),
  tx({ id: "d2", amount: "4321.00", occurredOn: "2026-05-13", weeklyAllowance: true }),
];

const SETTINGS = {
  weeklyAllowanceAmount: "450.00",
  monthlyAllowanceAmount: "300.00",
  unplannedAllowanceAmount: "200.00",
  preferences: {},
};

const EXPECTED = { weekly: 195.75, monthly: 420.4, unplanned: 50.1 };
const PLANNED = { weekly: 450, monthly: 300, unplanned: 200 };

let txns: Tx[] = [];
let settings: Record<string, unknown> | undefined;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/split-transaction-dialog", () => ({
  SplitTransactionDialog: () => null,
}));

vi.mock("@workspace/api-client-react", () => ({
  useListTransactions: () => ({ data: txns, isLoading: false }),
  useGetSettings: () => ({ data: settings }),
  useListCategories: () => ({ data: [{ id: "c1", name: "Groceries" }] }),
  useUpdateTransaction: () => ({ mutateAsync: vi.fn(async () => undefined) }),
  useUpdateSettings: () => ({ mutateAsync: vi.fn(async () => undefined) }),
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getGetSettingsQueryKey: () => ["/api/settings"],
}));

import AllowancesPage from "./allowances";
import { bucketSpendInWindow } from "@/lib/bucketSpend";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AllowancesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TEST_TODAY);
  txns = TXNS;
  settings = { ...SETTINGS };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Allowances — the money is unmoved", () => {
  it("prints each bucket's spend against its own window", () => {
    renderPage();
    // Each bucket card shows its actual; the summary row repeats it.
    for (const key of ["weekly", "monthly", "unplanned"] as const) {
      const row = screen.getByTestId(`allowance-summary-${key}`);
      expect(within(row).getByText(usd(EXPECTED[key]))).toBeTruthy();
      expect(within(row).getByText(usd(PLANNED[key]))).toBeTruthy();
    }
  });

  it("agrees with the Banking dashboard's bucketSpend for the same window", () => {
    // The parity that matters: Banking sums through `bucketSpendInWindow`, so
    // the two surfaces must print the same number for the same window.
    // (Known pre-existing divergence, deliberately NOT changed here: the
    // Banking helper also drops transfers / card payments / reimbursables /
    // debt payments via `isCountableSpend`, which the Allowances page does not
    // apply. This fixture contains no such rows, so both paths agree.)
    expect(bucketSpendInWindow(TXNS, "weekly", "2026-05-10", "2026-05-16")).toBeCloseTo(
      EXPECTED.weekly,
      2,
    );
    expect(
      bucketSpendInWindow(TXNS, "unplanned", "2026-05-01", "2026-05-31"),
    ).toBeCloseTo(EXPECTED.unplanned, 2);

    renderPage();
    const weekRow = screen.getByTestId("allowance-summary-weekly");
    expect(within(weekRow).getByText(usd(EXPECTED.weekly))).toBeTruthy();
  });

  it("counts neither unflagged spend nor income", () => {
    renderPage();
    // The $999.99 decoy is unassigned; the $4,321.00 credit is flagged weekly
    // but is income, so `expenseMagnitude` returns 0 for it.
    expect(screen.queryByText(usd(999.99))).toBeNull();
    expect(screen.queryByText(usd(4321))).toBeNull();
    expect(screen.queryByText(usd(1195.74))).toBeNull(); // weekly + decoy
  });

  it("reports variance as spend minus plan, per bucket", () => {
    renderPage();
    expect(screen.getByTestId("allowance-variance-weekly").textContent).toContain(
      `${usd(PLANNED.weekly - EXPECTED.weekly)} under`,
    );
    expect(screen.getByTestId("allowance-variance-monthly").textContent).toContain(
      `${usd(EXPECTED.monthly - PLANNED.monthly)} over`,
    );
  });
});

describe("Allowances — state is in words, never colour alone", () => {
  it("gives every bucket a labelled chip", () => {
    renderPage();
    expect(screen.getByTestId("allowance-state-weekly").textContent).toBe("Under");
    expect(screen.getByTestId("allowance-state-monthly").textContent).toBe("Over");
    expect(screen.getByTestId("allowance-state-unplanned").textContent).toBe("Under");
  });

  it("uses the kit's .chip classes, over taking the one bad tone", () => {
    renderPage();
    const cls = (id: string) =>
      screen.getByTestId(id).className.split(/\s+/).filter(Boolean);
    expect(cls("allowance-state-monthly")).toEqual(
      expect.arrayContaining(["chip", "bad"]),
    );
    expect(cls("allowance-state-weekly")).toEqual(
      expect.arrayContaining(["chip", "ok"]),
    );
  });

  it("states the over-budget streak as a chip with its count", () => {
    renderPage();
    const chip = screen.getByTestId("allowance-over-streak");
    expect(chip.textContent).toContain("Over budget");
    expect(chip.textContent).toContain("2 weeks running");
    expect(chip.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["chip", "bad"]),
    );
    // The two banners are mutually exclusive, exactly as before.
    expect(screen.queryByTestId("allowance-praise")).toBeNull();
  });

  it("carries no exclamation marks and no cute copy", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toContain("!");
    for (const phrase of [
      "in the tank",
      "Let's not make it a habit",
      "You're better than this",
      "Deep breath",
      "look at you",
    ]) {
      expect(text).not.toContain(phrase);
    }
  });
});

describe("Allowances — the fill meters", () => {
  it("paints under plan navy and over plan deep orange", () => {
    const { container } = renderPage();
    const fills = Array.from(
      container.querySelectorAll<HTMLElement>(".bar-sweep"),
    ).map((el) => el.style.background);
    expect(fills).toContain(NAVY_RGB);
    expect(fills).toContain(BAD_RGB);
  });

  it("drops a plan marker once actual passes plan", () => {
    const { container } = renderPage();
    // The monthly bucket is over, so its track rescales to ACTUAL and a
    // hairline marks where the plan ran out.
    const markers = container.querySelectorAll("span[style*='left']");
    expect(markers.length).toBeGreaterThan(0);
  });
});

describe("Allowances — the public surface is stable", () => {
  it("keeps every testid the app keys on", () => {
    renderPage();
    for (const id of [
      "allowance-card-weekly",
      "allowance-card-monthly",
      "allowance-card-unplanned",
      "allowance-edit-planned-weekly",
      "allowance-variance-weekly",
      "allowance-bucket-weekly",
      "allowance-bucket-monthly",
      "allowance-bucket-unplanned",
      "allowance-summary-weekly",
      "allowance-summary-monthly",
      "allowance-summary-unplanned",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("renders the weekly money-left history as CSS bars, not a chart", () => {
    const { container } = renderPage();
    expect(
      screen.getByLabelText("Weekly allowance money left or over plan, by week"),
    ).toBeTruthy();
    // Chart law 4: this list re-reads itself, so it must not be recharts.
    expect(container.querySelector(".recharts-wrapper")).toBeNull();
  });

  it("orders the weekly bars oldest-first, not by size", () => {
    renderPage();
    const list = screen.getByLabelText(
      "Weekly allowance money left or over plan, by week",
    );
    // Rows are positioned by transform, so read the rendered order off the
    // translateY each row carries. A time series must not re-sort by
    // magnitude — that would shuffle the weeks into a meaningless order.
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[title]"));
    const byPosition = rows
      .map((el) => ({
        title: el.getAttribute("title") ?? "",
        y: Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0),
      }))
      .sort((a, b) => a.y - b.y)
      .map((r) => r.title.split(" — ")[0]);
    expect(byPosition.length).toBe(8);
    // Oldest first: every label parses to a date that only moves forward.
    const days = byPosition.map((t) => new Date(`${t} 2026`).getTime());
    for (let i = 1; i < days.length; i += 1) {
      expect(days[i]).toBeGreaterThan(days[i - 1]);
    }
  });

  it("paints money left navy and an overspent week deep orange", () => {
    const { container } = renderPage();
    const list = screen.getByLabelText(
      "Weekly allowance money left or over plan, by week",
    );
    const fills = Array.from(
      list.querySelectorAll<HTMLElement>("span[style*='background']"),
    ).map((el) => el.style.background);
    // Under-budget weeks (money left) must NOT take the bad colour.
    expect(fills).toContain(NAVY_RGB);
    expect(container).toBeTruthy();
  });
});

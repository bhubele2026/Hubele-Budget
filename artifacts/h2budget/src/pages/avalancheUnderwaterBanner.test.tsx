import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { SimResult, UnderwaterDebt } from "@/lib/avalanche";

// Radix Slider relies on ResizeObserver, which jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const updateSettingsMutate = vi.fn();

let currentSettings: {
  strategy: string;
  manualExtra: string;
  extraSource: string;
  budgetMode: string;
  extraBudgetCategoryId: string | null;
} = {
  strategy: "avalanche",
  manualExtra: "0",
  extraSource: "manual",
  budgetMode: "budgeted",
  extraBudgetCategoryId: null,
};

let currentResolvedExtra: {
  amount: string;
  source: string;
  availableMoney: number;
  mode?: string;
  monthStart?: string;
  breakdown?: Record<string, unknown>;
} = {
  amount: "0",
  source: "manual",
  availableMoney: 0,
};

let currentSim: SimResult = {
  months: [],
  monthsToFreedom: 0,
  debtFreeDate: null,
  totalInterestPaid: 0,
  startingTotalBalance: 0,
  startingTotalMin: 0,
  killedOrder: [],
  ranOutOfTime: false,
  underwater: [],
};

vi.mock("wouter", () => ({
  useSearch: () => "",
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
  DebtReauthBanner: () => null,
}));

// Recharts pulls in ResizeObserver / canvas APIs that jsdom lacks. The chart
// tab isn't what we're testing, so stub it out.
vi.mock("recharts", () => ({
  LineChart: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: () => null,
  Legend: () => null,
}));

vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = {
    mutate: noop,
    mutateAsync: asyncNoop,
    isPending: false,
  };
  return {
    useListDebts: () => ({ data: [], isLoading: false }),
    useCreateDebt: () => mutation,
    useUpdateDebt: () => mutation,
    useDeleteDebt: () => mutation,
    useGetAvalancheSettings: () => ({ data: currentSettings }),
    useUpdateAvalancheSettings: () => ({
      ...mutation,
      mutate: updateSettingsMutate,
    }),
    useSyncDebtMinimums: () => mutation,
    useGetAvalancheExtra: () => ({ data: currentResolvedExtra }),
    useCreateDebtPayment: () => mutation,
    useListCategories: () => ({ data: [] }),
    useGetSettings: () => ({ data: undefined }),
    getListDebtsQueryKey: () => ["debts"],
    getGetAvalancheSettingsQueryKey: () => ["av-settings"],
    getGetAvalancheExtraQueryKey: () => ["av-extra"],
  };
});

// Mock the avalanche lib so we control `sim.underwater` exactly. We still
// re-export the real formatter / sort helpers so the page renders normally.
vi.mock("@/lib/avalanche", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/avalanche")>("@/lib/avalanche");
  return {
    ...actual,
    simulate: () => currentSim,
    // The page now uses the shared solvable-subset helper. Mocked here so
    // these underwater-banner tests can still drive `sim.underwater`
    // exactly via `currentSim` regardless of the helper's internal logic.
    simulateWithSolvableFallback: () => ({
      sim: currentSim,
      usingSolvableSubset: false,
      effectiveDebts: [],
      excludedUnderwaterCount: 0,
    }),
  };
});

import AvalanchePage from "./avalanche";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AvalanchePage />
    </QueryClientProvider>,
  );
}

function makeUnderwaterSim(underwater: UnderwaterDebt[]): SimResult {
  return {
    months: [],
    monthsToFreedom: Infinity,
    debtFreeDate: null,
    totalInterestPaid: 0,
    startingTotalBalance: 0,
    startingTotalMin: 0,
    killedOrder: [],
    ranOutOfTime: true,
    underwater,
  };
}

beforeEach(() => {
  cleanup();
  updateSettingsMutate.mockReset();
  currentSettings = {
    strategy: "avalanche",
    manualExtra: "0",
    extraSource: "manual",
    budgetMode: "budgeted",
    extraBudgetCategoryId: null,
  };
  currentResolvedExtra = {
    amount: "0",
    source: "manual",
    availableMoney: 0,
  };
  currentSim = {
    months: [],
    monthsToFreedom: 0,
    debtFreeDate: null,
    totalInterestPaid: 0,
    startingTotalBalance: 0,
    startingTotalMin: 0,
    killedOrder: [],
    ranOutOfTime: false,
    underwater: [],
  };
});

describe("Avalanche underwater banner — sanitization", () => {
  it("never renders $∞, NaN, or absurd interest figures for broken underwater entries", () => {
    currentSim = makeUnderwaterSim([
      {
        id: "infinity-debt",
        name: "Boundless Card",
        apr: Infinity,
        balance: 1000,
        minPayment: 50,
        monthlyInterest: Infinity,
        shortfallPerMonth: Infinity,
      },
      {
        id: "nan-debt",
        name: "Mystery Loan",
        apr: NaN,
        balance: 1000,
        minPayment: NaN,
        monthlyInterest: NaN,
        shortfallPerMonth: NaN,
      },
      {
        id: "huge-debt",
        name: "Huge Loan",
        apr: 0.5,
        balance: 1_000_000_000,
        minPayment: 10,
        // 9+ digit interest figure — must not leak into the DOM verbatim.
        monthlyInterest: 41_666_666.67,
        shortfallPerMonth: 41_666_666.57,
      },
    ]);

    renderPage();

    const banner = screen.getByTestId("banner-underwater");
    const text = banner.textContent ?? "";

    // Headline still announces all 3 debts.
    expect(text).toContain("3 debts are underwater");

    // The bug: rendering Infinity/NaN as currency or letting an absurd
    // interest figure flow into the DOM. None of these should appear.
    expect(text).not.toContain("$∞");
    expect(text).not.toContain("∞");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("$NaN");

    // The 9-digit raw interest figure must not appear as a number anywhere
    // in the banner — it's a sentinel that the >$1M cap kicked in.
    expect(text).not.toMatch(/41[,.]?666[,.]?666/);
    // No suspiciously long digit run (≥ 8 contiguous digits) should reach
    // the banner — the cap should swap it for an em-dash.
    expect(text).not.toMatch(/\d{8,}/);

    // Each broken row uses an em-dash placeholder for coverage / min when
    // the underlying numbers aren't usable.
    const dashCount = (text.match(/—/g) ?? []).length;
    expect(dashCount).toBeGreaterThanOrEqual(2);

    // The well-formed names are still listed.
    expect(text).toContain("Boundless Card");
    expect(text).toContain("Mystery Loan");
    expect(text).toContain("Huge Loan");
  });

  it("renders a real coverage % for a normal underwater debt", () => {
    currentSim = makeUnderwaterSim([
      {
        id: "real-debt",
        name: "Visa Classic",
        apr: 0.29,
        balance: 5000,
        minPayment: 50,
        monthlyInterest: 120.83,
        shortfallPerMonth: 70.83,
      },
    ]);

    renderPage();

    const banner = screen.getByTestId("banner-underwater");
    const text = banner.textContent ?? "";
    expect(text).toContain("1 debt is underwater");
    expect(text).toContain("Visa Classic");
    // 50 / 120.83 ≈ 41% — let the rounding land on either 41 or 42.
    expect(text).toMatch(/~4[12]% of interest/);
    expect(text).toContain("$50.00");
  });
});

describe("Avalanche manual-extra slider — clamping", () => {
  it("clamps a stale $50,000 manualExtra to the $5,000 cap and pins the slider max", () => {
    // Saved value way above the cap (the bug: slider could end up rendering
    // far past $5k or even sliding to the user's full availableMoney).
    currentSettings = {
      ...currentSettings,
      manualExtra: "50000",
    };
    currentResolvedExtra = {
      amount: "50000",
      source: "manual",
      // Plenty of headroom — the slider must NOT widen to match.
      availableMoney: 100_000,
    };

    renderPage();

    const slider = document.querySelector(
      '[data-testid="banner-underwater"] ~ * [role="slider"], [role="slider"]',
    ) as HTMLElement | null;
    expect(slider).not.toBeNull();

    // Radix slider exposes its value via aria-valuenow / valuemax.
    expect(slider!.getAttribute("aria-valuemax")).toBe("5000");
    expect(slider!.getAttribute("aria-valuenow")).toBe("5000");
    expect(slider!.getAttribute("aria-valuemin")).toBe("0");

    // The cap label is rendered next to the slider, regardless of the much
    // larger availableMoney value. Since the live readout splits the value
    // and the cap across spans, match against the combined text content.
    const liveLabel = screen.getByTestId("text-avalanche-budget-live");
    expect(liveLabel.textContent ?? "").toContain("$5,000.00/mo");
    // availableMoney = $100k must NOT appear as a slider ceiling label.
    expect(liveLabel.textContent ?? "").not.toContain("$100,000.00");
  });

  it("keeps the slider max at $5,000 even when availableMoney is tiny", () => {
    currentSettings = {
      ...currentSettings,
      manualExtra: "200",
    };
    currentResolvedExtra = {
      amount: "200",
      source: "manual",
      availableMoney: 100, // Less than even the current manualExtra.
    };

    renderPage();

    const slider = document.querySelector('[role="slider"]') as HTMLElement | null;
    expect(slider).not.toBeNull();
    expect(slider!.getAttribute("aria-valuemax")).toBe("5000");
    expect(slider!.getAttribute("aria-valuenow")).toBe("200");
  });
});

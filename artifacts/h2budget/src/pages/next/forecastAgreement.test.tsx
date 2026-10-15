import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

// (C13) Links keep their props (test ids, roles): the screen's view tabs are links.
vi.mock("wouter", () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => <a {...rest}>{children}</a>,
}));

vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));

vi.mock("@/components/ui/tabs", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Tabs: Passthrough,
    TabsList: Passthrough,
    TabsTrigger: Passthrough,
    TabsContent: Passthrough,
  };
});

vi.mock("@dnd-kit/core", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    DndContext: Passthrough,
    DragOverlay: Passthrough,
    PointerSensor: function () {},
    TouchSensor: function () {},
    useSensor: () => ({}),
    useSensors: () => [],
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      isDragging: false,
    }),
    useDroppable: () => ({
      setNodeRef: () => {},
      isOver: false,
    }),
  };
});


// Recharts is stubbed: the AreaChart stub records its rows and renders one
// button per row that fires the chart's own onClick({ activeLabel }), so a test
// can "tap a day" without a layout engine.
let chartRows: Array<Record<string, unknown>> = [];
vi.mock("recharts", () => {
  const Stub = ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <div data-testid={(rest as { "data-testid"?: string })["data-testid"]}>{children}</div>
  );
  const RefStub = ({ children, x, y, ...rest }: { children?: React.ReactNode; x?: string | number; y?: string | number; [k: string]: unknown }) => (
    <div
      data-testid={(rest as { "data-testid"?: string })["data-testid"]}
      data-x={x !== undefined ? String(x) : undefined}
      data-y={y !== undefined ? String(y) : undefined}
    >
      {children}
    </div>
  );
  const AreaChart = ({ children, data, onClick }: { children?: React.ReactNode; data?: Array<Record<string, unknown>>; onClick?: (s: unknown) => void }) => {
    chartRows = data ?? [];
    return (
      <div data-testid="area-chart">
        {(data ?? []).map((d) => (
          <button key={String(d.rawDate)} type="button" data-testid={`tap-${d.rawDate}`} onClick={() => onClick?.({ activeLabel: d.rawDate })} />
        ))}
        {children}
      </div>
    );
  };
  const Label = ({ value }: { value?: React.ReactNode }) => <span>{value}</span>;
  return {
    ResponsiveContainer: Stub, AreaChart, Area: Stub, XAxis: Stub, YAxis: Stub, CartesianGrid: Stub,
    Tooltip: Stub, ReferenceLine: RefStub, ReferenceDot: RefStub, ReferenceArea: RefStub, Label,
  };
});

const FORECAST_BASE = {
  fromDate: "2026-05-01", toDate: "2026-08-01", events: [], transactions: [], resolutions: [],
  closedMonths: [], monthSnapshots: {}, bankSnapshot: null, plaidCheckingAccounts: [],
  settings: { startingBalance: "1000", cashBuffer: "500" },
};
const SIGNAL = {
  status: "ok", startingBalance: "1000", endingBalance: "1200", endingDate: "2026-06-20", toDate: "2026-06-20",
  fromDate: "2026-06-10", acceptedImpact: "200", projectedIncome: "2000", projectedExpenses: "800",
  lowestProjected: "250.5", lowestDate: "2026-06-15", cashBuffer: "500", horizonDays: 30,
  daily: [
    { date: "2026-06-10", balance: "1000" },
    { date: "2026-06-15", balance: "250.5" },
    { date: "2026-06-20", balance: "2250.5" },
  ],
  events: [
    { date: "2026-06-15", label: "Rent", amount: "-800", itemId: "rent", originalDate: "2026-06-10", occurrenceDate: "2026-06-10" },
    { date: "2026-06-20", label: "Paycheck", amount: "2000", itemId: "pay" },
  ],
};
/**
 * ⭐ (T3) A signal whose figures tie the way the server's do (the walk): start
 * 1,000.00; 06-10 a −25.00 bank row → 975.00; 06-15 Rent −800.00 (carried from
 * 06-10) and a +50.50 matched bank row → 225.50; 06-20 Paycheck +2,000.00 →
 * 2,225.50. In 2,050.50 · out 825.00 · end 2,225.50. Plus the three lists the
 * server returns beside the curve.
 */
const SIGNAL_T3 = {
  status: "not_yet", startingBalance: "1000.00", endingBalance: "2225.50", endingDate: "2026-06-20", toDate: "2026-06-20",
  fromDate: "2026-06-10", acceptedImpact: "50.50", projectedIncome: "2050.50", projectedExpenses: "825.00",
  lowestProjected: "225.50", lowestDate: "2026-06-15", cashBuffer: "500.00", horizonDays: 30, bankToday: "1000.00",
  snapshotAt: "2026-06-10T12:00:00.000Z",
  account: { rowId: "acct-row-1", externalId: "ext-1", name: "Test Checking", mask: "0000", subtype: "checking", via: "pointer" },
  daily: [
    { date: "2026-06-10", balance: "975.00" },
    { date: "2026-06-15", balance: "225.50" },
    { date: "2026-06-20", balance: "2225.50" },
  ],
  events: [
    { date: "2026-06-15", label: "Rent", amount: "-800.00", itemId: "rent", originalDate: "2026-06-10", occurrenceDate: "2026-06-10", occurrenceKey: "rent|2026-06-10", assumption: "overdue_assumed_unpaid" },
  ],
  dayItems: [
    { date: "2026-06-10", kind: "bank_row", amount: "-25.00", txnId: "t-coffee", matched: false },
    { date: "2026-06-15", kind: "expense", amount: "-800.00", label: "Rent", itemId: "rent", originalDate: "2026-06-10", occurrenceDate: "2026-06-10", occurrenceKey: "rent|2026-06-10", assumption: "overdue_assumed_unpaid" },
    { date: "2026-06-15", kind: "bank_row", amount: "50.50", txnId: "t-refund", matched: true },
    { date: "2026-06-20", kind: "income", amount: "2000.00", label: "Paycheck", itemId: "pay", originalDate: "2026-06-20", occurrenceDate: "2026-06-20", occurrenceKey: "pay|2026-06-20", assumption: null },
  ],
  matches: [],
  overdueAssumedPaid: [
    { planKey: "water|2026-06-05", itemId: "water", occurrenceDate: "2026-06-05", dueDate: "2026-06-05", label: "Water", daysOverdue: 5, planAmount: "-60.00", txnId: "t-water", txnAmount: "-60.00", confidence: "high", unpaidRemainder: "0.00" },
  ],
  overdueOutsideForecast: [
    { planKey: "gym|2026-05-01", itemId: "gym", occurrenceDate: "2026-05-01", dueDate: "2026-05-01", amount: "-40.00", label: "Gym", daysOverdue: 40 },
  ],
  incomeNotArrived: [
    { planKey: "bonus|2026-06-01", itemId: "bonus", occurrenceDate: "2026-06-01", dueDate: "2026-06-01", amount: "300.00", label: "Bonus", daysOverdue: 9 },
  ],
};
let cashSignal: unknown = SIGNAL;
vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({ mutate: () => {}, mutateAsync: async () => undefined, isPending: false });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: FORECAST_BASE, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: cashSignal, isLoading: false }),
    useUpsertForecastResolution: noopMutation, useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation, useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation, useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation, useRefreshForecastBank: noopMutation,
    useListCategories: () => empty, useListDebts: () => empty, useListRecurringItems: () => empty,
    useGetAvalancheSettings: () => ({ data: undefined }), useGetAvalancheExtra: () => ({ data: undefined }),
    useCreateRecurringItem: noopMutation,
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    getGetForecastQueryKey: () => ["forecast"], getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
  };
});
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: undefined, isLoading: false, isFetching: false, state: "cold", error: null, updatedAt: null, refetch: () => {} }),
}));

import { waitFor } from "@testing-library/react";
import { householdToday } from "@/lib/householdDay";
import ForecastPage from "../forecast";
import NextForecastPage from "./Forecast";
import { ForecastBody } from "../forecast/ForecastBody";
import type { ForecastNextCtx } from "./forecast/types";

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const money = (el: HTMLElement) => (el.textContent ?? "").match(/-?\$[\d,]+(?:\.\d+)?/g) ?? [];
const KPIS = ["kpi-lowest-point", "kpi-ending-balance", "kpi-projected-income", "kpi-projected-expenses"];

beforeEach(() => {
  cleanup();
  cashSignal = SIGNAL;
  chartRows = [];
  try { sessionStorage.clear(); } catch { /* no-op */ }
  // (T3) The selected day is URL state (`?day=`): each test starts on a clean address.
  window.history.replaceState(null, "", "/");
});

describe("/next/forecast agrees with the classic page", () => {
  it("shows the same summary figures, chart points, past-due rows and day figures from the same data", () => {
    const classic = mount(<ForecastPage />);
    const classicFigures = Object.fromEntries(KPIS.map((k) => [k, money(within(classic.container).getByTestId(k))]));
    const classicPastDue = within(classic.container).getByTestId("dragging-plans-list").textContent;
    cleanup();

    mount(<NextForecastPage />);
    for (const k of KPIS) expect(money(screen.getByTestId(k))).toEqual(classicFigures[k]);

    // Chart points are the cash signal's own daily rows, in order.
    expect(chartRows.map((r) => [r.rawDate, r.balance])).toEqual(
      SIGNAL.daily.map((d) => [d.date, Number(d.balance)]),
    );

    // Past-due register row: same list on the new page's "Month & bank" tab.
    fireEvent.click(screen.getByTestId("tab-plan"));
    expect(screen.getByTestId("dragging-plans-list").textContent).toBe(classicPastDue);

    // The selected day: close = the chart point, rent = the register row, pay = the event.
    fireEvent.click(screen.getByTestId("tap-2026-06-15"));
    expect(screen.getByTestId("day-close").textContent).toBe("$250.50");
    expect(screen.getByTestId("day-opening").textContent).toBe("$1,000.00");
    expect(screen.getByTestId("day-out-bill").textContent).toBe("-$800.00");
    expect(screen.getByTestId("day-event-rent").textContent).toContain("Rent");
    expect(screen.getByTestId("dragging-plan-rent-2026-06-10")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tap-2026-06-20"));
    expect(screen.getByTestId("day-income").textContent).toBe("$2,000.00");
  });

  it("keeps the selected day across a refetch and a horizon change, and says when it left the window", () => {
    const view = mount(<NextForecastPage />);
    fireEvent.click(screen.getByTestId("tap-2026-06-15"));
    expect(screen.getByTestId("day-panel-date")).toBeTruthy();

    fireEvent.click(screen.getByTestId("horizon-90"));
    expect(screen.getByTestId("day-close").textContent).toBe("$250.50");

    // A refetch brings a window that no longer holds that day.
    cashSignal = { ...SIGNAL, daily: SIGNAL.daily.filter((d) => d.date !== "2026-06-15") };
    fireEvent.click(screen.getByTestId("horizon-120"));
    expect(screen.getByTestId("day-outside-window")).toBeTruthy();
    expect(screen.getByTestId("day-close").textContent).toBe("—");
    view.unmount();
  });

  it("clears the selection with Escape and moves it with the arrow keys", () => {
    mount(<NextForecastPage />);
    const surface = screen.getByTestId("chart-surface");
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(screen.getByTestId("day-panel-date").textContent).toContain("Jun 10");
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(screen.getByTestId("day-panel-date").textContent).toContain("Jun 15");
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(screen.getByTestId("day-panel-empty")).toBeTruthy();
  });

  it("lists every marker kind in the legend and tints risk days", () => {
    mount(<NextForecastPage />);
    for (const k of ["payday", "bill", "card", "debt", "under-buffer", "below-zero"]) {
      expect(screen.getByTestId(`legend-${k}`)).toBeTruthy();
    }
    expect(screen.getAllByTestId("risk-below-buffer").length).toBeGreaterThan(0);
  });
});

describe("/forecast and /review are the one forecast screen (C13)", () => {
  /**
   * The routes render `ForecastBody` over the page's own sections: a sticky
   * head (title, Help, Bills, Settings, horizons) that publishes
   * `--page-sticky-top`; the hero with its footnotes beside the summary
   * figures; the expanded chart with the classic big-bill markers; the
   * register panel (sticky-safe, so the review inbox pins to <main>) whose
   * two views are the two routes; the selected day and the date balance.
   */
  it("/forecast: the 'Month & bank' view, with the head, hero, figures, chart markers and date balance", () => {
    mount(<ForecastPage mode="overall" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Forecast");
    const head = screen.getByTestId("forecast-sticky-head");
    expect(head.className).toMatch(/page-sticky-head z-30 .*md:sticky md:top-0/);
    expect(within(head).getByTestId("link-manage-bills")).toBeTruthy();
    expect(within(head).getByTestId("horizon-30")).toBeTruthy();
    expect(screen.getByTestId("forecast-screen").style.getPropertyValue("--page-sticky-top")).toMatch(/px$/);

    // FC-20: the headline and its footnotes, from the same signal.
    expect(screen.getByTestId("hero-forecast-balance").textContent).toBe("$1,200.00");
    expect(screen.getByText(/^Matched impact/).textContent).toContain("$200.00");
    expect(screen.getByTestId("forecast-kpis")).toBeTruthy();

    // FC-28: the classic big-bill marker is on the screen's chart (rent, $800).
    expect(screen.getByTestId("big-bill-marker-2026-06-15")).toBeTruthy();

    // The register panel: sticky-safe; the views are links to the two routes
    // in a nav (aria-current marks this route's), not tabs: no role="tab",
    // and no aria-controls pointing at a pane that is not on the page.
    const panel = screen.getByTestId("register-panel");
    expect(panel.className).toContain("panel-sticky-safe");
    expect(screen.getByTestId("tab-plan").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("tab-register").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("tab-register").tagName).toBe("A");
    expect(screen.getByTestId("tab-register").getAttribute("href")).toBe("/review");
    expect(screen.getByRole("navigation", { name: "Register views" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(document.querySelector('[aria-controls^="register-pane"]')).toBeNull();
    // The overall view holds the past-due card AND the planned list (FC-24, FC-49).
    expect(within(panel).getByTestId("dragging-plans-list")).toBeTruthy();
    expect(within(panel).getByRole("heading", { name: "Planned items" })).toBeTruthy();

    // FC-23: the balance on a chosen date, beside the selected day.
    const side = screen.getByTestId("selected-day-panel").parentElement!;
    expect(within(side).getByTestId("forecast-date-balance")).toBeTruthy();
  });

  it("/review: the 'Register & review' view under the 'Review' title; the overall-only cards stay out", () => {
    mount(<ForecastPage mode="review" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Review");
    expect(screen.getByTestId("tab-register").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("tab-plan").getAttribute("href")).toBe("/forecast");
    const panel = screen.getByTestId("register-panel");
    expect(within(panel).queryByTestId("dragging-plans-list")).toBeNull();
    expect(within(panel).queryByTestId("card-bank-snapshot")).toBeNull();
    // The headline and the chart are on every view.
    expect(screen.getByTestId("card-forecast-hero")).toBeTruthy();
    expect(screen.getByTestId("card-projected-balance-chart")).toBeTruthy();
    // (D8) The register's month picker heads the review view.
    expect(within(panel).getByTestId("review-month-row")).toBeTruthy();
  });

  it("FC-21: the hero carries 'Inbox cleared' only when the inbox is empty AND was just reconciled, on either view", () => {
    const ctx = (over: Partial<ForecastNextCtx>) =>
      ({
        mode: "overall", horizonDays: 30, horizonControls: null, draggingCard: null, bankGrid: null,
        registerBlock: null, monthBlock: null, proj: SIGNAL, projReady: true, dailySeries: [], cashBufferNum: 500,
        lowestPoint: null, bigBillMarkers: [], eventsByDate: new Map(), partialPlanKeys: new Set(),
        jumpToPlan: () => {}, onMarkMissed: () => {}, onSkipDraggingPlan: () => {}, openSnapshot: () => {},
        openSettings: () => {}, cashProjectionLoading: false, bankBalance: "1000", bankAccountName: "Checking",
        bankAccountMask: null, debtLinks: new Map(), inboxCount: 0, fromDate: "2026-06-10", lookbackOpen: false,
        highlightedPlanKey: null, reconciledNow: true, dateBalance: null, ...over,
      }) as unknown as ForecastNextCtx;
    const body = (c: ForecastNextCtx, tab: "register" | "plan") =>
      mount(<ForecastBody ctx={c} tab={tab} selectedDate={null} setSelectedDate={() => {}} title="Forecast" />);
    for (const tab of ["register", "plan"] as const) {
      const v = body(ctx({}), tab);
      expect(within(screen.getByTestId("card-forecast-hero")).getByTestId("badge-inbox-cleared").textContent).toBe("Inbox cleared");
      v.unmount();
    }
    let v = body(ctx({ inboxCount: 2 }), "register");
    expect(screen.queryByTestId("badge-inbox-cleared")).toBeNull();
    v.unmount();
    v = body(ctx({ reconciledNow: false }), "plan");
    expect(screen.queryByTestId("badge-inbox-cleared")).toBeNull();
    v.unmount();
  });

  it("/next/forecast: the same screen, its views real tabs over one tabpanel that is always on the page", () => {
    mount(<NextForecastPage />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("data-testid"))).toEqual(["tab-register", "tab-plan"]);
    for (const t of tabs) expect(t.getAttribute("aria-controls")).toBe("register-pane");
    const pane = screen.getByRole("tabpanel");
    expect(pane.id).toBe("register-pane");
    expect(pane.getAttribute("aria-labelledby")).toBe("register-tab-register");
    fireEvent.click(screen.getByTestId("tab-plan"));
    expect(screen.getByTestId("tab-plan").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("register-tab-plan");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Forecast");
  });
});

// ⭐ (T3) ONE CALCULATION, EXPLICIT PERIODS, THE LISTS ON SCREEN, AN HONEST DAY.
describe("T3 — the Forecast screen tells one story from the cash signal", () => {
  const cents = (t: string | null | undefined) => {
    const m = (t ?? "").match(/-?\$[\d,]+\.\d{2}/);
    return m ? Math.round(Number(m[0].replace(/[$,]/g, "")) * 100) : NaN;
  };
  beforeEach(() => {
    cashSignal = SIGNAL_T3;
  });

  it("'How this adds up': start + in − out = end, every figure the signal's; the end = the hero = the KPI = the chart's last point", () => {
    mount(<ForecastPage mode="overall" />);
    const box = screen.getByTestId("hero-adds-up");
    expect(box.tagName).toBe("DETAILS");
    expect(within(box).getByText("How this adds up").tagName).toBe("SUMMARY");
    expect(screen.getByTestId("adds-up-start").textContent).toBe("Starting balance · Jun 10$1,000.00");
    expect(screen.getByTestId("adds-up-in").textContent).toBe("+ Money in$2,050.50");
    expect(screen.getByTestId("adds-up-out").textContent).toBe("− Money out$825.00");
    expect(screen.getByTestId("adds-up-end").textContent).toBe("= Ending Jun 20$2,225.50");
    const end = cents(screen.getByTestId("adds-up-end").textContent);
    expect(cents(screen.getByTestId("adds-up-start").textContent) + cents(screen.getByTestId("adds-up-in").textContent) - cents(screen.getByTestId("adds-up-out").textContent)).toBe(end);
    expect(cents(screen.getByTestId("hero-forecast-balance").textContent)).toBe(end);
    expect(cents(screen.getByTestId("kpi-ending-balance").textContent)).toBe(end);
    expect(Math.round(Number(chartRows.at(-1)!.balance) * 100)).toBe(end);
    // The old footnotes and the head's methodology are gone.
    expect(screen.queryByTestId("hero-footnotes")).toBeNull();
    expect(screen.queryByTestId("filters-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Bank before|What filters do|Plans are matched to bank activity/);
  });

  it("the '=' line hides itself if the four figures ever stopped agreeing (a guard that should never fire)", () => {
    cashSignal = { ...SIGNAL_T3, endingBalance: "2225.51" };
    mount(<ForecastPage mode="overall" />);
    expect(screen.getByTestId("adds-up-start")).toBeTruthy();
    expect(screen.queryByTestId("adds-up-end")).toBeNull();
  });

  it("no second calculation on screen: no 'Projected end', no 'Forecast $X · Bank $Y' (Forecast and Review)", () => {
    for (const mode of ["overall", "review"] as const) {
      const v = mount(<ForecastPage mode={mode} />);
      expect(document.body.textContent).not.toMatch(/Projected end/);
      expect(document.body.textContent).not.toMatch(/Forecast \$[\d,.]+ · Bank/);
      expect(screen.queryByTestId("planned-projected-end")).toBeNull();
      v.unmount();
    }
  });

  it("the low point is the plotted minimum, on its date; 'Review shortfall'/'See <day>' selects that day", () => {
    mount(<ForecastPage mode="overall" />);
    const min = Math.min(...chartRows.map((r) => Number(r.balance)));
    expect(cents(screen.getByTestId("kpi-lowest-point").textContent)).toBe(Math.round(min * 100));
    expect(chartRows.find((r) => Number(r.balance) === min)!.rawDate).toBe(SIGNAL_T3.lowestDate);
    const see = screen.getByTestId("kpi-lowest-see-day");
    expect(see.textContent).toBe("See Jun 15");
    fireEvent.click(see);
    expect(screen.getByTestId("day-panel-date").textContent).toContain("Jun 15");
    // Below zero, the same action reads "Review shortfall".
    cleanup();
    cashSignal = { ...SIGNAL_T3, lowestProjected: "-5.00" };
    mount(<ForecastPage mode="overall" />);
    expect(screen.getByTestId("kpi-lowest-see-day").textContent).toBe("Review shortfall");
  });

  it("the day panel adds up: opening + money in − money out (bank activity included) = close, on every day", () => {
    mount(<ForecastPage mode="overall" />);
    const ids = ["day-income", "day-bank-in", "day-out-bill", "day-out-card", "day-out-debt", "day-bank-out"];
    for (const day of ["2026-06-10", "2026-06-15", "2026-06-20"]) {
      fireEvent.click(screen.getByTestId(`tap-${day}`));
      const moved = ids.reduce((sum, id) => {
        const el = screen.queryByTestId(id);
        return sum + (el ? cents(el.textContent) : 0);
      }, 0);
      expect(cents(screen.getByTestId("day-opening").textContent) + moved, day).toBe(cents(screen.getByTestId("day-close").textContent));
    }
    // Day one opens on the curve's own start, and its bank row is listed.
    fireEvent.click(screen.getByTestId("tap-2026-06-10"));
    expect(screen.getByTestId("day-opening").textContent).toBe("$1,000.00");
    expect(screen.getByTestId("day-bank-out").textContent).toBe("-$25.00");
    expect(screen.getByTestId("day-bank-t-coffee").textContent).toContain("Bank activity");
    // Only the side that moved gets a line.
    expect(screen.queryByTestId("day-bank-in")).toBeNull();
    // 06-15: the carried rent and the matched refund.
    fireEvent.click(screen.getByTestId("tap-2026-06-15"));
    expect(screen.getByTestId("day-bank-in").textContent).toBe("$50.50");
    expect(screen.getByTestId("day-bank-t-refund").textContent).toContain("matched");
    expect(screen.getByTestId("day-jump-rent").textContent).toBe("Open in register");
    // 06-20: the payday is a Payday (it never was before: `events` carries expenses only).
    fireEvent.click(screen.getByTestId("tap-2026-06-20"));
    expect(screen.getByTestId("day-income").textContent).toBe("$2,000.00");
    expect(screen.getByTestId("day-event-pay").textContent).toContain("Payday");
    // No "What this day assumes" box.
    expect(screen.queryByTestId("day-assumptions")).toBeNull();
    expect(document.body.textContent).not.toMatch(/What this day assumes/);
  });

  it("the three server lists are on screen, counted in 'How this adds up'", () => {
    mount(<ForecastPage mode="overall" />);
    const unpaid = screen.getByTestId("card-dragging-plans-summary");
    expect(within(unpaid).getByRole("heading", { level: 2 }).textContent).toBe("Unpaid items");
    expect(screen.getByTestId("dragging-plans-chip").textContent).toBe("1 · carried to Jun 15");
    expect(screen.queryByText("Past due")).toBeNull();
    expect(within(unpaid).getByTestId("assumed-paid-words-water-2026-06-05").textContent).toBe("Due Jun 5 · paid $60.00");
    expect(within(unpaid).getByTestId("assumed-paid-not-this-water-2026-06-05").textContent).toBe("Not this");
    expect(within(screen.getByTestId("older-unpaid-group")).getByText("Older than 14 days · off the curve")).toBeTruthy();
    expect(screen.getByTestId("older-plan-mark-missed-gym-2026-05-01")).toBeTruthy();
    const income = screen.getByTestId("card-income-not-arrived");
    expect(within(income).getByTestId("income-plan-mark-missed-bonus-2026-06-01").textContent).toBe("Didn't arrive");
    const lines = screen.getByTestId("adds-up-lists");
    expect(within(lines).getByTestId("adds-up-list-unpaid").textContent).toBe("Unpaid items1");
    expect(within(lines).getByTestId("adds-up-list-incomeNotArrived").textContent).toBe("Income not arrived1");
    expect(within(lines).getByTestId("adds-up-list-olderUnpaid").textContent).toBe("Older than 14 days · off the curve1");
    // A count line opens its list (focus moves to it).
    fireEvent.click(within(lines).getByTestId("adds-up-list-incomeNotArrived"));
    expect(document.activeElement).toBe(income);
  });

  it("?day= is the selected day's address: a deep link lands on it, and the address follows a pick", async () => {
    window.history.replaceState(null, "", "/forecast?day=2026-06-15");
    mount(<ForecastPage mode="overall" />);
    expect(screen.getByTestId("day-panel-date").textContent).toContain("Jun 15");
    expect(screen.getByTestId("day-close").textContent).toBe("$225.50");
    fireEvent.click(screen.getByTestId("tap-2026-06-20"));
    await waitFor(() => expect(window.location.search).toBe("?day=2026-06-20"));
    fireEvent.keyDown(screen.getByTestId("chart-surface"), { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("?day= beyond the saved horizon opens a horizon wide enough for it, without saving that horizon", () => {
    const [y, m, d] = householdToday().split("-").map(Number);
    const day = new Date(Date.UTC(y!, m! - 1, d! + 60)).toISOString().slice(0, 10);
    window.history.replaceState(null, "", `/forecast?day=${day}`);
    mount(<ForecastPage mode="overall" />);
    expect(screen.getByTestId("horizon-90").getAttribute("aria-pressed")).toBe("true");
    expect(sessionStorage.getItem("h2budget:forecastHorizonDays")).not.toBe("90");
    // A horizon the person picks is saved as before.
    fireEvent.click(screen.getByTestId("horizon-120"));
    expect(sessionStorage.getItem("h2budget:forecastHorizonDays")).toBe("120");
  });

  it("shading never shows without its legend; the chart panel names its start and length", () => {
    mount(<ForecastPage mode="overall" />);
    const panel = screen.getByTestId("card-projected-balance-chart");
    const shades = [...document.querySelectorAll('[data-testid^="risk-"]')];
    expect(shades.length).toBeGreaterThan(0);
    for (const sh of shades) expect(panel.contains(sh)).toBe(true);
    expect(within(panel).getByTestId("chart-legend")).toBeTruthy();
    expect(panel.textContent).toMatch(/Starting at \$1,000\.00 · as of Jun 10 · 30 days/);
  });

  it("words: the empty day panel is one short line; the review links carry the account and the month", () => {
    mount(<ForecastPage mode="overall" />);
    expect(screen.getByTestId("day-panel-empty").textContent).toBe("Pick a day on the chart.");
    cleanup();
    mount(<ForecastPage mode="review" />);
    expect(screen.getByTestId("link-open-chase").getAttribute("href")).toBe("/transactions?account=acct-row-1");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReviewInboxCount } from "./useReviewInboxCount";

const mockData: { current: unknown } = { current: null };
vi.mock("@workspace/api-client-react", () => ({
  useGetForecast: () => ({ data: mockData.current }),
}));

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

describe("useReviewInboxCount (#751)", () => {
  const realNow = Date.now;
  // Anchor "today" to a fixed weekday so monthKey comparisons are
  // deterministic across CI/timezones.
  const NOW = new Date(2026, 4, 27); // 2026-05-27 (Wed)
  const TODAY_ISO = fmtDate(NOW);
  const PREV_MONTH_ISO = "2026-04-20";
  const CUR_MONTH_TXN_DATE = "2026-05-10";
  const CUR_MONTH_TXN_DATE_2 = "2026-05-12";
  const FUTURE_PLAN_ISO = "2026-06-15";

  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => NOW.getTime());
    // Also intercept `new Date()` (no-arg) -> fixed instant.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    Date.now = realNow;
    mockData.current = null;
  });

  function baseBundle(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      fromDate: "2026-04-01",
      toDate: "2026-08-31",
      events: [],
      transactions: [],
      resolutions: [],
      bankSnapshot: null,
      plaidCheckingAccounts: [],
      ...overrides,
    };
  }

  function bankTxn(id: string, date: string, amount = "-25.00") {
    return {
      id,
      occurredOn: date,
      description: `tx ${id}`,
      amount,
      forecastFlag: true,
      plaidAccountId: null, // no snapshot account → all txns included
    };
  }

  function planEvent(itemId: string, date: string, amount = -100) {
    return { itemId, date, amount, label: `plan ${itemId}`, kind: "expense" };
  }

  it("counts 2 unmatched current-month bank txns", () => {
    mockData.current = baseBundle({
      transactions: [
        bankTxn("t1", CUR_MONTH_TXN_DATE),
        bankTxn("t2", CUR_MONTH_TXN_DATE_2),
      ],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(2);
  });

  it("adds a past-due plan from last month with no resolution → 2 + 1 = 3", () => {
    mockData.current = baseBundle({
      transactions: [
        bankTxn("t1", CUR_MONTH_TXN_DATE),
        bankTxn("t2", CUR_MONTH_TXN_DATE_2),
      ],
      events: [planEvent("p-old", PREV_MONTH_ISO)],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(3);
  });

  it("a matched past-due plan does not increase the count", () => {
    mockData.current = baseBundle({
      transactions: [
        bankTxn("t1", CUR_MONTH_TXN_DATE),
        bankTxn("t2", CUR_MONTH_TXN_DATE_2),
      ],
      events: [
        planEvent("p-old", PREV_MONTH_ISO),
        planEvent("p-old-matched", PREV_MONTH_ISO),
      ],
      resolutions: [
        {
          id: "r1",
          recurringItemId: "p-old-matched",
          occurrenceDate: PREV_MONTH_ISO,
          status: "matched",
          matchedTxnId: "tx-something",
        },
      ],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    // 2 bank + 1 past-due pending (the matched one is excluded).
    expect(result.current).toBe(3);
  });

  it("future plans never count toward the badge", () => {
    mockData.current = baseBundle({
      transactions: [
        bankTxn("t1", CUR_MONTH_TXN_DATE),
        bankTxn("t2", CUR_MONTH_TXN_DATE_2),
      ],
      events: [
        planEvent("p-old", PREV_MONTH_ISO),
        planEvent("p-future", FUTURE_PLAN_ISO),
      ],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    // 2 bank + 1 past-due pending; future is ignored.
    expect(result.current).toBe(3);
  });

  it("a past-due plan dated today still counts (boundary)", () => {
    mockData.current = baseBundle({
      events: [planEvent("p-today", TODAY_ISO)],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(1);
  });
});

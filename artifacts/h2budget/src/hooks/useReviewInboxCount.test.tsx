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

  it("(#803 revert) a past-due plan from last month does NOT add to the badge", () => {
    // The badge no longer counts plan rows — plan reconciliation moved to
    // the Weekly Debrief. Only the 2 current-month bank txns count.
    mockData.current = baseBundle({
      transactions: [
        bankTxn("t1", CUR_MONTH_TXN_DATE),
        bankTxn("t2", CUR_MONTH_TXN_DATE_2),
      ],
      events: [planEvent("p-old", PREV_MONTH_ISO)],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(2);
  });

  it("(#803 revert) plan rows — matched or not — never change the count", () => {
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
    // Only the 2 bank txns count; plan rows are ignored entirely.
    expect(result.current).toBe(2);
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
    // Only the 2 current-month bank txns count; all plan rows are ignored.
    expect(result.current).toBe(2);
  });

  it("(#803 revert) a past-due plan dated today does NOT count", () => {
    // No bank txns, only a plan row dated today — the badge is 0 because
    // plan rows no longer feed the count.
    mockData.current = baseBundle({
      events: [planEvent("p-today", TODAY_ISO)],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(0);
  });

  it("matched current-month bank txns are excluded from the count", () => {
    // A bank txn whose id is referenced by a resolution.matchedTxnId is
    // already triaged, so it must not inflate the badge.
    mockData.current = baseBundle({
      transactions: [
        bankTxn("t1", CUR_MONTH_TXN_DATE),
        bankTxn("t2", CUR_MONTH_TXN_DATE_2),
      ],
      resolutions: [
        {
          id: "r1",
          recurringItemId: "p-x",
          occurrenceDate: CUR_MONTH_TXN_DATE,
          status: "matched",
          matchedTxnId: "t1",
        },
      ],
    });
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * ⭐ THE PARITY GUARD FOR THE BILLS OVERVIEW.
 *
 * The plan's spine rule is that a Phase-C page's headline numbers are READ from
 * `/api/spine`, never re-derived from that page's own detail query — because a
 * page that re-derives its own copy is exactly how two tiles come to disagree.
 *
 * A test that only checked "the headline equals the spine" would still pass if
 * someone quietly recomputed the same figure from `/bills/summary`. So the
 * fixtures here are deliberately CONTRADICTORY: the summary carries a different
 * cheapest/earliest bill and a different row count than the spine does. The
 * spine's numbers must win, and the summary-derived alternatives must be absent
 * from the headline. If a future edit starts computing `nextBill` locally, this
 * file goes red.
 *
 * The month table underneath is the other half of the contract: those figures
 * are NOT spine fields, so they must keep coming from `/bills/summary`
 * unchanged, to the cent.
 */

const spineData: { current: unknown } = { current: undefined };
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: spineData.current, isLoading: false }),
}));

const summaryData: { current: unknown } = { current: undefined };
vi.mock("@workspace/api-client-react", () => ({
  useGetBillsSummary: () => ({ data: summaryData.current, isLoading: false }),
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
}));

import BillsOverviewPage from "./bills-overview";

/** The spine's answer — the only source the headline may quote. */
const SPINE = {
  nextBill: { name: "Electric", amount: "412.50", dueDate: "2026-09-03" },
  billsDueCount: 7,
};

/**
 * The page's own detail query. Note the disagreement, on purpose:
 *  - its earliest row is "Mortgage" on 2026-09-01 at $2,100 — earlier AND
 *    bigger than the spine's next bill,
 *  - it holds 3 bill rows, not 7.
 * Anything recomputed locally would therefore show 2,100 / Mortgage / Sep 1 / 3.
 */
function summary() {
  return {
    income: [],
    bills: [
      {
        item: { id: "b-mortgage", name: "Mortgage" },
        nextOccurrence: "2026-09-01",
        monthlyAmount: "2100",
        actualAmount: "0",
      },
      {
        item: { id: "b-electric", name: "Electric" },
        nextOccurrence: "2026-09-03",
        monthlyAmount: "412.50",
        actualAmount: "0",
      },
      {
        item: { id: "b-phone", name: "Phone" },
        nextOccurrence: "2026-09-18",
        monthlyAmount: "95",
        actualAmount: "0",
      },
    ],
    debtMins: [],
    monthly: {
      income: "6400",
      bills: "2607.50",
      debtMin: "540.25",
      totalOutflow: "3147.75",
      net: "3252.25",
      active: 3,
      monthStart: "2026-09-01",
      monthEnd: "2026-09-30",
    },
  };
}

const text = (id: string) => screen.getByTestId(id).textContent ?? "";

afterEach(() => cleanup());

beforeEach(() => {
  spineData.current = { ...SPINE };
  summaryData.current = summary();
});

describe("bills overview — the headline is the spine's", () => {
  it("quotes the spine's next bill: amount, name and date", () => {
    render(<BillsOverviewPage />);
    const stat = text("stat-next-bill");
    expect(stat).toContain("$412.50");
    expect(stat).toContain("Electric");
    expect(stat).toContain("Sep 3, 2026");
  });

  it("quotes the spine's bills-due count", () => {
    render(<BillsOverviewPage />);
    expect(text("stat-bills-due")).toContain("7");
  });

  it("⚠️ does NOT re-derive the headline from /bills/summary", () => {
    render(<BillsOverviewPage />);
    const stat = text("stat-next-bill");
    // The summary's earliest row is a bigger Mortgage a day sooner. If the page
    // ever computes its own "next bill", these are what it would show.
    expect(stat).not.toContain("Mortgage");
    expect(stat).not.toContain("$2,100.00");
    expect(stat).not.toContain("Sep 1, 2026");
    // ...and the count is the spine's 7, not the summary's 3 rows.
    expect(text("stat-bills-due")).not.toContain("3");
  });

  it("moves with the spine when the spine moves, with the summary held fixed", () => {
    spineData.current = {
      nextBill: { name: "Water", amount: "88.10", dueDate: "2026-10-12" },
      billsDueCount: 1,
    };
    render(<BillsOverviewPage />);
    const stat = text("stat-next-bill");
    expect(stat).toContain("$88.10");
    expect(stat).toContain("Water");
    expect(stat).toContain("Oct 12, 2026");
    expect(text("stat-bills-due")).toContain("1");
  });

  it("shows a dash, never an invented number, before the spine answers", () => {
    spineData.current = undefined;
    render(<BillsOverviewPage />);
    expect(text("stat-next-bill")).toContain("—");
    expect(text("stat-bills-due")).toContain("—");
    // No fallback to a locally computed figure.
    expect(text("stat-next-bill")).not.toContain("$");
  });
});

describe("bills overview — the month table is the summary's, to the cent", () => {
  it("renders every /bills/summary monthly figure unchanged", () => {
    render(<BillsOverviewPage />);
    expect(text("text-overview-income")).toBe("$6,400.00");
    expect(text("text-overview-bills")).toBe("$2,607.50");
    expect(text("text-overview-debt-min")).toBe("$540.25");
    expect(text("text-overview-outflow")).toBe("$3,147.75");
    expect(text("text-overview-net")).toBe("$3,252.25");
  });

  it("labels the net state in words, not colour alone", () => {
    render(<BillsOverviewPage />);
    expect(text("chip-net-state")).toBe("Surplus");
  });

  it("says Short — and says it in words — when outflow beats income", () => {
    summaryData.current = {
      ...summary(),
      monthly: {
        ...summary().monthly,
        income: "1000",
        totalOutflow: "1500",
        net: "-500",
      },
    };
    render(<BillsOverviewPage />);
    expect(text("chip-net-state")).toBe("Short");
    expect(text("text-overview-net")).toBe("-$500.00");
    // 1500 / 1000 — over-committed, and the meter reports the true figure.
    expect(text("text-overview-committed")).toBe("150%");
  });

  it("reports committed as 0% rather than dividing by zero income", () => {
    summaryData.current = {
      ...summary(),
      monthly: { ...summary().monthly, income: "0", totalOutflow: "800", net: "-800" },
    };
    render(<BillsOverviewPage />);
    expect(text("text-overview-committed")).toBe("0%");
  });
});

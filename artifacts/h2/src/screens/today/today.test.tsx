import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { Spine } from "@workspace/api-client-react";
import type { SpineRead } from "@/data/useSpine";

/**
 * ⭐ TODAY READS ITS FIGURES; IT NEVER WORKS ONE OUT.
 *
 * `useSpine` and the generated settings hook are mocked at the boundary, and
 * every figure on screen is checked against what they returned: the exact
 * value to the cent (`<data value>`), and the whole-dollar face beside it.
 * Then the states: cold, refreshing, stale, failed, failed-refresh. And the
 * standing law: no amount owed ever reaches this screen.
 */

const spineRead = vi.hoisted(() => ({ current: null as unknown as SpineRead }));
const settingsRead = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/data/useSpine", () => ({ useSpine: () => spineRead.current }));
vi.mock("@workspace/api-client-react", () => ({
  useGetSettings: () => settingsRead.current,
  getGetSettingsQueryKey: () => ["/api/settings"],
}));

import Today from "./Today";

// Wednesday Oct 7, 2026, 10:00 in Chicago.
const NOW = new Date("2026-10-07T15:00:00Z");

const SPINE: Spine = {
  asOf: "2026-10-07T14:59:00Z",
  bank: {
    balance: "12345.67",
    asOfDate: "2026-10-07T14:48:00Z",
    source: "plaid",
    lastContactAt: "2026-10-07T14:48:00Z",
    lastFailureAt: null,
    stale: false,
    staleReason: null,
  },
  spentMonth: 1890.12,
  spentWeek: 412.4,
  nextBill: { name: "Electric", amount: "142.18", dueDate: "2026-10-12" },
  billsDueCount: 3,
  forecast: { lowPoint: "800.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "ready" },
  debt: { payoffPct: 41.3 },
  reviewCount: 2,
};

function read(over: Partial<SpineRead> = {}): SpineRead {
  return {
    data: SPINE,
    isLoading: false,
    isFetching: false,
    state: "loaded",
    error: null,
    updatedAt: "2026-10-07T14:59:00Z",
    refetch: vi.fn(),
    ...over,
  };
}

function settingsLoaded(weekly = "600.00") {
  return { data: { weeklyAllowanceAmount: weekly, monthlyAllowanceAmount: "0", unplannedAllowanceAmount: "0" }, isFetching: false };
}

beforeEach(() => {
  spineRead.current = read();
  settingsRead.current = settingsLoaded();
});
afterEach(cleanup);

/** Every <data> in a region, as [face, exact value]. */
function figuresIn(el: HTMLElement): Array<[string | null, string | null]> {
  return Array.from(el.querySelectorAll("data"), (d) => [d.textContent, d.getAttribute("value")]);
}

describe("Today — every figure equals what the spine and settings sent", () => {
  it("bank balance: the one figure-xl, exact to the cent, whole dollars on its face", () => {
    const { container } = render(<Today now={NOW} />);
    expect(container.querySelectorAll("[data-size='xl']")).toHaveLength(1);
    const bank = screen.getByTestId("figure-bank");
    expect(figuresIn(bank)).toEqual([["$12,346", "12345.67"]]);
    expect(bank.textContent).toContain("Bank balance");
    expect(bank.textContent).toContain("as of Oct 7 · bank sync");
  });

  it("this week: spent of the weekly limit, from the spine and the settings hook", () => {
    render(<Today now={NOW} />);
    const week = screen.getByTestId("section-week");
    expect(figuresIn(week)).toEqual([
      ["$412", "412.40"],
      ["$600", "600.00"],
    ]);
    expect(within(week).getByTestId("meter-status").textContent).toBe("On plan");
    expect(week.textContent).toContain("Spent so far");
  });

  it("coming up: the next bill and how many are due", () => {
    render(<Today now={NOW} />);
    const next = screen.getByTestId("next-bill");
    expect(figuresIn(next)).toEqual([["$142", "142.18"]]);
    expect(next.textContent).toContain("Electric");
    expect(next.textContent).toContain("due Oct 12");
    expect(screen.getByTestId("bills-due").textContent).toBe("3 bills due this month");
  });

  it("debt: a percentage paid, rounded as the classic landing rounds it", () => {
    render(<Today now={NOW} />);
    const debt = screen.getByTestId("figure-debt");
    expect(figuresIn(debt)).toEqual([["41%", "41.30"]]);
    expect(debt.textContent).toContain("paid");
  });

  it("needs you: the review count, linking to the classic review", () => {
    render(<Today now={NOW} />);
    expect(screen.getByTestId("review-count").textContent).toBe("2 bank rows to match");
    const link = screen.getByRole("link", { name: "Open review" });
    expect(link.getAttribute("href")).toBe("/classic/review");
  });

  it("the classic app is one quiet row away", () => {
    render(<Today now={NOW} />);
    const row = screen.getByTestId("classic-row");
    expect(within(row).getByRole("link", { name: "Classic app" }).getAttribute("href")).toBe("/classic/");
    expect(row.textContent).toContain("Bills, debts, settings and bank links still live in the classic app for now.");
  });

  it("over and tight read as words", () => {
    spineRead.current = read({ data: { ...SPINE, spentWeek: 655.2 } });
    render(<Today now={NOW} />);
    expect(screen.getByTestId("meter-status").textContent).toBe("Over by $55");
    cleanup();
    spineRead.current = read({ data: { ...SPINE, spentWeek: 540 } });
    render(<Today now={NOW} />);
    expect(screen.getByTestId("meter-status").textContent).toBe("Tight");
  });
});

describe("Today — the dateline is the household's date", () => {
  it("reads 'Wednesday, October 7' at 10 pm Chicago, when UTC is already the 8th", () => {
    render(<Today now={new Date("2026-10-08T03:00:00Z")} />);
    expect(screen.getByTestId("dateline").textContent).toBe("Wednesday, October 7");
  });
});

describe("Today — a figure that did not arrive is a dash, never $0", () => {
  it("a failed first load: every figure '—', the error said, Retry offered", () => {
    const refetch = vi.fn();
    spineRead.current = read({ data: undefined, state: "failed", updatedAt: null, refetch });
    const { container } = render(<Today now={NOW} />);
    expect(container.textContent).not.toMatch(/\$\d/);
    expect(screen.getByTestId("figure-bank").textContent).toContain("—");
    expect(screen.getByTestId("figure-debt").textContent).toContain("—");
    const note = screen.getByTestId("refresh-note");
    expect(note.textContent).toContain("Couldn't load these numbers.");
    within(note).getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("an unreadable balance is '—'", () => {
    spineRead.current = read({ data: { ...SPINE, bank: { ...SPINE.bank, balance: "" } } });
    render(<Today now={NOW} />);
    expect(screen.getByTestId("figure-bank").textContent).toContain("—");
    expect(screen.getByTestId("figure-bank").querySelector("data")).toBeNull();
  });

  it("no anchored debt is '—' with a reason, not 0%", () => {
    spineRead.current = read({ data: { ...SPINE, debt: { payoffPct: null } } });
    render(<Today now={NOW} />);
    const debt = screen.getByTestId("figure-debt");
    expect(debt.textContent).toContain("—");
    expect(debt.textContent).not.toContain("0%");
    expect(debt.textContent).toContain("No debt has a starting balance yet.");
  });

  it("nothing scheduled and nothing to review are said in words", () => {
    spineRead.current = read({ data: { ...SPINE, nextBill: null, reviewCount: 0, billsDueCount: 1 } });
    render(<Today now={NOW} />);
    expect(screen.getByTestId("section-coming-up").textContent).toContain("Nothing scheduled.");
    expect(screen.getByTestId("bills-due").textContent).toBe("1 bill due this month");
    expect(screen.getByTestId("section-needs-you").textContent).toContain("Nothing is waiting on you.");
    expect(screen.queryByRole("link", { name: "Open review" })).toBeNull();
  });
});

describe("Today — states", () => {
  it("cold: skeleton shapes, the date, and no figure at all", () => {
    spineRead.current = read({ data: undefined, state: "cold", isLoading: true, isFetching: true, updatedAt: null });
    const { container } = render(<Today now={NOW} />);
    expect(screen.getByTestId("today-skeleton")).toBeTruthy();
    expect(container.querySelector("data")).toBeNull();
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).toContain("Wednesday, October 7");
  });

  it("refreshing: the figures stay and the badge says Updating", () => {
    spineRead.current = read({ state: "refreshing", isFetching: true });
    render(<Today now={NOW} />);
    expect(screen.getByTestId("freshness-badge").textContent).toBe("Updating");
    expect(figuresIn(screen.getByTestId("figure-bank"))).toEqual([["$12,346", "12345.67"]]);
  });

  it("stale bank: the badge words, and a Note offering Sync", () => {
    spineRead.current = read({
      data: {
        ...SPINE,
        bank: { ...SPINE.bank, asOfDate: "2026-10-04T13:00:00Z", lastContactAt: null, stale: true, staleReason: "old" },
      },
    });
    render(<Today now={NOW} />);
    expect(screen.getByTestId("freshness-badge").textContent).toMatch(/Out of date.*last updated 3 days ago/);
    const note = screen.getByTestId("stale-note");
    expect(note.textContent).toContain("The bank balance may be out of date.");
    expect(within(note).getByRole("link", { name: "Sync" }).getAttribute("href")).toBe("/classic/settings");
    expect(figuresIn(screen.getByTestId("figure-bank"))).toEqual([["$12,346", "12345.67"]]);
  });

  it("a failed refresh keeps the last figures, says how old they are, offers Retry", () => {
    spineRead.current = read({ state: "refresh-failed", updatedAt: "2026-10-07T14:40:00Z" });
    render(<Today now={NOW} />);
    expect(screen.getByTestId("refresh-note").textContent).toContain(
      "Couldn't refresh. Showing numbers from 20 minutes ago.",
    );
    expect(figuresIn(screen.getByTestId("figure-bank"))).toEqual([["$12,346", "12345.67"]]);
  });

  it("settings still loading: the week meter is a skeleton, not a limit of $0", () => {
    settingsRead.current = { data: undefined, isFetching: true };
    const { container } = render(<Today now={NOW} />);
    const week = screen.getByTestId("section-week");
    expect(week.querySelector("data")).toBeNull();
    expect(container.textContent).not.toContain("of $0");
  });

  it("settings failed: spent still shows, and the missing limit is said", () => {
    settingsRead.current = { data: undefined, isLoadingError: true };
    render(<Today now={NOW} />);
    const week = screen.getByTestId("section-week");
    expect(figuresIn(week)).toEqual([["$412", "412.40"]]);
    expect(week.textContent).toContain("The weekly limit did not load.");
  });

  it("a weekly limit of zero is 'no limit set', not 'over'", () => {
    settingsRead.current = settingsLoaded("0.00");
    render(<Today now={NOW} />);
    expect(screen.getByTestId("section-week").textContent).toContain("No weekly limit set yet.");
    expect(screen.queryByTestId("meter-status")).toBeNull();
  });
});

describe("Today — no amount owed, ever", () => {
  it("renders only % paid even if a balance were smuggled onto the spine", () => {
    // The spine is tested to refuse a balance; this proves the screen would
    // not show one anyway: it reads payoffPct and nothing else from `debt`.
    const smuggled = {
      ...SPINE,
      debt: { payoffPct: 41.3, balance: "98765.43", owed: "98765.43", totalOwed: 98765.43 },
    } as unknown as Spine;
    spineRead.current = read({ data: smuggled });
    const { container } = render(<Today now={NOW} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/98,76[45]|98765/);
    expect(text.toLowerCase()).not.toMatch(/\bowed?\b|\bowing\b|balance due|remaining debt/);
    expect(figuresIn(screen.getByTestId("figure-debt"))).toEqual([["41%", "41.30"]]);
  });
});

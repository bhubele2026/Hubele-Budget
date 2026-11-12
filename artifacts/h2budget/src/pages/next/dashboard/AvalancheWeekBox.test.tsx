import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { AvalancheWeeklyLastPaid, AvalancheWeeklyPlan, AvalancheWeeklyWeek } from "@workspace/api-client-react";

// ⭐ (AVAL-W) The home page's "Pay this week" box: which debt this week's
// payment goes to, how much and when, "We paid it", then two compact rows:
// "Paid · $X · card" with Undo, and "Next payment · Fri Nov 27 · $X · card"
// ("2 cards" opens to each card's line). Every figure is the server's plan; the box
// only picks the state and the words (`lib/avalancheWeekPay.ts`).

const h = vi.hoisted(() => ({
  q: { data: undefined, isError: false, refetch: () => {} } as { data: unknown; isError: boolean; refetch: () => void },
  pay: [] as string[],
  undo: [] as string[],
  error: null as string | null,
  refetches: 0,
}));
vi.mock("@workspace/api-client-react/features", () => ({
  getGetAvalancheWeeklyQueryKey: () => ["/api/avalanche/weekly"],
  useGetAvalancheWeekly: () => h.q,
}));
vi.mock("@/hooks/useAvalancheWeekPay", () => ({
  useAvalancheWeekPay: () => ({
    pay: (d: string) => h.pay.push(d),
    undo: (id: string) => h.undo.push(id),
    paying: false,
    undoing: false,
    error: h.error,
  }),
}));
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import React from "react";
import AvalancheWeekBox from "./AvalancheWeekBox";
import { BELOW_FOLD } from "./belowFoldSizes";
import { CompactFold } from "./foldDensity";
import { payDayLabel, weekPayView } from "@/lib/avalancheWeekPay";

const CARD_A = { debtId: "a", name: "Card A" };
const CARD_B = { debtId: "b", name: "Card B" };

function week(over: Partial<AvalancheWeeklyWeek> & { date: string; paid: number }): AvalancheWeeklyWeek {
  return {
    planned: 600,
    room: over.paid,
    due: over.paid,
    basis: "curve",
    answered: false,
    nextTarget: CARD_A,
    targets: over.paid > 0 ? [{ ...CARD_A, amount: over.paid, paidOff: false }] : [],
    paidOff: [],
    ...over,
  };
}

// Tuesday 2026-11-10 in Chicago; Fridays from 11/13.
const NOW = new Date("2026-11-10T18:00:00Z");
const plan = (over: Partial<AvalancheWeeklyPlan> = {}): AvalancheWeeklyPlan => ({
  cadence: "weekly",
  weekday: 5,
  monthlyTarget: 2600,
  targetWeekly: 600,
  cashBuffer: 500,
  weeks: [week({ date: "2026-11-13", paid: 400 }), week({ date: "2026-11-20", paid: 0 }), week({ date: "2026-11-27", paid: 450 })],
  payoffs: [],
  debtFreeDate: "2027-08-06",
  curveThrough: "2027-10-01",
  ranOutOfTime: false,
  lastPaid: null,
  ...over,
});
const ok = (data: unknown) => ({ data, isError: false, refetch: () => void (h.refetches += 1) });
const paidRec = (over: Partial<AvalancheWeeklyLastPaid> = {}): AvalancheWeeklyLastPaid => ({
  id: "rec-1",
  date: "2026-11-13",
  total: 400,
  targets: [{ ...CARD_A, amount: 400, linked: false, paidOff: false }],
  undoable: true,
  ...over,
});
/** The week marked paid: answered, so it pays $0 more and names no target. */
const answeredFirst = (p: AvalancheWeeklyPlan): AvalancheWeeklyPlan => ({
  ...p,
  weeks: [{ ...p.weeks[0]!, answered: true, paid: 0, targets: [] }, ...p.weeks.slice(1)],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.q = ok(plan());
  h.pay = [];
  h.undo = [];
  h.error = null;
  h.refetches = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const box = () => screen.getByTestId("dash-avalanche-week");

describe("Pay this week — to pay", () => {
  it("says how much goes to which card and when, and the button marks that day paid", () => {
    render(<AvalancheWeekBox />);
    expect(box().textContent).toContain("Pay this week");
    expect(screen.getByTestId("avalanche-week-line").textContent).toBe("$400.00 → Card A");
    expect(screen.getByTestId("avalanche-week-when").textContent).toBe("Friday, Nov 13");
    const button = screen.getByTestId("week-pay-button");
    expect(button.textContent).toBe("We paid it");
    // (2026-11-12) Navy is the primary action; orange is kept for warnings.
    expect(button.className).toContain("bg-brand-navy");
    fireEvent.click(button);
    expect(h.pay).toEqual(["2026-11-13"]);
    expect(screen.queryByTestId("week-pay-undo")).toBeNull();
  });

  it("on the payment day itself it says Today", () => {
    h.q = ok(plan({ weeks: [week({ date: "2026-11-10", paid: 300 })] }));
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-when").textContent).toBe("Today");
  });

  it("two cards: the total to both, and each amount on its own line", () => {
    h.q = ok(
      plan({
        weeks: [
          week({
            date: "2026-11-13",
            paid: 1000,
            targets: [
              { ...CARD_A, amount: 600, paidOff: true },
              { ...CARD_B, amount: 400, paidOff: false },
            ],
          }),
        ],
      }),
    );
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-line").textContent).toBe("$1,000.00 → Card A + Card B");
    expect(screen.getAllByTestId("avalanche-week-target").map((e) => e.textContent)).toEqual(["$600.00 → Card A", "$400.00 → Card B"]);
  });

  it("shows the server's words when the press is refused", () => {
    h.error = "This week is already answered. Nothing was changed.";
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("week-pay-error").textContent).toBe("This week is already answered. Nothing was changed.");
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("Pay this week — paid", () => {
  it("two labelled rows: Paid (amount, card, Undo) and Next payment (day, amount, card)", () => {
    h.q = ok({ ...answeredFirst(plan()), lastPaid: paidRec() });
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-paid-row").textContent).toBe("Paid$400.00·Card AUndo");
    expect(screen.getByTestId("avalanche-week-paid-line").textContent).toBe("$400.00·Card A");
    expect(screen.queryByTestId("week-pay-button")).toBeNull();
    expect(box().textContent).not.toContain("PAID OFF");
    expect(screen.getByTestId("avalanche-week-next").textContent).toBe("Next paymentFri Nov 27·$450.00·Card A");
    // One card each: the name is inline and nothing opens.
    expect(box().querySelector("details")).toBeNull();
    // The rows are compact, not a second headline figure.
    expect(box().querySelector(".text-kpi")).toBeNull();
    expect(screen.queryByTestId("avalanche-week-linked")).toBeNull();
    fireEvent.click(screen.getByTestId("week-pay-undo"));
    expect(h.undo).toEqual(["rec-1"]);
  });

  it("a card it paid off wears PAID OFF", () => {
    h.q = ok({ ...answeredFirst(plan()), lastPaid: paidRec({ targets: [{ ...CARD_A, amount: 400, linked: false, paidOff: true }] }) });
    render(<AvalancheWeekBox />);
    expect(box().querySelector(".chip.ok")?.textContent).toBe("PAID OFF");
  });

  it("a card whose balance comes from the bank says when it moves", () => {
    h.q = ok({ ...answeredFirst(plan()), lastPaid: paidRec({ targets: [{ ...CARD_B, amount: 400, linked: true, paidOff: false }] }) });
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-linked").textContent).toBe("Its balance updates when the bank shows the payment.");
  });

  it("two cards paid: '2 cards', and the row opens to each card's line, PAID OFF on the one it cleared, and the bank note", () => {
    h.q = ok({
      ...answeredFirst(plan()),
      lastPaid: paidRec({
        total: 1000,
        targets: [
          { ...CARD_A, amount: 600, linked: false, paidOff: true },
          { ...CARD_B, amount: 400, linked: true, paidOff: false },
        ],
      }),
    });
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-paid-line").textContent).toBe("$1,000.00·2 cards");
    const d = screen.getByTestId("avalanche-week-paid-cards") as HTMLDetailsElement;
    expect(d.tagName).toBe("DETAILS");
    expect(d.open).toBe(false);
    expect(d.className).toContain("disclose");
    // The summary is the row's own words; Undo sits outside it, so a press on Undo never toggles the row.
    expect(d.querySelector("summary")!.textContent).toBe("$1,000.00·2 cards");
    expect(d.querySelector("summary button")).toBeNull();
    expect(d.contains(screen.getByTestId("week-pay-undo"))).toBe(false);
    d.open = true;
    fireEvent(d, new Event("toggle"));
    const lines = screen.getAllByTestId("avalanche-week-target");
    expect(lines.every((l) => d.contains(l))).toBe(true);
    expect(lines.map((e) => e.textContent)).toEqual(["$600.00 to Card APAID OFF", "$400.00 to Card B"]);
    const note = screen.getByTestId("avalanche-week-linked");
    expect(d.contains(note)).toBe(true);
    expect(note.textContent).toBe("Card B: its balance updates when the bank shows the payment.");
  });

  it("one card paid from the bank: the note stays in sight under the Paid row, with nothing to open", () => {
    h.q = ok({ ...answeredFirst(plan()), lastPaid: paidRec({ targets: [{ ...CARD_B, amount: 400, linked: true, paidOff: false }] }) });
    render(<AvalancheWeekBox />);
    expect(screen.queryByTestId("avalanche-week-paid-cards")).toBeNull();
    expect(screen.getByTestId("avalanche-week-paid-row").contains(screen.getByTestId("avalanche-week-linked"))).toBe(true);
  });

  it("a next payment to two cards: '2 cards', and the row opens to each card's amount", () => {
    const p = answeredFirst(plan());
    const two = week({
      date: "2026-11-27",
      paid: 1000,
      targets: [
        { ...CARD_A, amount: 600, paidOff: true },
        { ...CARD_B, amount: 400, paidOff: false },
      ],
    });
    h.q = ok({ ...p, weeks: [p.weeks[0]!, p.weeks[1]!, two], lastPaid: paidRec() });
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-next-line").textContent).toBe("Fri Nov 27·$1,000.00·2 cards");
    const d = screen.getByTestId("avalanche-week-next-cards") as HTMLDetailsElement;
    expect(d.tagName).toBe("DETAILS");
    expect(d.open).toBe(false);
    expect(d.className).toContain("disclose");
    expect(screen.getAllByTestId("avalanche-week-next-target").map((e) => e.textContent)).toEqual(["$600.00 → Card A", "$400.00 → Card B"]);
    // The Paid row above it is one card: plain.
    expect(screen.queryByTestId("avalanche-week-paid-cards")).toBeNull();
  });

  it("no Undo once it cannot be undone (a balance changed, or too long ago)", () => {
    h.q = ok({ ...answeredFirst(plan()), lastPaid: paidRec({ undoable: false }) });
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-paid-line")).toBeTruthy();
    expect(screen.queryByTestId("week-pay-undo")).toBeNull();
  });

  it("the next week's payment, with last week's press still undoable on a quiet line", () => {
    h.q = ok(plan({ lastPaid: paidRec({ date: "2026-11-06" }) }));
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("week-pay-button")).toBeTruthy();
    expect(screen.getByTestId("avalanche-week-earlier").textContent).toContain("Paid $400.00 to Card A on Friday, Nov 6");
    fireEvent.click(screen.getByTestId("week-pay-undo"));
    expect(h.undo).toEqual(["rec-1"]);
  });
});

describe("Pay this week — other states", () => {
  it("nothing safe this week: says so, and the next payment", () => {
    h.q = ok(plan({ weeks: [week({ date: "2026-11-13", paid: 0 }), week({ date: "2026-11-20", paid: 450 })] }));
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-nothing").textContent).toBe(
      "Nothing is safe to pay this week.Next paymentFri Nov 20·$450.00·Card A",
    );
    expect(screen.queryByTestId("week-pay-button")).toBeNull();
  });

  it("answered on the Forecast: says so, with the next payment", () => {
    h.q = ok(answeredFirst(plan()));
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-answered").textContent).toBe(
      "Answered on the ForecastNext paymentFri Nov 27·$450.00·Card A",
    );
    expect(screen.queryByTestId("week-pay-button")).toBeNull();
  });

  it("monthly cadence: nothing at all", () => {
    h.q = ok(plan({ cadence: "monthly", weeks: [] }));
    const { container } = render(<AvalancheWeekBox />);
    expect(container.innerHTML).toBe("");
  });

  it("no debt left: says so", () => {
    h.q = ok(plan({ weeks: [] }));
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-none").textContent).toBe("No debt left for the avalanche to pay.");
  });

  it("loading: a skeleton inside the box, at the slot's size", () => {
    h.q = { data: undefined, isError: false, refetch: () => {} };
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-loading")).toBeTruthy();
    expect(box().className).toContain(`span-${BELOW_FOLD.avalanche.span}`);
    expect(box().className).toContain(BELOW_FOLD.avalanche.minH);
    expect(box().textContent).not.toMatch(/\$/);
  });

  it("no bank linked: the box drops its fixed height with the other panels", () => {
    render(
      <CompactFold.Provider value={true}>
        <AvalancheWeekBox />
      </CompactFold.Provider>,
    );
    expect(box().className).not.toContain(BELOW_FOLD.avalanche.minH);
  });

  it("a failed read says so, with Retry", () => {
    h.q = { data: undefined, isError: true, refetch: () => void (h.refetches += 1) };
    render(<AvalancheWeekBox />);
    expect(screen.getByTestId("avalanche-week-error").textContent).toContain("This week's avalanche did not load.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.refetches).toBe(1);
  });
});

describe("weekPayView / payDayLabel", () => {
  it("picks paid only for this week's press; an older undoable press rides along", () => {
    expect(weekPayView(undefined).kind).toBe("hidden");
    expect(weekPayView(plan({ cadence: "monthly", weeks: [] })).kind).toBe("hidden");
    expect(weekPayView(plan()).kind).toBe("toPay");
    expect(weekPayView({ ...answeredFirst(plan()), lastPaid: paidRec() }).kind).toBe("paid");
    const v = weekPayView(plan({ lastPaid: paidRec({ date: "2026-11-06", undoable: false }) }));
    expect(v).toMatchObject({ kind: "toPay", earlier: null });
    // The next week that pays something, skipping a $0 week.
    expect(weekPayView(plan())).toMatchObject({ next: { date: "2026-11-27" } });
  });

  it("names the day on the household calendar", () => {
    expect(payDayLabel("2026-11-13", "2026-11-10")).toBe("Friday, Nov 13");
    expect(payDayLabel("2026-11-10", "2026-11-10")).toBe("Today");
    expect(payDayLabel("2027-01-01", "2026-11-10")).toBe("Friday, Jan 1");
  });
});

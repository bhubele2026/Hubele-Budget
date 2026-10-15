import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import type { Transaction } from "@workspace/api-client-react";

/**
 * (C9) The shared account-page kit, restyled onto the panel grid. Chase uses
 * it now and Amex next (C10), so the contracts the two ledgers lean on are
 * pinned here rather than in either page's tests:
 *
 * - the ledger panel is sticky-safe, flush and static, and its pane sticks to
 *   the top of `<main>` with no scroll container in between;
 * - day groups keep their head sticky under `--page-sticky-top`, and the row
 *   box is the ledger's `@container` (rows switch to columns on the LEDGER's
 *   width, not the window's);
 * - rows are compact (40 px one-line rhythm) and carry the account accent as
 *   a dot that adds no text;
 * - the trend chart is a panel with a fixed-height body and a collapse
 *   control that remembers its state.
 */

vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/components/merchant-rename-popover", () => ({ MerchantRenamePopover: () => null }));

import { LedgerPanel } from "./ledger-panel";
import { DayGroup } from "./day-group";
import { LedgerColumns } from "./ledger-columns";
import { AccountTransactionRow } from "./transaction-row";
import {
  AMEX_GRID_CATEGORIZE,
  AMEX_GRID_CATEGORIZE_CARD,
  AMEX_GRID_REVIEW,
  AMEX_GRID_REVIEW_CARD,
  LEDGER_GRID,
  LEDGER_GRID_WIDE_ACTIONS,
  amexLedgerGrid,
} from "./ledger-grid";
import { BalanceTrendChart } from "./balance-trend-chart";
import { AccountPageHeader } from "./account-page-header";
import { identityOf } from "@/lib/accountIdentity";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SCROLL_CONTAINER = /\boverflow-(hidden|auto|scroll)\b/;

describe("LedgerPanel", () => {
  it("is a full-width, sticky-safe, flush, static panel whose pane sticks to the top of <main>", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <LedgerPanel title="Transactions" accent="checking" paneRef={ref} pane={<span>controls</span>}>
        <div data-testid="rows">rows</div>
      </LedgerPanel>,
    );
    const panel = screen.getByTestId("ledger-panel");
    for (const c of ["panel", "span-12", "panel-sticky-safe", "panel-flush", "panel-accent-checking"]) {
      expect(panel.className).toContain(c);
    }
    // A ledger is not a link: no hover lift.
    expect(panel.className).not.toContain("panel-link");
    expect(panel.className).not.toMatch(SCROLL_CONTAINER);
    const pane = screen.getByTestId("ledger-pane");
    expect(ref.current).toBe(pane);
    expect(pane.className).toMatch(/^sticky top-0 z-30 /);
    // Nothing between the pane and the panel is a scroll container.
    for (let el = pane.parentElement; el && el !== panel; el = el.parentElement) {
      expect(el.className).not.toMatch(SCROLL_CONTAINER);
    }
    // No entrance transform on the panel that hosts the sticky stack.
    expect(panel.className).not.toContain("tile-in");
    expect(screen.getByTestId("ledger-body").contains(screen.getByTestId("rows"))).toBe(true);
  });
});

describe("DayGroup", () => {
  const group = (variant?: "card" | "flush") =>
    render(
      <DayGroup
        dayKey="2026-10-08"
        count={2}
        isToday
        totalNode={<span>-$10.00</span>}
        selectionState={false}
        onToggleAll={() => {}}
        variant={variant}
        columnHeader={<LedgerColumns />}
      >
        <div data-testid="rows">rows</div>
      </DayGroup>,
    );

  it("flush: a full-width head bar that sticks under the pane, rows in the ledger's @container", () => {
    group("flush");
    const head = screen.getByTestId("day-head-2026-10-08");
    expect(head.className).toContain("sticky");
    expect(head.style.top).toBe("var(--page-sticky-top, 0px)");
    expect(head.className).not.toContain("rounded");
    const box = screen.getByTestId("rows").parentElement!;
    expect(box.className).toContain("@container");
    // The head is OUTSIDE the container box, so it still sticks to <main>.
    expect(box.contains(head)).toBe(false);
    expect(screen.getByTestId("ledger-columns").parentElement).toBe(box);
    expect(head.textContent).toContain("Today");
  });

  it("card (Amex until C10): unchanged head, and the row card is the @container", () => {
    group();
    const box = screen.getByTestId("rows").parentElement!;
    expect(box.className).toContain("@container");
    expect(box.className).toContain("rounded-card");
    expect(screen.queryByTestId("day-head-2026-10-08")).toBeNull();
  });
});

describe("ledger geometry is container-driven", () => {
  it("rows and column heads switch to the grid on the ledger's width (@6xl), never the viewport's xl", () => {
    for (const g of [LEDGER_GRID, LEDGER_GRID_WIDE_ACTIONS]) {
      expect(g).toMatch(/^@6xl:grid-cols-\[/);
      // Seven tracks: select, merchant, card, category, buckets, amount, actions.
      expect(g.split("[")[1]!.split("_")).toHaveLength(7);
    }
    render(<LedgerColumns gridClass={LEDGER_GRID_WIDE_ACTIONS} />);
    const cols = screen.getByTestId("ledger-columns");
    expect(cols.className).toContain("@6xl:grid");
    expect(cols.className).toContain(LEDGER_GRID_WIDE_ACTIONS);
    expect(cols.className).not.toMatch(/(^|\s)xl:/);
  });

  it("(P1) the Amex tracks: a Card column only on All cards, words or marks in the spending column", () => {
    expect(amexLedgerGrid("review", true)).toBe(AMEX_GRID_REVIEW_CARD);
    expect(amexLedgerGrid("review", false)).toBe(AMEX_GRID_REVIEW);
    expect(amexLedgerGrid("categorize", true)).toBe(AMEX_GRID_CATEGORIZE_CARD);
    expect(amexLedgerGrid("categorize", false)).toBe(AMEX_GRID_CATEGORIZE);
    for (const [g, n] of [[AMEX_GRID_REVIEW_CARD, 7], [AMEX_GRID_CATEGORIZE_CARD, 7], [AMEX_GRID_REVIEW, 6], [AMEX_GRID_CATEGORIZE, 6]] as const) {
      expect(g).toMatch(/^@6xl:grid-cols-\[/);
      expect(g.split("[")[1]!.split("_")).toHaveLength(n);
    }
    // The heads drop the Card column with the rows, and name the spending column.
    render(<LedgerColumns gridClass={AMEX_GRID_REVIEW} cardLabel={null} bucketsLabel="Spending" />);
    const cols = screen.getByTestId("ledger-columns");
    expect(cols.children).toHaveLength(6);
    expect(cols.textContent).not.toContain("Card");
    expect(cols.textContent).toContain("Spending");
  });
});

describe("LedgerPanel (P1)", () => {
  it("can leave out the bucket legend and hand its heading to the page", () => {
    const ref = createRef<HTMLDivElement>();
    const title = createRef<HTMLHeadingElement>();
    render(
      <LedgerPanel title="Activity" paneRef={ref} pane={<span />} legend={false} titleRef={title}>
        <div />
      </LedgerPanel>,
    );
    expect(screen.queryByTestId("bucket-legend")).toBeNull();
    expect(title.current?.textContent).toBe("Activity");
    expect(title.current?.getAttribute("tabindex")).toBe("-1");
    cleanup();
    render(
      <LedgerPanel title="Activity" paneRef={ref} pane={<span />}>
        <div />
      </LedgerPanel>,
    );
    expect(screen.getByTestId("bucket-legend")).toBeTruthy();
  });
});

describe("AccountTransactionRow", () => {
  const tx = {
    id: "t1",
    occurredOn: "2026-10-08",
    description: "HY-VEE #1234",
    amount: "-12.00",
    categoryId: null,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    reimbursable: false,
    isTransfer: false,
  } as unknown as Transaction;
  const row = (extra: object = {}) =>
    render(
      <AccountTransactionRow
        tx={tx}
        selected={false}
        onToggleSelect={() => {}}
        categories={[]}
        onCategoryChange={() => {}}
        onBucketToggle={() => {}}
        onQuickDate={() => {}}
        amountNode={<span>-$12.00</span>}
        testId="row-tx-t1"
        {...extra}
      />,
    );

  it("(Q6a) is never faded: a state is a chip, the checkbox names the merchant, edit and delete sit in the row menu", () => {
    const onEdit = vi.fn();
    row({ stateLabel: "Ignored", onEdit, onDelete: () => {} });
    const el = screen.getByTestId("row-tx-t1");
    expect(el.className).not.toMatch(/opacity/);
    expect(screen.getByTestId("chip-state-t1").textContent).toBe("Ignored");
    expect(screen.getByRole("checkbox", { name: "Select HY-VEE #1234" })).toBeTruthy();
    expect(screen.queryByTestId("button-edit-tx-t1")).toBeNull();
    const btn = screen.getByRole("button", { name: "More actions for HY-VEE #1234" });
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("button-edit-tx-t1"), { key: "Enter" });
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("is a compact 40 px row on the container grid it is given", () => {
    row({ gridClass: LEDGER_GRID_WIDE_ACTIONS, cardLabel: "Chase · Plaid ••5526", cardAccent: "checking" });
    const el = screen.getByTestId("row-tx-t1");
    expect(el.className).toContain("min-h-10");
    expect(el.className).toContain("py-0.5");
    expect(el.className).toContain("@6xl:grid");
    expect(el.className).toContain(LEDGER_GRID_WIDE_ACTIONS);
    expect(el.className).not.toMatch(/(^|\s)xl:/);
  });

  it("the account accent is a dot that adds no text: the label still names the account", () => {
    row({ cardLabel: "Chase · Plaid ••5526", cardAccent: "checking" });
    const label = screen.getByTestId("text-card-t1");
    expect(label.textContent).toBe("Chase · Plaid ••5526");
    const dot = label.parentElement!.querySelector('[aria-hidden="true"]')!;
    expect(dot.className).toContain("bg-acct-checking");
    expect(label.parentElement!.textContent).toBe("Chase · Plaid ••5526");
  });

  it("⭐ (F6 round 3) an expired hold says so quietly on the row; any other row carries no such label", () => {
    render(
      <AccountTransactionRow
        tx={{ ...tx, id: "t2", pending: true, expiredHold: true } as Transaction}
        selected={false}
        onToggleSelect={() => {}}
        categories={[]}
        onCategoryChange={() => {}}
        onBucketToggle={() => {}}
        onQuickDate={() => {}}
        amountNode={<span>-$12.00</span>}
        testId="row-tx-t2"
      />,
    );
    const label = screen.getByTestId("label-expired-hold-t2");
    expect(label.textContent).toBe("Expired hold · not counted");
    expect(label.className).toContain("chip gray");
    row();
    expect(screen.queryByTestId("label-expired-hold-t1")).toBeNull();
  });

  it("(P1) with no slots (Chase) the row is unchanged: picker, marks, card cell, state chip, row menu", () => {
    row({ stateLabel: "Reviewed", cardLabel: "Chase ••5526", hideDate: false });
    const el = screen.getByTestId("row-tx-t1");
    expect(screen.getByTestId("button-category-picker")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Weekly bucket" })).toBeTruthy();
    expect(screen.getByTestId("text-card-t1").className).toContain("truncate");
    expect(screen.getByTestId("chip-state-t1").textContent).toBe("Reviewed");
    expect(screen.getByRole("button", { name: "More actions for HY-VEE #1234" })).toBeTruthy();
    expect(el.lastElementChild!.className).not.toContain("basis-full");
  });

  it("(P1) the opt-in slots: own category and spending cells, no card cell, own statuses, a full-width region below", () => {
    row({
      categoryNode: <span data-testid="cat-slot">Dining</span>,
      bucketsNode: <span data-testid="spend-slot">Weekly</span>,
      showCard: false,
      hideRename: true,
      hideDate: true,
      stateLabel: "Ignored",
      statusNode: <span data-testid="status-slot">Pending</span>,
      belowNode: <div data-testid="below-slot">details</div>,
      wrapIndent: true,
    });
    expect(screen.getByTestId("cat-slot")).toBeTruthy();
    expect(screen.queryByTestId("button-category-picker")).toBeNull();
    expect(screen.getByTestId("spend-slot")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Weekly bucket" })).toBeNull();
    expect(screen.queryByTestId("text-card-t1")).toBeNull();
    // The page's statuses replace the state chip.
    expect(screen.getByTestId("status-slot")).toBeTruthy();
    expect(screen.queryByTestId("chip-state-t1")).toBeNull();
    // No row menu (the page moves dates elsewhere).
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    const below = screen.getByTestId("below-slot").parentElement!;
    expect(below.className).toContain("basis-full");
    expect(below.className).toContain("@6xl:col-span-full");
    expect(screen.getByTestId("row-tx-t1").contains(below)).toBe(true);
    // Narrow two-line layout: merchant + amount first, a break, then the rest; the wide grid ignores it.
    const brk = screen.getByTestId("row-tx-t1").querySelector('[aria-hidden="true"].basis-full')!;
    expect(brk.className).toContain("@6xl:hidden");
    expect(brk.className).toContain("order-2");
  });

  it("(P1) a household card name wraps instead of being cut", () => {
    row({ cardLabel: "Platinum Card® ••2007", cardWrap: true });
    expect(screen.getByTestId("text-card-t1").className).not.toContain("truncate");
    expect(screen.getByTestId("text-card-t1").textContent).toBe("Platinum Card® ••2007");
  });

  it("a row with no label shows a dash and no dot (the Amex default grid)", () => {
    row();
    const label = screen.getByTestId("text-card-t1");
    expect(label.textContent).toBe("—");
    expect(label.parentElement!.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByTestId("row-tx-t1").className).toContain(LEDGER_GRID);
  });
});

describe("BalanceTrendChart frame", () => {
  const props = {
    caption: "Checking balance — actual vs forecast",
    subtitle: "May 2026 – Oct 2027",
    historicalActual: [{ date: "2026-10-03", balance: 100 }],
    forecastFromToday: [{ date: "2026-10-08", balance: 120 }],
    actualFromToday: [{ date: "2026-10-08", balance: 120 }],
    todayISO: "2026-10-08",
    accent: "checking" as const,
  };

  it("is a span-12 panel titled by the caption, with a legend and a fixed-height chart body", () => {
    render(<BalanceTrendChart {...props} />);
    const panel = screen.getByTestId("card-balance-trend");
    expect(panel.className).toContain("span-12");
    expect(panel.className).toContain("panel-accent-checking");
    expect(panel.querySelector("h2")!.textContent).toBe(props.caption);
    expect(screen.getByTestId("text-trend-subtitle").textContent).toBe(props.subtitle);
    expect(screen.getByTestId("trend-legend").textContent).toBe("ActualForecastToday");
    expect(panel.querySelector(".h-\\[220px\\]")).toBeTruthy();
  });

  it("collapses and remembers it (localStorage), keeping the chart mounted", () => {
    const { unmount } = render(<BalanceTrendChart {...props} />);
    const toggle = screen.getByTestId("chart-collapse-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem(`h2:chart-collapsed:${props.caption}`)).toBe("1");
    expect(screen.getByTestId("trend-legend").parentElement!.className).toContain("hidden");
    unmount();
    render(<BalanceTrendChart {...props} />);
    expect(screen.getByTestId("chart-collapse-toggle").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("AccountPageHeader", () => {
  it("keeps the page title an h1 and shows the account as its chip under it", () => {
    const identity = identityOf({ id: "a", name: "Total Checking", mask: "5526", type: "depository", subtype: "checking", institutionName: "Chase" });
    render(<AccountPageHeader title="Chase" identity={identity} actions={<button>Sync</button>} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Chase");
    const chip = screen.getByTestId("account-head-identity");
    expect(chip.textContent).toBe("Chase Total Checking••5526");
    expect(chip.querySelector('[data-accent="checking"]')).toBeTruthy();
  });
});

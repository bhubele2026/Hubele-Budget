import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * (W5) /spending/week and /spending/month: the plan, what counts toward it, left
 * or over, the categories behind it and the rows behind those. Synthetic fixtures
 * only. Every figure on the page is the server's string.
 */
const h = vi.hoisted(() => ({
  bd: {} as Record<string, unknown>,
  calls: [] as Array<Record<string, unknown>>,
  plans: undefined as unknown,
  items: undefined as unknown,
  me: { isOwner: true } as unknown,
  budget: undefined as unknown,
  create: vi.fn(),
  dry: undefined as unknown,
  dryFails: false,
}));

vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react")>()),
  useListPlaidItems: () => ({ data: h.items, isError: false, isLoading: false }),
  useGetMe: () => ({ data: h.me, isLoading: false }),
  useGetBudgetMonth: () => ({ data: h.budget, isError: false }),
}));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react/features")>()),
  useListAllowancePlans: () => ({ data: h.plans, isLoading: false }),
  useCreateAllowancePlan: () => ({ mutate: h.create, isPending: false }),
  useGetPeriodBreakdown: (params: Record<string, unknown>) => {
    h.calls.push(params);
    const key = `${params.period}:${params.start}`;
    const base = (h.bd[key] ?? h.bd[String(params.period)]) as Record<string, unknown> | undefined;
    // The server marks the period it was asked for; the fixture follows the request.
    const data = base && { ...base, start: params.start, isCurrent: params.start === "2026-10-11" || params.start === "2026-10-01" };
    return { data, isError: false, isLoading: false, refetch: vi.fn() };
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import SpendingPeriodPage from "./spending-period";

const TODAY = new Date("2026-10-14T17:00:00Z"); // Wed 12:00 Central; this week starts Sun 2026-10-11

const acct = { id: "r-1", institution: "American Express", name: "Platinum", mask: "1001" };
const row = (id: string, amount: string, o: Record<string, unknown> = {}) => ({
  id, date: "2026-10-12", displayName: `Shop ${id}`, amount, account: acct, pending: false,
  category: null, reason: { coverage: "allowance_weekly", nets: null, rule: "weekly_flag" }, splitPart: null, ...o,
});
const cat = (id: string, name: string, amount: string, o: Record<string, unknown> = {}) => ({
  categoryId: id, name, amount, shareBp: 1000, count: 1, usual: "40.00", usualFullPeriod: "90.00", aboveUsual: "0.00",
  rows: [row(`${id}-1`, amount)], truncated: false, ...o,
});
const group = (amount: string, count: number, rows: unknown[] = []) => ({ amount, count, rows, truncated: false, countsAgainstPlan: true });
const none = { amount: "0.00", count: 0, rows: [] as unknown[], truncated: false };
const evidence = (reason: string, items: unknown[] = [], suggestion: unknown = null) => ({ class: reason === "card_payment" ? "confirmed_payment" : "unresolved", reason, items, suggestion });
const bd = (o: Record<string, unknown> = {}) => ({
  period: "week", basis: "weekly_allowance", start: "2026-10-11", end: "2026-10-17", isCurrent: true, timezone: "America/Chicago",
  scope: { kind: "household", id: null, institution: null, name: null, mask: null }, planScope: "household",
  plan: { status: "set", amount: "300.00", source: "plan", planId: "p1", effectiveFrom: "2026-05-03" },
  carryOver: null, actual: "324.50", known: "324.50", remaining: "-24.50", over: "24.50", withinPlan: false, provisional: false,
  unresolved: { ...none, nettedByRefunds: "0.00" }, excludedPayments: none, usualBasis: "same_days", usualThrough: "2026-10-14",
  categories: [cat("c-gro", "Groceries", "156.60", { usual: "45.00", aboveUsual: "111.60" }), cat("c-gas", "Gas", "92.40"), cat("c-home", "Home", "50.00")],
  needsClassification: group("25.50", 1, [row("u1", "25.50", { reason: { coverage: "needs_classification", nets: null, rule: "unfiled" } })]),
  refundFloorAdjustment: "0.00",
  beside: { unplanned: "85.00", weekly: null, monthly: "30.00", billMatched: "0.00", reimbursable: "0.00", householdSpend: "439.50" },
  limitations: [], ...o,
});
const notSet = () =>
  bd({ plan: { status: "not_set", amount: null, source: "plan", planId: null, effectiveFrom: null }, remaining: null, over: null, withinPlan: null, actual: "125.50",
    known: "125.50", categories: [cat("c-gro", "Groceries", "100.00")], needsClassification: group("25.50", 1, [row("u1", "25.50", { reason: { coverage: "needs_classification", nets: null, rule: "unfiled" } })]) });

const prefills = [
  { period: "weekly", amount: "380.00", source: "hook_stored", label: "Weekly Spend reserve" },
  { period: "weekly", amount: "350.00", source: "suggested", label: "Suggested" },
  { period: "monthly", amount: "600.00", source: "settings", label: "Saved allowance" },
];

function mount(path: string, view: "week" | "month" = "week") {
  window.history.replaceState(null, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <SpendingPeriodPage view={view} />
    </QueryClientProvider>
  );
  return { ...render(ui), ui };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  h.bd = { week: bd(), month: bd({ period: "month", basis: "monthly_allowance", start: "2026-10-01", end: "2026-10-31" }) };
  h.calls = [];
  h.plans = { plans: [], prefills };
  h.items = [
    {
      id: "i1", itemId: "pi-1", institutionName: "American Express", institutionSlug: "amex", lastSyncedAt: "2026-10-14T12:00:00Z",
      lastSyncError: null, lastSyncErrorCode: null,
      accounts: [{ id: "r-1", accountId: "p-r-1", name: "Platinum", mask: "1001", type: "credit", subtype: "credit card" }],
    },
  ];
  h.me = { isOwner: true };
  h.budget = undefined;
  h.create.mockReset();
  h.dryFails = false;
  h.dry = {
    dryRun: true, allowed: true, reason: null,
    plan: { period: "weekly", amount: "380.00", effectiveFrom: "2026-10-11" },
    occurrences: [
      { planKey: "ws|2026-10-17", hook: "weekly", occurrenceDate: "2026-10-17", label: "Weekly Spend", cards: [],
        before: { amount: "450.00", onCurve: "450.00", basis: "stored_amount", incurred: "120.00", paid: "0.00", carried: "0.00", allowanceLeft: "330.00" },
        after: { amount: "240.00", onCurve: "240.00", basis: "plan", incurred: "120.00", paid: "0.00", carried: "0.00", allowanceLeft: "120.00" } },
    ],
    lowPoint: { before: { amount: "1941.95", date: "2026-10-20" }, after: { amount: "2151.95", date: "2026-10-20" } },
  };
  // The dry run answers; a real POST just records itself.
  h.create.mockImplementation((args: { params?: { dryRun?: string } }, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
    if (args.params?.dryRun) {
      if (h.dryFails) opts?.onError?.(new Error("down"));
      else opts?.onSuccess?.(h.dry);
    }
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const cents = (s: string) => Math.round(Number(s.replace(/[^0-9.-]/g, "")) * 100);

/** The real writes (the dry run is also a POST, with `dryRun` in its params). */
const posts = () => h.create.mock.calls.filter((c) => !(c[0] as { params?: unknown }).params);
const dryCalls = () => h.create.mock.calls.filter((c) => (c[0] as { params?: unknown }).params);

const unresolvedRow = (id: string, amount: string, name: string, ev: unknown) =>
  row(id, amount, { displayName: name, category: null, reason: { coverage: "needs_classification", nets: null, rule: "unfiled" }, evidence: ev });
const loanEv = evidence("loan_payment", [{ field: "pfc_primary", value: "LOAN_PAYMENTS" }], { kind: "loan_payment", detail: null, target: null });
const savingsEv = evidence("transfer_evidence", [], { kind: "transfer", detail: "savings", target: null });
const provisional = () => {
  const fig = unresolvedRow("fig", "1150.40", "Lrk Loans", loanEv);
  const pear = unresolvedRow("pear", "20.00", "Pear Savings", savingsEv);
  return bd({
    actual: "1529.69", known: "324.50", remaining: "-24.50", over: "24.50", provisional: true,
    needsClassification: group("1230.69", 3, [fig, pear, row("u1", "25.50", { reason: { coverage: "needs_classification", nets: null, rule: "unfiled" } })]),
    unresolved: { amount: "1170.40", nettedByRefunds: "0.00", count: 2, rows: [fig, pear], truncated: false },
    excludedPayments: { amount: "95.00", count: 1, truncated: false, rows: [row("pay", "95.00", { displayName: "Wireless Co Bill Pay", evidence: evidence("card_payment") })] },
  });
};

describe("This week", () => {
  it("names the period and the scope", () => {
    mount("/spending/week");
    expect(screen.getByTestId("sp-title").textContent).toBe("This week · Sun Oct 11 – Sat Oct 17");
    expect(screen.getByTestId("sp-scope").textContent).toBe("Household · weekly plan");
  });

  it("plan not set: says so, never $0 or Over, and offers the stored amount", () => {
    h.bd.week = notSet();
    mount("/spending/week");
    expect(screen.getByTestId("sp-plan").textContent).toBe("Plan not set");
    expect(screen.getByTestId("sp-left").textContent).toBe("—");
    const summary = screen.getByTestId("sp-summary").textContent ?? "";
    expect(summary).not.toMatch(/Over/);
    expect(summary).not.toMatch(/\$0\.00/);
    expect(screen.getByTestId("plan-use-primary").textContent).toBe("Use $380.00 as the weekly plan from this week");
    expect(screen.queryByText("Why over?")).toBeNull();
    expect(screen.getByText("Where it went")).toBeTruthy();
  });

  it("one tap, then confirm: the dry run loads first; the POST is sent only after Confirm, from this Sunday", async () => {
    h.bd.week = notSet();
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    const dlg = screen.getByTestId("plan-confirm");
    expect(within(dlg).getByTestId("plan-confirm-amount").textContent).toBe("$380.00");
    expect(within(dlg).getByTestId("plan-confirm-start").textContent).toBe("Sun Oct 11");
    expect(dlg.textContent).toMatch(/Past weeks keep their plan/);
    await waitFor(() => expect(within(dlg).getByTestId("plan-dry-run")).toBeTruthy());
    expect(posts()).toHaveLength(0);
    expect(dryCalls()[0]![0]).toEqual({ data: { period: "weekly", amount: "380.00", effectiveFrom: "2026-10-11" }, params: { dryRun: "1" } });
    fireEvent.click(within(dlg).getByTestId("plan-confirm-go"));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toEqual({ data: { period: "weekly", amount: "380.00", effectiveFrom: "2026-10-11" } });
  });

  it("the plan dialog says, per Saturday, what the reserve is made of and where the low point moves", async () => {
    h.bd.week = notSet();
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    const dlg = screen.getByTestId("plan-confirm");
    await waitFor(() => expect(within(dlg).getByTestId("dry-reserve")).toBeTruthy());
    expect(within(dlg).getByTestId("dry-reserve").textContent).toBe(
      "Weekly Spend reserve $450.00 → $240.00 = card purchases $120.00 + carried $0.00 + left to spend $120.00",
    );
    expect(within(dlg).getByTestId("dry-low").textContent).toBe("Lowest point$1,941.95 on Tue Oct 20 → $2,151.95 on Tue Oct 20");
  });

  it("Set plan stays off until the dry run is in", () => {
    h.bd.week = notSet();
    h.create.mockImplementation(() => {}); // the dry run never answers
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    const go = screen.getByTestId("plan-confirm-go") as HTMLButtonElement;
    expect(screen.getByTestId("plan-effect-loading")).toBeTruthy();
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(posts()).toHaveLength(0);
  });

  it("a plan the server refuses shows its one-line reason and the button stays off", async () => {
    h.bd.week = notSet();
    h.dry = { ...(h.dry as object), allowed: false, reason: "Platinum has no payoff mode yet. Choose how it is paid first." };
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    await waitFor(() => expect(screen.getByTestId("plan-refused")).toBeTruthy());
    expect(screen.getByTestId("plan-refused").textContent).toBe("Platinum has no payoff mode yet. Choose how it is paid first.");
    expect((screen.getByTestId("plan-confirm-go") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("plan-confirm-go"));
    expect(posts()).toHaveLength(0);
  });

  it("a dry run that fails to load says so and cannot be confirmed", async () => {
    h.bd.week = notSet();
    h.dryFails = true;
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    await waitFor(() => expect(screen.getByTestId("plan-effect-failed")).toBeTruthy());
    expect((screen.getByTestId("plan-confirm-go") as HTMLButtonElement).disabled).toBe(true);
  });

  it("cancel sends nothing", () => {
    h.bd.week = notSet();
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    fireEvent.click(screen.getByTestId("plan-cancel"));
    expect(posts()).toHaveLength(0);
    expect(screen.queryByTestId("plan-confirm")).toBeNull();
  });

  it("a different amount is typed, checked, then sent the same way", async () => {
    h.bd.week = notSet();
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-different"));
    fireEvent.change(screen.getByTestId("plan-input"), { target: { value: "275.5" } });
    await waitFor(() => expect(screen.getByTestId("plan-dry-run")).toBeTruthy());
    expect(dryCalls().at(-1)![0]).toMatchObject({ data: { amount: "275.50" }, params: { dryRun: "1" } });
    fireEvent.click(screen.getByTestId("plan-confirm-go"));
    expect(posts()[0]![0]).toEqual({ data: { period: "weekly", amount: "275.50", effectiveFrom: "2026-10-11" } });
  });

  it("over: says Over $X, sorts categories by amount, chips what is above usual (in a warning chip, by the weekday)", () => {
    h.bd.week = bd({ categories: [cat("c-home", "Home", "50.00"), cat("c-gro", "Groceries", "156.60", { usual: "45.00", aboveUsual: "111.60" }), cat("c-gas", "Gas", "92.40")] });
    mount("/spending/week");
    expect(screen.getByTestId("sp-left").textContent).toBe("$24.50");
    expect(screen.getByTestId("sp-summary").textContent).toMatch(/Over/);
    expect(screen.getByText("Why over?")).toBeTruthy();
    const order = screen.getAllByTestId(/^sp-group-amount-c-/).map((n) => n.textContent);
    expect(order).toEqual(["$156.60", "$92.40", "$50.00"]);
    expect(screen.getByTestId("sp-usual-c-gro").textContent).toBe("usual by Wed $45.00");
    const chip = screen.getByTestId("sp-above-c-gro");
    expect(chip.textContent).toBe("above usual $111.60");
    expect(chip.className).toContain("warn");
    expect(chip.className).not.toContain("bad");
    expect(screen.queryByTestId("sp-above-c-gas")).toBeNull();
  });

  it("one summary line under Why over?: the over, the category above its usual so far, the plan", () => {
    h.bd.week = bd({ categories: [cat("c-gro", "Groceries", "156.60", { usual: "45.00", aboveUsual: "111.60" }), cat("c-gas", "Gas", "92.40", { usual: "80.00", aboveUsual: "12.40" })] });
    mount("/spending/week");
    expect(screen.getByTestId("sp-why-line").textContent).toBe("Over $24.50 · Groceries $156.60 so far vs usual by Wed $45.00 · plan $300.00");
  });

  it("a past period's usual is a whole period, and says so", () => {
    h.bd.week = bd({ usualBasis: "full_period", usualThrough: null });
    mount("/spending/week");
    expect(screen.getByTestId("sp-usual-c-gro").textContent).toBe("usual for a full week $45.00");
  });

  it("transactions, not purchases: refunds and split parts are counted too", () => {
    mount("/spending/week");
    expect(screen.getByTestId("sp-group-c-gro").textContent).toContain("1 transaction");
    expect(screen.getByTestId("sp-group-c-gro").textContent).not.toMatch(/purchase/);
  });

  it("the known group's visible lines add up to Counts toward plan, to the cent", () => {
    mount("/spending/week");
    const cats = screen.getAllByTestId(/^sp-group-amount-c-/).map((n) => cents(n.textContent!));
    fireEvent.click(screen.getByTestId("sp-group-unfiled"));
    const unfiled = screen.getAllByTestId("sp-row-amount").map((n) => cents(n.textContent!));
    expect(unfiled).toHaveLength(1);
    expect(cats.reduce((a, b) => a + b, 0) + unfiled.reduce((a, b) => a + b, 0)).toBe(cents(screen.getByTestId("sp-known-amount").textContent!));
    expect(screen.getByTestId("sp-known-amount").textContent).toBe(screen.getByTestId("sp-actual").textContent);
    expect(screen.getByTestId("sp-left").textContent).toBe("$24.50");
  });

  it("expanded group and period live in the URL and survive a remount", () => {
    const { unmount, ui } = mount("/spending/week?start=2026-10-04");
    expect(h.calls.at(-1)).toMatchObject({ period: "week", start: "2026-10-04" });
    fireEvent.click(screen.getByTestId("sp-group-c-gro"));
    expect(window.location.search).toContain("open=c-gro");
    expect(window.location.search).toContain("start=2026-10-04");
    expect(screen.getAllByTestId("sp-row")).toHaveLength(1);
    unmount();
    render(ui);
    expect(screen.getByTestId("sp-title").textContent).toBe("Week · Sun Oct 4 – Sat Oct 10");
    expect(screen.getAllByTestId("sp-row")).toHaveLength(1);
  });

  it("arrows move one week; next stops at this week", () => {
    mount("/spending/week");
    expect((screen.getByTestId("sp-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("sp-prev"));
    expect(window.location.search).toContain("start=2026-10-04");
    expect(h.calls.at(-1)).toMatchObject({ start: "2026-10-04" });
    fireEvent.click(screen.getByTestId("sp-next"));
    expect(window.location.search).not.toContain("start=");
  });

  it("a row shows its account chip and opens its register", () => {
    mount("/spending/week?open=c-gro");
    expect(screen.getByTestId("sp-row-account").textContent).toBe("Platinum ••1001");
    expect(screen.getByTestId("sp-row-link").getAttribute("href")).toMatch(/^\/amex\?card=p-r-1&month=2026-10-01&tx=c-gro-1/);
  });

  it("Not filed yet is its own group, with its words and a link to Categories", () => {
    mount("/spending/week");
    const u = screen.getByTestId("sp-unfiled");
    expect(u.textContent).toMatch(/Counts toward the weekly plan until filed/);
    expect(within(u).getByTestId("sp-file-link").getAttribute("href")).toBe("/review/categories");
  });

  it("Details names the other figures and the one-sentence rule", () => {
    mount("/spending/week");
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByTestId("sp-d-household").textContent).toBe("$439.50");
    expect(screen.getByTestId("sp-d-unplanned").textContent).toBe("$85.00");
    expect(screen.getByTestId("sp-d-other").textContent).toBe("$30.00");
    expect(screen.getByTestId("sp-d-why").textContent).toMatch(/weekly purchases and ones not filed yet/);
    // the whole-week usual sits under Details when the headline usual is read to today
    expect(screen.getByTestId("sp-d-fullusual").textContent).toMatch(/A full week is usually/);
    expect(screen.getByTestId("sp-d-fullusual").textContent).toContain("$90.00");
  });
});

describe("This week — provisional", () => {
  it("says Provisional, with one line naming the biggest unconfirmed row, and never the bare word Over", () => {
    h.bd.week = provisional();
    mount("/spending/week");
    expect(screen.getByTestId("sp-provisional").textContent).toBe("Provisional");
    expect(screen.getByTestId("sp-provisional-line").textContent).toBe("Unconfirmed $1,170.40 may change this · Lrk Loans — bank says loan payment");
    expect(screen.getByTestId("sp-summary").textContent).toContain("Over so far");
    expect(screen.getByTestId("sp-summary").textContent).not.toMatch(/Over\$/);
    expect(screen.getByText("Why over so far?")).toBeTruthy();
    // the headline is the KNOWN figure, not the cautious one
    expect(screen.getByTestId("sp-actual").textContent).toBe("$324.50");
    expect(screen.getByTestId("sp-why-line").textContent).toMatch(/^Over so far \$24\.50/);
  });

  it("not provisional: no marker, no line", () => {
    mount("/spending/week");
    expect(screen.queryByTestId("sp-provisional")).toBeNull();
    expect(screen.queryByTestId("sp-provisional-line")).toBeNull();
    expect(screen.queryByTestId("sp-unconfirmed")).toBeNull();
    expect(screen.queryByTestId("sp-payments")).toBeNull();
  });

  it("three groups: counts toward plan, payments and transfers (not spending), unconfirmed", () => {
    h.bd.week = provisional();
    mount("/spending/week");
    expect(screen.getByTestId("sp-known").textContent).toContain("Counts toward plan");
    expect(screen.getByTestId("sp-payments").textContent).toContain("Payments & transfers (not spending)");
    expect(screen.getByTestId("sp-unconfirmed").textContent).toContain("Unconfirmed");
    expect(screen.getByTestId("sp-group-amount-payments").textContent).toBe("$95.00");
    expect(screen.getByTestId("sp-group-amount-unconfirmed").textContent).toBe("$1,170.40");
  });

  it("each group's visible rows add up to its figure, and the unconfirmed rows are not in the known group", () => {
    h.bd.week = provisional();
    mount("/spending/week?open=payments,unconfirmed,unfiled");
    const sum = (scope: HTMLElement) => within(scope).getAllByTestId("sp-row-amount").map((n) => cents(n.textContent!)).reduce((a, b) => a + b, 0);
    expect(sum(screen.getByTestId("sp-payments"))).toBe(cents(screen.getByTestId("sp-group-amount-payments").textContent!));
    expect(sum(screen.getByTestId("sp-unconfirmed"))).toBe(cents(screen.getByTestId("sp-group-amount-unconfirmed").textContent!));
    // Known = categories + the unfiled rows that are NOT unconfirmed.
    const known = screen.getByTestId("sp-known");
    const cats = within(known).getAllByTestId(/^sp-group-amount-c-/).map((n) => cents(n.textContent!)).reduce((a, b) => a + b, 0);
    expect(cats + sum(screen.getByTestId("sp-unfiled"))).toBe(cents(screen.getByTestId("sp-known-amount").textContent!));
    expect(within(known).queryByText("Lrk Loans")).toBeNull();
    expect(within(screen.getByTestId("sp-unconfirmed")).getByText("Lrk Loans")).toBeTruthy();
  });

  it("an unconfirmed row says what the evidence is and why it is not counted yet; the payment says why it is not spending", () => {
    h.bd.week = provisional();
    mount("/spending/week?open=payments,unconfirmed");
    const notes = within(screen.getByTestId("sp-unconfirmed")).getAllByTestId("sp-row-note").map((n) => n.textContent);
    expect(notes[0]).toBe("Not counted yet: bank says loan payment.");
    expect(notes[1]).toBe("Not counted yet: bank says a transfer to savings.");
    expect(within(screen.getByTestId("sp-payments")).getByTestId("sp-row-note").textContent).toBe("Card payment");
  });

  it("Unconfirmed links to the proposed fixes on Banking review", () => {
    h.bd.week = provisional();
    mount("/spending/week");
    expect(screen.getByTestId("sp-fixes-link").getAttribute("href")).toBe("/banking?fixes=1");
  });
});

describe("This month", () => {
  const month = () => bd({
    period: "month", basis: "monthly_allowance", start: "2026-10-01", end: "2026-10-31",
    plan: { status: "set", amount: "400.00", source: "plan", planId: "p2", effectiveFrom: "2026-05-01" },
    actual: "440.00", known: "440.00", remaining: "-40.00", over: "40.00", categories: [cat("c-home", "Home", "380.00", { usual: "300.00", aboveUsual: "80.00" }), cat("c-health", "Health", "60.00")],
    needsClassification: { amount: "0.00", count: 0, rows: [], truncated: false, countsAgainstPlan: false },
    beside: { unplanned: "85.00", weekly: "324.50", monthly: null, billMatched: "0.00", reimbursable: "0.00", householdSpend: "849.50" },
  });

  it("keeps the monthly allowance and the household budget apart, both labelled", () => {
    h.bd.month = month();
    h.budget = { summary: { expenses: { budget: "5200.00", actual: "4100.00" } }, spendingReconciliation: null };
    mount("/spending/month", "month");
    expect(screen.getByTestId("sp-title").textContent).toBe("Monthly allowance · October 2026");
    expect(screen.getByTestId("sp-scope").textContent).toBe("Household · monthly plan");
    expect(screen.getByTestId("sp-plan").textContent).toBe("$400.00");
    expect(screen.getByTestId("sp-left").textContent).toBe("$40.00");
    const hb = screen.getByTestId("sp-household-budget");
    expect(hb.textContent).toMatch(/Household budget/);
    expect(hb.textContent).toMatch(/includes debt payments/);
    expect(within(hb).getByTestId("sp-hb-planned").textContent).toBe("$5,200.00");
    expect(within(hb).getByTestId("sp-hb-actual").textContent).toBe("$4,100.00");
    expect(within(hb).getByTestId("sp-hb-link").getAttribute("href")).toBe("/budget?month=2026-10-01");
    // the allowance summary does not carry the budget's figures
    expect(screen.getByTestId("sp-summary").textContent).not.toMatch(/5,200/);
    expect(screen.queryByTestId("sp-unfiled")).toBeNull();
  });

  it("usual by Oct 14, an above-usual warning chip, one why line, and the full month under Details", () => {
    h.bd.month = month();
    mount("/spending/month", "month");
    expect(screen.getByTestId("sp-usual-c-home").textContent).toBe("usual by Oct 14 $300.00");
    expect(screen.getByTestId("sp-above-c-home").className).toContain("warn");
    expect(screen.getByTestId("sp-why-line").textContent).toBe("Over $40.00 · Home $380.00 so far vs usual by Oct 14 $300.00 · plan $400.00");
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByTestId("sp-d-fullusual").textContent).toMatch(/A full month is usually/);
  });

  it("monthly not set: Plan not set, saved allowance offered, no default primary", async () => {
    h.bd.month = { ...month(), plan: { status: "not_set", amount: null, source: "plan", planId: null, effectiveFrom: null }, remaining: null, over: null, withinPlan: null };
    mount("/spending/month", "month");
    expect(screen.getByTestId("sp-plan").textContent).toBe("Plan not set");
    expect(screen.queryByTestId("plan-use-primary")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-use-settings"));
    await waitFor(() => expect(screen.getByTestId("plan-dry-run")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plan-confirm-go"));
    expect(posts()[0]![0]).toEqual({ data: { period: "monthly", amount: "600.00", effectiveFrom: "2026-10-01" } });
  });
});

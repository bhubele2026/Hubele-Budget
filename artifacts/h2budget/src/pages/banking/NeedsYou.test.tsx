import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * ⭐ (2026-11-12) Banking's "Needs you" against a fake server: `fetch` is
 * replaced and the real hooks run, so the URLs, methods and bodies are what the
 * app sends. An invented household only ("Card A", "Cedar Hollow Bank").
 */
const h = vi.hoisted(() => ({
  toasts: [] as Array<{ title: string; actions?: Array<{ label: string; onClick: () => void }> }>,
}));
vi.mock("@/components/ui/action-toast", () => ({
  toastWithActions: (t: { title: string; actions?: Array<{ label: string; onClick: () => void }> }) => h.toasts.push(t),
}));
vi.mock("@/hooks/use-toast", () => ({
  toast: (t: { title: string }) => {
    h.toasts.push(t);
    return { id: "t", dismiss: () => {}, update: () => {} };
  },
  useToast: () => ({ toast: () => ({ id: "t" }) }),
}));

import { NeedsYou, NEEDS_YOU_HINT, matchCandidates } from "./NeedsYou";
import { planOccurrenceOf } from "./needsYouApi";

interface Call { method: string; path: string; body: unknown }
let calls: Call[] = [];
let needsYou: unknown;
let failWrites = false;

const CATEGORIES = [
  { id: "cat-g", name: "Groceries", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 1 },
  { id: "cat-f", name: "Fuel", kind: "expense", groupName: "Transport", sourceKind: "manual", sortOrder: 1 },
];
const ITEMS = [
  {
    id: "n1", txId: "tx-1", accountName: "Cedar Hollow Bank Checking", mask: "1234", date: "2026-11-03", name: "Pine Mutual Auto", amount: "-112.00", pending: false, categoryName: "Insurance",
    kind: "match", suggestion: { label: "the Car insurance payment, planned $112.00 on Nov 3", planOccurrenceId: "ri-car|2026-11-03", confidence: "medium" },
    reason: "Looks like the Car insurance payment, planned $112.00 on Nov 3. Confirm the match or pick another.",
  },
  {
    id: "n2", txId: "tx-2", accountName: "Card A", mask: "9876", date: "2026-11-04", name: "Corner Market", amount: "-42.10", pending: false, categoryName: null,
    kind: "category", suggestion: { label: "Groceries", categoryId: "cat-g", reviewItemId: "rv-2", confidence: "medium" },
    reason: "A new merchant.",
  },
  {
    id: "n3", txId: "tx-3", accountName: "Cedar Hollow Bank Checking", mask: "1234", date: "2026-11-05", name: "Transfer 0042", amount: "-300.00", pending: true, categoryName: null,
    kind: "match", suggestion: null, reason: "Two planned bills could fit.",
  },
  {
    id: "n4", txId: "tx-4", accountName: "Card A", mask: "9876", date: "2026-11-06", name: "Fill Up Station", amount: "-38.00", pending: false, categoryName: "Dining out",
    kind: "category", suggestion: { label: "Fuel", categoryId: "cat-f", confidence: "low" },
    reason: "Seen once before.",
  },
];
const PLANNED = [
  { key: "ri-car|2026-11-03", itemId: "ri-car", label: "Car insurance", scheduledDate: "2026-11-03", occurrenceDate: "2026-11-03", planned: "-112.00", fate: "suggested", direction: "out", txnId: null, txnDate: null, txnAmount: null, txnOnThisAccount: false, difference: null, dayDelta: null },
  { key: "ri-gym|2026-11-05", itemId: "ri-gym", label: "Gym", scheduledDate: "2026-11-05", occurrenceDate: "2026-11-05", planned: "-30.00", fate: "on_curve", direction: "out", txnId: null, txnDate: null, txnAmount: null, txnOnThisAccount: false, difference: null, dayDelta: null },
  { key: "ri-rent|2026-11-01", itemId: "ri-rent", label: "Rent", scheduledDate: "2026-11-01", occurrenceDate: "2026-11-01", planned: "-900.00", fate: "matched", direction: "out", txnId: "tx-9", txnDate: "2026-11-01", txnAmount: "-900.00", txnOnThisAccount: true, difference: "0.00", dayDelta: 0 },
  { key: "ri-pay|2026-11-07", itemId: "ri-pay", label: "Pay", scheduledDate: "2026-11-07", occurrenceDate: "2026-11-07", planned: "1500.00", fate: "on_curve", direction: "in", txnId: null, txnDate: null, txnAmount: null, txnOnThisAccount: false, difference: null, dayDelta: null },
];
const body = (items = ITEMS, auto = { matched: 5, categorized: 2, since: "2026-11-03" }) => ({ throughDate: "2026-11-10", count: items.length, items, autoDone: auto });
const RESOLUTION = { id: "res-1", replaced: [] };
const AUTO_DONE = {
  since: "2026-11-03", matched: 1, categorized: 1, truncated: false,
  items: [
    { kind: "match", undoId: "res-auto-1", txnId: "tx-8", at: "2026-11-09T15:00:00.000Z", planKey: "ri-gym|2026-11-05", categoryId: null, label: "Gym" },
    { kind: "category", undoId: "dec-auto-2", txnId: "tx-9", at: "2026-11-08T15:00:00.000Z", planKey: null, categoryId: "cat-g", label: "Groceries" },
  ],
};
const RESOLVED = { userDecisionId: "ud-1", retroactiveCandidates: { count: 0 } };

function reply(c: Call): [number, unknown] {
  if (c.method === "GET" && c.path === "/api/banking/needs-you") return [200, needsYou];
  if (c.method === "GET" && c.path === "/api/budget/categories") return [200, CATEGORIES];
  if (c.method === "GET" && c.path === "/api/transactions") return [200, []];
  if (c.method === "GET" && c.path === "/api/banking/auto-done") return [200, AUTO_DONE];
  if (c.method === "POST" && /^\/api\/category-decisions\/[^/]+\/undo$/.test(c.path)) return [200, { id: "ud" }];
  if (failWrites && c.method !== "GET") return [500, { error: "nope" }];
  if (c.method === "POST" && c.path === "/api/forecast/resolutions") return [200, RESOLUTION];
  if (c.method === "POST" && /^\/api\/forecast\/resolutions\/[^/]+\/undo$/.test(c.path)) return [200, { undone: "res-1", restored: 0 }];
  if (c.method === "POST" && /^\/api\/categorization\/review\/[^/]+\/(accept|correct)$/.test(c.path)) return [200, RESOLVED];
  if (c.method === "PATCH" && /^\/api\/transactions\/[^/]+$/.test(c.path)) return [200, { id: c.path.split("/").pop(), ruleAction: { kind: "none" } }];
  return [404, { error: "not found" }];
}

beforeEach(() => {
  calls = [];
  needsYou = body();
  failWrites = false;
  h.toasts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://x.test");
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const [status, payload] = reply(call);
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }),
  );
  window.history.replaceState(null, "", "/banking");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NeedsYou planned={PLANNED as never} />
    </QueryClientProvider>,
  );
}
const rows = () => screen.queryAllByTestId("ny-item");
const writes = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path));

describe("Needs you — the list", () => {
  it("opens on the count and one row per item: date, name, account ••mask, pending, amount, what H2 thinks", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    expect(screen.getByTestId("ny-count").textContent).toBe(" (4)");
    expect(screen.getByRole("heading", { name: /Needs you/ })).toBeTruthy();
    // (Fewer words) What Match and Category mean is one hover away: the "?" beside the title.
    expect(within(screen.getByTestId("ny-hint")).getByRole("note").getAttribute("aria-label")).toBe(NEEDS_YOU_HINT);
    const first = rows()[0]!;
    expect(first.textContent).toContain("Nov 3");
    expect(first.textContent).toContain("Pine Mutual Auto");
    expect(screen.getByTestId("ny-account-n1").textContent).toBe("Cedar Hollow Bank Checking ••1234");
    expect(screen.getByTestId("ny-amount-n1").textContent).toBe("-$112.00");
    expect(screen.getByTestId("ny-think-n1").textContent).toBe("Looks like the Car insurance payment, planned $112.00 on Nov 3");
    expect(screen.getByTestId("ny-think-n2").textContent).toBe("Looks like Groceries");
    // (Fewer words) No suggestion: no line — the state badge says it waits; the reason is in the drawer.
    expect(screen.queryByTestId("ny-think-n3")).toBeNull();
    expect(within(rows()[2]!).getByText("Pending")).toBeTruthy();
    expect(within(rows()[0]!).queryByText("Pending")).toBeNull();
    // Only the one bounded read: the list, no transactions until a row is opened.
    expect(calls.filter((c) => c.path === "/api/transactions").length).toBe(0);
  });

  it("each row says its category today when the server sends it ('No category' for none)", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    expect(screen.getByTestId("ny-cat-n2").textContent).toBe("Category: No category");
    expect(screen.getByTestId("ny-cat-n4").textContent).toBe("Category: Dining out");
    expect(screen.getByTestId("ny-cat-n1").textContent).toBe("Category: Insurance");
  });

  it("a truncated list says how many it shows of how many wait; the count is the server's", async () => {
    needsYou = { ...body(), count: 30, truncated: true };
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    expect(screen.getByTestId("ny-count").textContent).toBe(" (30)");
    expect(screen.getByTestId("ny-more").textContent).toContain("First 4 of 30.");
    fireEvent.click(screen.getByTestId("ny-ok-n1"));
    expect(screen.getByTestId("ny-count").textContent).toBe(" (29)");
    expect(screen.getByTestId("ny-more").textContent).toContain("First 3 of 29.");
  });

  it("OK is off with no suggestion, and then Change is the primary button", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const ok = screen.getByTestId("ny-ok-n3") as HTMLButtonElement;
    const change = screen.getByTestId("ny-change-n3");
    expect(ok.disabled).toBe(true);
    expect(change.className).toBe((screen.getByTestId("ny-ok-n1") as HTMLElement).className);
    expect((screen.getByTestId("ny-ok-n1") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("ny-change-n1").className).not.toBe(screen.getByTestId("ny-ok-n1").className);
  });

  it("empty: 'All caught up through {Mon D}', one line", async () => {
    needsYou = body([]);
    mount();
    await waitFor(() => expect(screen.getByTestId("ny-empty")).toBeTruthy());
    expect(screen.getByTestId("ny-empty").textContent).toContain("All caught up through Nov 10.");
    expect(screen.getByTestId("ny-empty").textContent).not.toContain("New bank rows");
    expect(screen.getByTestId("ny-count").textContent).toBe(" (0)");
    expect(screen.queryByTestId("ny-hint")).toBeNull();
  });

  it("what H2 sorted on its own: one line, and 'See them' opens what it handled", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("ny-autodone")).toBeTruthy());
    expect(screen.getByTestId("ny-autodone").textContent).toContain("H2 sorted 7 rows for you since Nov 3");
    // Read only once opened.
    expect(calls.some((c) => c.path === "/api/banking/auto-done")).toBe(false);
    fireEvent.click(screen.getByTestId("ny-see-them"));
    const list = await screen.findByTestId("ny-autodone-items");
    const lines = within(list).getAllByTestId("ny-autodone-item").map((li) => li.textContent);
    expect(lines[0]).toContain("Matched to Gym");
    expect(lines[1]).toContain("Filed under Groceries");
    // Undo a match: its answer's own undo, restoring nothing; a category: its decision's undo.
    fireEvent.click(within(list).getByTestId("ny-autodone-undo-res-auto-1"));
    await waitFor(() => expect(writes("POST", /^\/api\/forecast\/resolutions\/res-auto-1\/undo$/).length).toBe(1));
    expect(writes("POST", /^\/api\/forecast\/resolutions\/res-auto-1\/undo$/)[0]!.body).toEqual({ restore: [] });
    fireEvent.click(within(list).getByTestId("ny-autodone-undo-dec-auto-2"));
    await waitFor(() => expect(writes("POST", /^\/api\/category-decisions\/dec-auto-2\/undo$/).length).toBe(1));
    await waitFor(() => expect(within(list).getAllByText("Undone").length).toBe(2));
    cleanup();
    needsYou = body(ITEMS, { matched: 0, categorized: 0, since: "2026-11-03" });
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    expect(screen.queryByTestId("ny-autodone")).toBeNull();
  });
});

describe("Needs you — OK writes the right answer per kind", () => {
  it("a match: ONE resolution (matched, its planned occurrence, this row), the row leaves, Undo puts it back", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(screen.getByTestId("ny-ok-n1"));
    expect(screen.queryByTestId("ny-ok-n1")).toBeNull();
    await waitFor(() => expect(writes("POST", /^\/api\/forecast\/resolutions$/).length).toBe(1));
    expect(writes("POST", /^\/api\/forecast\/resolutions$/)[0]!.body).toEqual({ status: "matched", recurringItemId: "ri-car", occurrenceDate: "2026-11-03", matchedTxnId: "tx-1" });
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Matched to the Car insurance payment, planned $112.00 on Nov 3")).toBe(true));
    const t = h.toasts.find((x) => x.actions)!;
    expect(t.actions![0]!.label).toBe("Undo");
    await act(async () => t.actions![0]!.onClick());
    await waitFor(() => expect(writes("POST", /\/api\/forecast\/resolutions\/res-1\/undo$/).length).toBe(1));
    await waitFor(() => expect(screen.getByTestId("ny-ok-n1")).toBeTruthy());
  });

  it("a category with a review item: accepts it (POST …/review/:id/accept), with Undo", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(screen.getByTestId("ny-ok-n2"));
    expect(screen.queryByTestId("ny-ok-n2")).toBeNull();
    await waitFor(() => expect(writes("POST", /^\/api\/categorization\/review\/rv-2\/accept$/).length).toBe(1));
    await waitFor(() => expect(h.toasts.some((t) => /^Filed under Groceries\./.test(t.title) && t.actions?.[0]?.label === "Undo")).toBe(true));
    expect(writes("POST", /^\/api\/forecast\/resolutions/).length).toBe(0);
  });

  it("a category without a review item: the register's own hand pick (PATCH the row's category)", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(screen.getByTestId("ny-ok-n4"));
    await waitFor(() => expect(writes("PATCH", /^\/api\/transactions\/tx-4$/).length).toBe(1));
    expect(writes("PATCH", /^\/api\/transactions\/tx-4$/)[0]!.body).toEqual({ categoryId: "cat-f" });
    expect(screen.queryByTestId("ny-ok-n4")).toBeNull();
  });

  it("a refused answer brings the row back and says so", async () => {
    failWrites = true;
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(screen.getByTestId("ny-ok-n2"));
    await waitFor(() => expect(screen.getByTestId("ny-ok-n2")).toBeTruthy());
    expect(h.toasts.some((t) => /still in the list/.test(t.title))).toBe(true);
  });
});

describe("Needs you — Change opens the right picker", () => {
  it("a match: the planned items still open (not the paid one, not money in), or 'Not a planned payment', or Add as a bill", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(screen.getByTestId("ny-change-n3"));
    const dlg = await screen.findByTestId("ny-match-picker");
    const options = within(dlg).getAllByTestId("ny-plan-option").map((o) => o.textContent);
    expect(options.length).toBe(2);
    expect(options[0]).toContain("Car insurance");
    expect(options[1]).toContain("Gym");
    expect(within(dlg).getByTestId("ny-add-bill").getAttribute("href")).toBe("/review?month=2026-11");
    fireEvent.click(within(dlg).getAllByTestId("ny-plan-option")[1]!);
    await waitFor(() => expect(writes("POST", /^\/api\/forecast\/resolutions$/).length).toBe(1));
    expect(writes("POST", /^\/api\/forecast\/resolutions$/)[0]!.body).toEqual({ status: "matched", recurringItemId: "ri-gym", occurrenceDate: "2026-11-05", matchedTxnId: "tx-3" });
  });

  it("a match marked 'Not a planned payment' writes ignored_unforecasted for the row", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(screen.getByTestId("ny-change-n1"));
    fireEvent.click(within(await screen.findByTestId("ny-match-picker")).getByTestId("ny-unplanned"));
    await waitFor(() => expect(writes("POST", /^\/api\/forecast\/resolutions$/).length).toBe(1));
    expect(writes("POST", /^\/api\/forecast\/resolutions$/)[0]!.body).toEqual({ status: "ignored_unforecasted", matchedTxnId: "tx-1" });
    expect(screen.queryByTestId("ny-ok-n1")).toBeNull();
  });

  it("a category: the category picker, and a pick corrects the review item", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(screen.getByTestId("ny-change-n2"));
    const picker = await screen.findByTestId("category-picker");
    expect(screen.queryByTestId("ny-match-picker")).toBeNull();
    fireEvent.click(await within(picker).findByText("Fuel"));
    await waitFor(() => expect(writes("POST", /^\/api\/categorization\/review\/rv-2\/correct$/).length).toBe(1));
    expect(writes("POST", /^\/api\/categorization\/review\/rv-2\/correct$/)[0]!.body).toEqual({ categoryId: "cat-f" });
  });
});

describe("Needs you — keys and the drawer", () => {
  it("j / k move, Enter = OK, c = Change (mirrors Review › Categories)", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(writes("POST", /^\/api\/categorization\/review\/rv-2\/accept$/).length).toBe(1));
    // The next row (no suggestion) is now current: c opens its match picker.
    await waitFor(() => expect(rows()[1]!.getAttribute("aria-current")).toBe("true"));
    fireEvent.keyDown(document.body, { key: "c" });
    expect(await screen.findByTestId("ny-match-picker")).toBeTruthy();
  });

  it("a row click opens it in place, in the drawer, and never navigates", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    const before = window.location.href;
    fireEvent.click(rows()[1]!);
    const drawer = await screen.findByTestId("tx-drawer");
    expect(window.location.href).toBe(before);
    expect(within(drawer).getByTestId("tx-drawer-name").textContent).toBe("Corner Market");
    expect(within(drawer).getByTestId("tx-drawer-meta").textContent).toBe("Nov 4 · Card A ••9876");
    expect(within(drawer).getByTestId("tx-drawer-state").textContent).toBe("Posted");
    expect(within(drawer).getByTestId("tx-drawer-amount").textContent).toBe("-$42.10");
    // The row's own day, bounded, only now.
    await waitFor(() => expect(calls.some((c) => c.path === "/api/transactions")).toBe(true));
    // The reason in full, and the suggestion beside it (the reason does not already say it).
    expect(within(drawer).getAllByTestId("ny-drawer-words").map((p) => p.textContent)).toEqual(["Looks like Groceries", "A new merchant."]);
    // Its answer is in the drawer too.
    fireEvent.click(within(drawer).getByTestId("ny-ok-n2-drawer"));
    await waitFor(() => expect(writes("POST", /^\/api\/categorization\/review\/rv-2\/accept$/).length).toBe(1));
  });
});

describe("Needs you — words", () => {
  it("a reason that already says 'Looks like …' is not said twice in the drawer", async () => {
    mount();
    await waitFor(() => expect(rows().length).toBe(4));
    fireEvent.click(rows()[0]!);
    const drawer = await screen.findByTestId("tx-drawer");
    const words = within(drawer).getAllByTestId("ny-drawer-words").map((p) => p.textContent);
    expect(words).toEqual(["Looks like the Car insurance payment, planned $112.00 on Nov 3. Confirm the match or pick another."]);
    expect(drawer.textContent!.match(/Looks like/g)!.length).toBe(1);
  });
});

describe("helpers", () => {
  it("a planned occurrence is read off its resolution key", () => {
    expect(planOccurrenceOf({ label: "x", planOccurrenceId: "ri-1|2026-11-03", confidence: "high" })).toEqual({ recurringItemId: "ri-1", occurrenceDate: "2026-11-03" });
    expect(planOccurrenceOf({ label: "x", planOccurrenceId: "nonsense", confidence: "high" })).toBeNull();
    expect(planOccurrenceOf(null)).toBeNull();
  });
  it("match candidates leave out what another row paid and money the other way", () => {
    expect(matchCandidates(PLANNED as never, "-30.00").map((p) => p.label)).toEqual(["Car insurance", "Gym"]);
    expect(matchCandidates(PLANNED as never, "1500.00").map((p) => p.label)).toEqual(["Pay"]);
  });
});

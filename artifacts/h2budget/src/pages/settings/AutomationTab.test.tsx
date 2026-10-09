import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { onWriteSuccess } from "@/lib/mutationInvalidation";

// (F5) Settings › Automation. Ported from h2's `household/automation.test.tsx`:
// the real generated hooks (`features` client) run over a stubbed fetch, with a
// QueryClient wired like App.tsx, so these assert the wire calls, the words,
// and what each write marks stale.

const toastMock = vi.fn((_o: { title?: string; variant?: string }) => ({ dismiss: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

// Radix Select as a native <select> (the page tests' pattern).
vi.mock("@/components/ui/select", () => {
  type El = React.ReactElement<{ value?: string; children?: React.ReactNode; "data-testid"?: string; "aria-label"?: string }>;
  function walk(node: React.ReactNode, out: { items: El[]; trigger?: El }) {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const el = child as El;
      if (typeof el.props.value === "string") out.items.push(el);
      else {
        if (el.props["data-testid"] && !out.trigger) out.trigger = el;
        if (el.props.children !== undefined) walk(el.props.children, out);
      }
    });
  }
  return {
    Select: ({ value, onValueChange, disabled, children }: { value?: string; onValueChange?: (v: string) => void; disabled?: boolean; children?: React.ReactNode }) => {
      const found: { items: El[]; trigger?: El } = { items: [] };
      walk(children, found);
      return (
        <select
          data-testid={found.trigger?.props["data-testid"]}
          aria-label={found.trigger?.props["aria-label"]}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          <option value="">Change…</option>
          {found.items.map((it) => (
            <option key={it.props.value} value={it.props.value}>
              {typeof it.props.children === "string" ? it.props.children : it.props.value}
            </option>
          ))}
        </select>
      );
    },
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
  };
});

import AutomationTab from "./AutomationTab";

const CATEGORIES = [
  { id: "c1", name: "Groceries" },
  { id: "c2", name: "Dining out" },
  { id: "c3", name: "Fuel" },
  { id: "c4", name: "Pharmacy" },
  { id: "cx", name: "Uncategorized", excludeFromBudget: true },
];

const d = (
  id: string,
  on: string,
  description: string,
  amount: string,
  categoryId: string | null,
  categoryName: string | null,
  source: string,
  band: string,
  resolution: string | null,
  resolvedBy: string | null,
  undoable: boolean,
) => ({ id, transactionId: `t-${id}`, description, amount, occurredOn: on, source, band, categoryId, categoryName, resolution, resolvedBy, decidedAt: `${on}T12:00:00Z`, undoable });

const SAMPLE = {
  autoCategorize: true,
  modelAutoCategorize: false,
  ai: { configured: true, enabled: true },
  engine: { rules: 4, learned: 11, memories: 10, recurring: 7 },
  model: {
    mode: "suggest",
    eligible: false,
    judged: 18,
    verified: 18,
    unreviewed: 4,
    requirements: [
      { key: "ai", label: "AI is turned on for this app.", met: true, current: 1, target: 1 },
      { key: "owner_switch", label: "The owner lets sure answers file on their own.", met: false, current: 0, target: 1 },
      { key: "judged", label: "At least 30 suggestions you verified in Review.", met: false, current: 18, target: 30 },
      { key: "accuracy", label: "9 in 10 right among the last 50 you verified.", met: false, current: 16, target: 18 },
    ],
    accuracy: { last50: { right: 16, judged: 18 }, last20: { right: 16, judged: 18 } },
  },
  recent: [
    d("a1", "2026-10-07", "Corner Market", "-18.40", "c1", "Groceries", "rule", "auto", null, null, true),
    d("a2", "2026-10-07", "Coffee Cart", "-6.25", "c2", "Dining out", "model", "provisional", null, null, true),
    d("a3", "2026-10-06", "Gas Station", "-41.10", "c3", "Fuel", "memory", "auto", null, null, true),
    d("a4", "2026-10-06", "Streaming Service", "-15.99", null, null, "recurring", "queue", null, null, false),
    d("a5", "2026-10-05", "Pharmacy", "-12.99", "c4", "Pharmacy", "model", "provisional", "accepted", "user", false),
    d("a6", "2026-10-04", "Pizza Place", "-27.80", "c2", "Dining out", "model", "provisional", "unreviewed", "silent", true),
    d("a7", "2026-10-03", "Hardware Depot", "-64.20", "c1", "Groceries", "model", "queue", "corrected", "user", false),
    d("a8", "2026-10-02", "Gas Station", "-38.00", "c3", "Fuel", "inherited", "auto", null, null, true),
  ],
  reviewCount: 3,
  backlog: { unfiled: 23, oldestUnfiledOn: "2026-03-14", provisional: 6 },
  banks: [
    { itemId: "item-1", name: "Sample Bank", lastDataOn: "2026-10-07", autoUpdates: { on: true, reason: "ok" } },
    { itemId: "item-2", name: "Sample Card", lastDataOn: "2026-10-05", autoUpdates: { on: false, reason: "not_registered" } },
  ],
};

type Call = { method: string; url: string; body: unknown };
type Handler = (c: Call) => [number, unknown] | undefined;
let calls: Call[] = [];

function mount(over: Record<string, unknown> = {}, owner = true, extra: Handler[] = []) {
  calls = [];
  let current: Record<string, unknown> = { ...SAMPLE, ...over };
  const handlers: Handler[] = [
    ...extra,
    (c) => (c.method === "GET" && c.url === "/api/categorization/settings" ? [200, current] : undefined),
    (c) => (c.method === "GET" && c.url === "/api/me" ? [200, { isOwner: owner }] : undefined),
    (c) => (c.method === "GET" && c.url === "/api/budget/categories" ? [200, CATEGORIES] : undefined),
    (c) => {
      if (c.method !== "PUT" || c.url !== "/api/categorization/settings") return undefined;
      if (!owner) return [403, { error: "owner_only" }];
      current = { ...current, ...(c.body as object) };
      return [200, current];
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const call = { method, url, body };
      calls.push(call);
      for (const h of handlers) {
        const r = h(call);
        if (r) return new Response(JSON.stringify(r[1]), { status: r[0], headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    }),
  );
  const holder: { qc?: QueryClient } = {};
  const qc = new QueryClient({
    mutationCache: new MutationCache({ onSuccess: (_d, _v, _c, m) => onWriteSuccess(holder.qc!, m) }),
    defaultOptions: { queries: { retry: false } },
  });
  holder.qc = qc;
  render(
    <QueryClientProvider client={qc}>
      <AutomationTab />
    </QueryClientProvider>,
  );
  return qc;
}

const find = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url));

beforeEach(() => toastMock.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Automation — every section from a fixture", () => {
  it("reads the filing line, AI words, ladder, requirements and recent rows", async () => {
    mount();
    expect((await screen.findByTestId("engine-line")).textContent).toBe(
      "Rules you wrote: 4 · Learned from your corrections: 11 · Recurring bills: 7",
    );
    expect(screen.getByTestId("ai-configured").textContent).toContain("Configured");
    expect(screen.getByTestId("ai-enabled").textContent).toContain("On");
    expect(screen.getByTestId("mode-off").textContent).toBe("Off — rules and memory only");
    expect(screen.getByTestId("mode-suggest").textContent).toContain(
      "Suggests — files what it is sure about as provisional and queues the rest; you confirm",
    );
    expect(screen.getByTestId("mode-suggest").getAttribute("data-current")).toBe("true");
    expect(screen.getByTestId("mode-off").getAttribute("data-current")).toBeNull();
    expect(screen.getByTestId("mode-suggest").textContent).toContain("Now");
    expect(within(screen.getByTestId("req-judged")).getByTestId("req-figure").textContent).toBe("18 of 30 verified");
    expect(screen.getByTestId("req-judged").textContent).toContain("Not met");
    expect(screen.getByTestId("req-ai").textContent).toContain("Met");
    expect(within(screen.getByTestId("req-accuracy")).getByTestId("req-figure").textContent).toBe("16 of 18 right");
    expect(screen.getByTestId("unreviewed-line").textContent).toBe("Left unchanged, not verified: 4");
    expect(screen.getByTestId("section-requirements").textContent).toContain(
      "Verified = a suggestion you accepted or corrected in Review. One left unchanged for 14 days is not verified.",
    );
    expect(screen.getAllByTestId("decision")).toHaveLength(8);
    expect(screen.getByTestId("review-count").textContent).toBe("Waiting for review: 3");
    expect(screen.getByTestId("link-rules").getAttribute("href")).toBe("/mapping-rules");
    // ST-02: the Mapping rules card lives here now.
    expect(screen.getByTestId("card-mapping-rules").closest("a")?.getAttribute("href")).toBe("/mapping-rules");
  });

  it("AI not configured and off say so in words", async () => {
    mount({ ai: { configured: false, enabled: false } });
    expect((await screen.findByTestId("ai-configured")).textContent).toContain("Not configured");
    expect(screen.getByTestId("ai-enabled").textContent).toContain("Off — turn on AI_ENABLED on the server");
  });

  it("a failed read shows Try again, never an empty screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 500 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AutomationTab />
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId("automation-error")).textContent).toContain("Couldn't load the automation settings.");
  });
});

describe("Automation — owner and member", () => {
  it("the owner's switches PUT only the key they change, and refresh no money", async () => {
    const qc = mount();
    const spine = vi.spyOn(qc, "invalidateQueries");
    const sw = await screen.findByTestId("auto-file");
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(find("PUT", /categorization\/settings$/)).toHaveLength(1));
    expect(find("PUT", /categorization\/settings$/)[0]!.body).toEqual({ autoCategorize: false });
    await waitFor(() => expect(screen.getByTestId("auto-file").getAttribute("aria-checked")).toBe("false"));
    expect(toastMock).toHaveBeenCalledWith({ title: "H2 will leave new charges for you to file." });
    expect(spine.mock.calls.some(([f]) => JSON.stringify((f as { queryKey?: unknown })?.queryKey) === '["/api/spine"]')).toBe(false);

    const model = screen.getByTestId("model-auto");
    await waitFor(() => expect((model as HTMLButtonElement).disabled).toBe(false));
    expect(model.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Takes effect when every requirement is met.")).toBeTruthy();
    fireEvent.click(model);
    await waitFor(() => expect(find("PUT", /categorization\/settings$/)).toHaveLength(2));
    expect(find("PUT", /categorization\/settings$/)[1]!.body).toEqual({ modelAutoCategorize: true });
  });

  it("a member sees both switches and the backlog run disabled, with the words Owner only", async () => {
    mount({}, false);
    await waitFor(() => expect(screen.getAllByText(/Owner only/).length).toBeGreaterThan(0));
    expect((screen.getByTestId("auto-file") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("model-auto") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("backlog-owner-only").textContent).toBe("Owner only");
    const btn = screen.getByTestId("backlog-run") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(find("POST", /categorization\/run/)).toHaveLength(0);
  });

  it("a refused PUT says so and leaves the switch as it was", async () => {
    mount({}, true, [(c) => (c.method === "PUT" ? [403, { error: "owner_only" }] : undefined)]);
    const sw = await screen.findByTestId("auto-file");
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sw);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({ title: "Only the household owner can do this.", variant: "destructive" }),
    );
    expect(screen.getByTestId("auto-file").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Automation — recent decisions", () => {
  it("each row reads date, amount, category, source, band and resolution", async () => {
    mount();
    const rows = await screen.findAllByTestId("decision");
    const first = rows[0]!;
    expect(within(first).getByTestId("decision-name").textContent).toBe("Corner Market");
    expect(within(first).getByTestId("decision-when").textContent).toBe("Oct 7");
    // Classic prints cents (h2 printed whole dollars).
    expect(within(first).getByTestId("decision-amount").textContent).toBe("-$18.40");
    expect(within(first).getByTestId("decision-category").textContent).toBe("Groceries");
    expect(within(first).getByTestId("decision-source").textContent).toBe("Rule");
    expect(within(first).getByTestId("decision-band").textContent).toBe("Filed");
    expect(within(first).getByTestId("decision-resolution").textContent).toBe("Waiting");
    expect(within(rows[5]!).getByTestId("decision-resolution").textContent).toBe("Unreviewed");
    expect(within(rows[5]!).getByTestId("decision-hint").textContent).toBe("Left unchanged 14 days. Not verified.");
    expect(within(rows[4]!).queryByTestId("decision-hint")).toBeNull();
    expect(within(rows[3]!).queryByTestId("decision-undo")).toBeNull();
    expect(within(rows[3]!).getByTestId("decision-category").textContent).toBe("Not filed");
    expect(within(rows[7]!).getByTestId("decision-source").textContent).toBe("Carried over");
  });

  it("Undo POSTs the decision's undo, refreshes the view and the transaction lists, and says Put back", async () => {
    const qc = mount({}, true, [(c) => (c.method === "POST" && /category-decisions\/a1\/undo$/.test(c.url) ? [200, { ok: true }] : undefined)]);
    qc.setQueryData(["/api/transactions", { limit: 100 }], []);
    const rows = await screen.findAllByTestId("decision");
    const gets = find("GET", /categorization\/settings$/).length;
    fireEvent.click(within(rows[0]!).getByTestId("decision-undo"));
    await waitFor(() => expect(find("POST", /category-decisions\/a1\/undo$/)).toHaveLength(1));
    await waitFor(() => expect(find("GET", /categorization\/settings$/).length).toBeGreaterThan(gets));
    expect(toastMock).toHaveBeenCalledWith({ title: "Put back." });
    expect(qc.getQueryState(["/api/transactions", { limit: 100 }])?.isInvalidated).toBe(true);
  });

  it("Change PATCHes the transaction with the picked category (budget categories only)", async () => {
    mount({}, true, [(c) => (c.method === "PATCH" && /transactions\/t-a1$/.test(c.url) ? [200, { id: "t-a1" }] : undefined)]);
    const rows = await screen.findAllByTestId("decision");
    const select = within(rows[0]!).getByTestId("decision-change") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options).map((o) => o.textContent)).toContain("Fuel"));
    expect(Array.from(select.options).map((o) => o.textContent)).not.toContain("Uncategorized");
    fireEvent.change(select, { target: { value: "c3" } });
    await waitFor(() => expect(find("PATCH", /transactions\/t-a1$/)).toHaveLength(1));
    expect(find("PATCH", /transactions\/t-a1$/)[0]!.body).toEqual({ categoryId: "c3" });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ title: "Filed under Fuel." }));
  });

  it("an empty list says nothing has been filed", async () => {
    mount({ recent: [] });
    expect((await screen.findByTestId("recent-empty")).textContent).toBe("Nothing has been filed yet.");
  });
});

describe("Automation — backlog and bank data (V7)", () => {
  it("reads the unfiled count with the oldest date, and one line per bank", async () => {
    mount();
    expect((await screen.findByTestId("backlog-line")).textContent).toBe("Unfiled charges: 23 · oldest Mar 14, 2026");
    expect(screen.getAllByTestId("bank").map((b) => b.textContent)).toEqual([
      "Sample Bank · data through Oct 7, 2026 · Automatic updates On",
      "Sample Card · data through Oct 5, 2026 · Automatic updates Off",
    ]);
    expect(screen.queryByTestId("backlog-result")).toBeNull();
    expect(screen.getByTestId("backlog-run").textContent).toBe("File everything up to today");
  });

  it("nothing unfiled hides the date; no bank says so", async () => {
    mount({ backlog: { unfiled: 0, oldestUnfiledOn: null, provisional: 0 }, banks: [] });
    expect((await screen.findByTestId("backlog-line")).textContent).toBe("Unfiled charges: 0");
    expect(screen.getByTestId("banks-empty").textContent).toBe("No bank linked.");
  });

  it("the owner files everything: POST { scope: all }, the result line, and the view, review queue, spine and ledger refreshed", async () => {
    const result = { decided: 15, queued: 2, ambiguous: 5, modelQueued: 5, filed: 12, suggested: 3, unreviewed: 4, remaining: 5 };
    const qc = mount({}, true, [(c) => (c.method === "POST" && /categorization\/run$/.test(c.url) ? [200, result] : undefined)]);
    const ledgerKey = ["infinite", "/api/transactions/ledger", { limit: 50 }];
    qc.setQueryData(["/api/spine"], { ok: true });
    qc.setQueryData(["/api/categorization/review", { limit: 20 }], { items: [], total: 0 });
    qc.setQueryData(ledgerKey, { pages: [] });
    const btn = await screen.findByTestId("backlog-run");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    const gets = find("GET", /categorization\/settings$/).length;
    fireEvent.click(btn);
    await waitFor(() => expect(find("POST", /categorization\/run$/)).toHaveLength(1));
    expect(find("POST", /categorization\/run$/)[0]!.body).toEqual({ scope: "all" });
    expect((await screen.findByTestId("backlog-result")).textContent).toBe(
      "Filed 12 · Suggested 3 (provisional) · 2 need a look · 4 left unchanged",
    );
    expect(screen.getByTestId("backlog-review").textContent).toBe("Waiting for review: 3");
    await waitFor(() => expect(find("GET", /categorization\/settings$/).length).toBeGreaterThan(gets));
    expect(qc.getQueryState(["/api/spine"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["/api/categorization/review", { limit: 20 }])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(ledgerKey)?.isInvalidated).toBe(true);
  });

  it("a refused run says so in words", async () => {
    mount({}, true, [(c) => (c.method === "POST" && /categorization\/run$/.test(c.url) ? [403, { error: "Forbidden: owner only" }] : undefined)]);
    const btn = await screen.findByTestId("backlog-run");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({ title: "Only the household owner can do this.", variant: "destructive" }),
    );
    expect(screen.queryByTestId("backlog-result")).toBeNull();
  });
});

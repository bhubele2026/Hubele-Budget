import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import AttentionPanel from "@/pages/next/dashboard/AttentionPanel";
import { HandledByH2 } from "./HandledByH2";

/**
 * (F3) The agent trail and the findings against a fake server: `fetch` is
 * replaced and the real generated hooks run. Ported from h2's
 * `activity.test.tsx` "Handled by H2" block.
 */
interface Call { method: string; path: string; query: URLSearchParams; body: unknown }
type Handler = (c: Call) => [number, unknown] | undefined;
function installApi(handlers: Handler[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://x.test");
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      for (const h of handlers) {
        const out = h(call);
        if (out) {
          const [status, payload] = out;
          return new Response(status === 204 || payload === undefined ? null : JSON.stringify(payload), {
            status,
            headers: payload === undefined ? {} : { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }),
  );
  return { calls, find: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)) };
}
const on =
  (method: string, path: string | RegExp, reply: unknown | ((c: Call) => unknown), status = 200): Handler =>
  (c) => {
    if (c.method !== method) return undefined;
    if (typeof path === "string" ? c.path !== path : !path.test(c.path)) return undefined;
    return [status, typeof reply === "function" ? (reply as (c: Call) => unknown)(c) : reply];
  };

const act = (id: string, runId: string, over: Record<string, unknown> = {}) => ({
  id, runId, type: "set_category", targetKind: "transaction", targetId: id, outcome: "applied", reversible: true, undoneAt: null, createdAt: "2026-10-07T14:30:00Z", ...over,
});
const finding = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  id, kind, severity: "watch", confidence: "estimate", payload: {}, firstSeen: "2026-10-06T22:00:00Z", lastSeen: "2026-10-07T08:00:00Z", resolvedAt: null, dismissedAt: null, ...over,
});
const apiWith = (actions: unknown[], findings: unknown[] = [], extra: Handler[] = []) =>
  installApi([on("GET", "/api/agent/actions", { actions }), on("GET", "/api/agent/findings", { findings }), ...extra]);
const mount = (ui: React.ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {ui}
      <Toaster />
    </QueryClientProvider>,
  );
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Handled by H2 — the trail, Why? and Undo", () => {
  it("asks for 10 actions; Undo shows only while reversible and not undone; the line is words", async () => {
    const api = apiWith([
      act("a1", "r1"),
      act("a2", "r1"),
      act("a3", "r2", { type: "remember", reversible: false }),
      act("a4", "r3", { type: "propose", undoneAt: "2026-10-07T15:00:00Z" }),
    ]);
    mount(<HandledByH2 now={new Date("2026-10-07T15:00:00Z")} />);
    const items = await screen.findAllByTestId("trail-item");
    expect(api.find("GET", /agent\/actions$/)[0]!.query.get("limit")).toBe("10");
    expect(items[0]!.textContent).toMatch(/^Filed 2 charges/);
    expect(items[1]!.textContent).toMatch(/^Remembered 1 merchant/);
    expect(items[2]!.textContent).toMatch(/^Suggested a change/);
    expect(within(items[0]!).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(items[1]!).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(items[2]!).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(items[2]!.textContent).toContain("Undone");
  });

  it("Undo posts each undoable action; a 501 is a quiet notice, not an error", async () => {
    const api = apiWith([act("a1", "r1"), act("a2", "r1")], [], [on("POST", /agent\/actions\/[^/]+\/undo$/, { error: "not implemented" }, 501)]);
    mount(<HandledByH2 />);
    fireEvent.click(await screen.findByTestId("trail-undo"));
    await waitFor(() => expect(api.find("POST", /agent\/actions\/a1\/undo$/)).toHaveLength(1));
    expect(await screen.findByText("Undo arrives with the next update.")).toBeTruthy();
    expect(screen.queryByText(/Couldn't undo/)).toBeNull();
  });

  it("Undo on success says Undone and asks for the trail again", async () => {
    const api = apiWith([act("a1", "r1")], [], [on("POST", /agent\/actions\/a1\/undo$/, {})]);
    mount(<HandledByH2 />);
    fireEvent.click(await screen.findByTestId("trail-undo"));
    await waitFor(() => expect(api.find("POST", /a1\/undo$/)).toHaveLength(1));
    expect(await screen.findByText("Undone.")).toBeTruthy();
    await waitFor(() => expect(api.find("GET", /agent\/actions$/).length).toBeGreaterThan(1));
  });

  it("Why? opens what is known; a finding's payload reads as words and figures, refs hidden", async () => {
    apiWith(
      [act("x1", "r1", { type: "finding", targetKind: "finding", targetId: "f1", outcome: "needs_attention", reversible: false })],
      [finding("f1", "duplicate_charge", { payload: { transactionId: "t9", amount: 18.4, daysApart: 1 } })],
    );
    mount(<HandledByH2 />);
    const item = await screen.findByTestId("trail-item");
    expect(item.textContent).toContain("Flagged a possible duplicate");
    fireEvent.click(within(item).getByRole("button", { name: "Why?" }));
    const why = await screen.findByTestId("why-sheet");
    expect(why.textContent).toContain("Needs you");
    expect(why.querySelector("[data-testid=why-figures]")!.textContent).toContain("Amount$18");
    expect(why.textContent).toContain("Days apart1");
    expect(why.textContent).not.toContain("t9");
  });

  it("empty and failed states", async () => {
    apiWith([]);
    mount(<HandledByH2 />);
    expect((await screen.findByTestId("trail-empty")).textContent).toContain("hasn't handled anything");
    cleanup();
    installApi([on("GET", "/api/agent/actions", { error: "x" }, 500), on("GET", "/api/agent/findings", { findings: [] })]);
    mount(<HandledByH2 />);
    expect((await screen.findByTestId("trail-failed")).textContent).toContain("Couldn't load what H2 handled.");
  });
});

// (Dashboard refinement) The findings are one block of the dashboard's single
// Needs attention list, which stands on the spine; the other sources it reads
// answer here too (an unanswered one only shows its own "did not load" row).
const SPINE = {
  asOf: "2026-10-07T15:00:00Z",
  bank: { balance: "1000.00", asOfDate: "2026-10-07T12:00:00Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null },
  spentMonth: 0, spentWeek: 0, nextBill: null, billsDueCount: 0,
  forecast: { lowPoint: "900.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "ready" },
  debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 },
  reviewCount: 0,
  position: { safeToSpendNow: null, remainingWeek: null, availableUntilPayday: null, paydayDate: null, horizonKind: "week_end", withinPlan: null, confidence: "firm", degraded: false, weekAdjustment: null },
};
const dashSources: Handler[] = [
  on("GET", "/api/spine", SPINE),
  on("GET", "/api/bills/summary", { bills: [], debtMins: [], income: [], monthly: {} }),
  on("GET", "/api/plaid/items", []),
  on("GET", "/api/categories", []),
  on("GET", "/api/transactions", []),
];

describe("Needs attention — the dashboard's findings panel", () => {
  it("asks for the 10 open findings; Resolve and Dismiss post to their own endpoints and refetch", async () => {
    const api = apiWith(
      [],
      [finding("f1", "duplicate_charge"), finding("f2", "shortfall_before_income", { severity: "high", confidence: "confirmed", payload: { shortfall: 212 } })],
      [on("POST", /agent\/findings\/f1\/dismiss$/, finding("f1", "duplicate_charge")), on("POST", /agent\/findings\/f2\/resolve$/, finding("f2", "shortfall_before_income")), ...dashSources],
    );
    mount(<AttentionPanel />);
    const found = await screen.findAllByTestId("finding");
    const q = api.find("GET", /agent\/findings$/)[0]!.query;
    expect([q.get("status"), q.get("limit")]).toEqual(["open", "10"]);
    expect(found).toHaveLength(2);
    expect(within(found[1]!).getByTestId("finding-severity").textContent).toBe("Important");
    expect(within(found[1]!).getByRole("link", { name: "See forecast" }).getAttribute("href")).toBe("/forecast");
    expect(within(found[0]!).getByRole("link", { name: "See charges" }).getAttribute("href")).toBe("/transactions");
    fireEvent.click(within(found[0]!).getByTestId("finding-dismiss"));
    await waitFor(() => expect(api.find("POST", /findings\/f1\/dismiss$/)).toHaveLength(1));
    fireEvent.click(within(screen.getAllByTestId("finding")[1]!).getByTestId("finding-resolve"));
    await waitFor(() => expect(api.find("POST", /findings\/f2\/resolve$/)).toHaveLength(1));
    await waitFor(() => expect(api.find("GET", /agent\/findings$/).length).toBeGreaterThan(1));
  });

  it("Why? shows the finding's figures", async () => {
    apiWith([], [finding("f2", "shortfall_before_income", { payload: { shortfall: 212 } })], dashSources);
    mount(<AttentionPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Why?" }));
    expect((await screen.findByTestId("why-figures")).textContent).toContain("Shortfall$212");
  });

  it("a refused dismiss says so and keeps the finding", async () => {
    apiWith([], [finding("f1", "bank_stale")], [on("POST", /dismiss$/, { error: "no" }, 500), ...dashSources]);
    mount(<AttentionPanel />);
    fireEvent.click(await screen.findByTestId("finding-dismiss"));
    expect(await screen.findByText("Couldn't dismiss that. It's still here.")).toBeTruthy();
    expect(screen.getAllByTestId("finding")).toHaveLength(1);
  });

  it("nothing open, or no answer yet, draws no findings block (a finding that is not there is not a zero)", async () => {
    const api = apiWith([], [], dashSources);
    mount(<AttentionPanel />);
    await waitFor(() => expect(api.find("GET", /agent\/findings$/)).toHaveLength(1));
    expect(await screen.findByTestId("dash-attention")).toBeTruthy();
    expect(screen.queryByTestId("dash-findings")).toBeNull();
    expect(screen.queryByTestId("finding")).toBeNull();
  });
});

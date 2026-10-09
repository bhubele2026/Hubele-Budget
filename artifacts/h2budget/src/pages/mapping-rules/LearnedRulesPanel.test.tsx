import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { onWriteSuccess } from "@/lib/mutationInvalidation";

// (F2) "Learned from your corrections" on Mapping rules. The real generated
// hooks (from the `features` sub-module) run against a stubbed `fetch`, and the
// QueryClient is wired like App.tsx (every successful write runs the
// after-write rule), so these assert the wire calls AND what each write marks
// stale. Behaviour ported from h2's RulesView tests (`activity.test.tsx`
// 437-516), plus the dry-run preview the server added in PR-A2.

const toastMock = vi.fn((_opts: { title?: string; variant?: string }) => ({ dismiss: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

// Radix Select as a native <select> (the pattern the page tests use), keeping
// each item's `disabled` so the scope rule can be asserted.
vi.mock("@/components/ui/select", () => {
  type El = React.ReactElement<{ value?: string; disabled?: boolean; children?: React.ReactNode; "data-testid"?: string; "aria-label"?: string }>;
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
          {found.items.map((it) => (
            <option key={it.props.value} value={it.props.value} disabled={it.props.disabled}>
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

import { LearnedRulesPanel } from "./LearnedRulesPanel";

type Json = Record<string, unknown> | unknown[] | null;
type Route = { method: string; path: RegExp; status?: number; body?: Json | ((req: { url: string; body: unknown }) => Json) };
type Call = { method: string; url: string; body: unknown };

function rule(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    signature: "corner market",
    scope: "merchant",
    plaidAccountId: null,
    amountBandLo: null,
    amountBandHi: null,
    categoryId: "c1",
    count: 6,
    lastConfirmedAt: "2026-10-05T12:00:00Z",
    disabled: false,
    source: "user",
    createdAt: "2026-08-01T12:00:00Z",
    ...over,
  };
}

const CATEGORIES = [
  { id: "c1", name: "Groceries" },
  { id: "c2", name: "Dining & Coffee" },
  { id: "c3", name: "Household" },
] as never[];
const ALL_CATEGORIES = [...CATEGORIES, { id: "cx", name: "Uncategorized", excludeFromBudget: true }] as never[];

let calls: Call[] = [];

function setup(routes: Route[]) {
  calls = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const r = routes.find((x) => x.method === method && x.path.test(url));
    if (!r) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    const payload = typeof r.body === "function" ? r.body({ url, body }) : r.body;
    const status = r.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload ?? null), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const holder: { qc?: QueryClient } = {};
  const qc = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: (_d, _v, _c, mutation) => onWriteSuccess(holder.qc!, mutation),
    }),
    defaultOptions: { queries: { retry: false } },
  });
  holder.qc = qc;
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <LearnedRulesPanel categories={CATEGORIES} allCategories={ALL_CATEGORIES} />
    </QueryClientProvider>,
  );
  return { qc, invalidate };
}

/** Every key an `invalidateQueries` call named (predicate calls are tested against probe keys). */
function invalidated(spy: { mock: { calls: unknown[][] } }, probe: readonly unknown[]): boolean {
  return spy.mock.calls.some(([filters]: unknown[]) => {
    const f = (filters ?? {}) as { queryKey?: readonly unknown[]; predicate?: (q: { queryKey: readonly unknown[] }) => boolean };
    if (f.queryKey) return f.queryKey.every((k, i) => probe[i] === k);
    if (f.predicate) return f.predicate({ queryKey: probe });
    return false;
  });
}

beforeEach(() => {
  toastMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIST = /\/api\/learned-rules$/;

/** A tiny server: GET reads `db`, PATCH and DELETE change it, like the real routes. */
function learnedServer(db: Array<ReturnType<typeof rule>>): Route[] {
  return [
    { method: "GET", path: LIST, body: () => db },
    {
      method: "PATCH",
      path: /\/api\/learned-rules\/[^/]+$/,
      body: ({ url, body }) => {
        const id = url.split("/").pop()!;
        const i = db.findIndex((r) => r.id === id);
        db[i] = { ...db[i]!, ...(body as object) };
        return db[i]!;
      },
    },
    {
      method: "DELETE",
      path: /\/api\/learned-rules\/[^/]+$/,
      status: 204,
      body: ({ url }) => {
        const id = url.split("/").pop()!;
        db.splice(db.findIndex((r) => r.id === id), 1);
        return null;
      },
    },
  ];
}

describe("LearnedRulesPanel (F2)", () => {
  it("lists merchant, times confirmed and last date, category and scope; off rules last with an Off chip", async () => {
    setup([
      {
        method: "GET",
        path: LIST,
        body: [
          rule("off", { signature: "acme fuel", disabled: true, lastConfirmedAt: "2026-10-07T12:00:00Z" }),
          rule("r1"),
          rule("r2", { signature: "bean town", categoryId: "c2", count: 1, lastConfirmedAt: "2026-10-06T12:00:00Z" }),
        ],
      },
    ]);
    const list = await screen.findByTestId("learned-rules");
    const rows = within(list).getAllByRole("listitem").filter((li) => li.dataset.testid?.startsWith("learned-rule-"));
    expect(rows.map((r) => r.dataset.testid)).toEqual(["learned-rule-r2", "learned-rule-r1", "learned-rule-off"]);
    expect(screen.getByTestId("learned-rule-name-r1").textContent).toBe("Corner Market");
    expect(screen.getByTestId("learned-rule-confirmed-r1").textContent).toBe("Confirmed 6 times · last Oct 5");
    expect(screen.getByTestId("learned-rule-confirmed-r2").textContent).toBe("Confirmed 1 time · last Oct 6");
    expect((screen.getByTestId("learned-rule-category-r1") as HTMLSelectElement).value).toBe("c1");
    expect((screen.getByTestId("learned-rule-scope-r1") as HTMLSelectElement).value).toBe("merchant");
    expect(screen.getByTestId("learned-rule-off").dataset.disabled).toBe("true");
    expect(within(screen.getByTestId("learned-rule-off")).getByText("Off")).toBeTruthy();
    expect(screen.getByTestId("learned-rules-count").textContent).toBe("3 learned · 2 on");
    // Only the one read: no account lookup when no rule is narrowed to an account.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/learned-rules"]);
  });

  it("changing the scope or the category PATCHes only that field, shows it at once, and refreshes only this list", async () => {
    const { invalidate } = setup([
      ...learnedServer([rule("r1", { plaidAccountId: "acc_1" })]),
      { method: "GET", path: /\/api\/plaid\/items$/, body: [] },
    ]);
    const scope = (await screen.findByTestId("learned-rule-scope-r1")) as HTMLSelectElement;
    fireEvent.change(scope, { target: { value: "merchant_account" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ scope: "merchant_account" });
    await waitFor(() =>
      expect((screen.getByTestId("learned-rule-scope-r1") as HTMLSelectElement).value).toBe("merchant_account"),
    );

    fireEvent.change(screen.getByTestId("learned-rule-category-r1"), { target: { value: "c3" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]!.body).toEqual({ categoryId: "c3" });
    await waitFor(() =>
      expect((screen.getByTestId("learned-rule-category-r1") as HTMLSelectElement).value).toBe("c3"),
    );
    // A learned-rule edit moves no money: no spine, report or ledger refresh.
    expect(invalidated(invalidate, ["/api/learned-rules"])).toBe(true);
    expect(invalidated(invalidate, ["/api/spine"])).toBe(false);
    expect(invalidated(invalidate, ["/api/reports/spending-facts"])).toBe(false);
  });

  it("a refused change says so and leaves the rule as it was", async () => {
    setup([
      { method: "GET", path: LIST, body: [rule("r1")] },
      { method: "PATCH", path: /\/api\/learned-rules\/r1$/, status: 400, body: { error: "nope" } },
    ]);
    fireEvent.change(await screen.findByTestId("learned-rule-category-r1"), { target: { value: "c2" } });
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: "Couldn't change the category. It's as it was.",
        variant: "destructive",
      }),
    );
    expect((screen.getByTestId("learned-rule-category-r1") as HTMLSelectElement).value).toBe("c1");
  });

  it("offers a narrower scope only when the rule has an account or an amount band", async () => {
    setup([
      {
        method: "GET",
        path: LIST,
        body: [
          rule("bare"),
          rule("band", { signature: "z", scope: "merchant_amount", amountBandLo: "40", amountBandHi: "60" }),
        ],
      },
    ]);
    const bare = (await screen.findByTestId("learned-rule-scope-bare")) as HTMLSelectElement;
    const opt = (sel: HTMLSelectElement, v: string) =>
      Array.from(sel.options).find((o) => o.value === v)!;
    expect(opt(bare, "merchant").disabled).toBe(false);
    expect(opt(bare, "merchant_account").disabled).toBe(true);
    expect(opt(bare, "merchant_amount").disabled).toBe(true);
    const band = screen.getByTestId("learned-rule-scope-band") as HTMLSelectElement;
    expect(opt(band, "merchant_amount").disabled).toBe(false);
    expect(screen.getByTestId("learned-rule-band-band").textContent).toBe("$40.00 to $60.00");
    expect(screen.queryByTestId("learned-rule-band-bare")).toBeNull();
  });

  it("names the account a 'This account only' rule is narrowed to", async () => {
    setup([
      { method: "GET", path: LIST, body: [rule("r1", { scope: "merchant_account", plaidAccountId: "plaid-acc-9" })] },
      {
        method: "GET",
        path: /\/api\/plaid\/items$/,
        body: [
          {
            id: "item-1",
            itemId: "it",
            institutionName: "Chase",
            institutionSlug: "chase",
            accounts: [{ id: "row-9", accountId: "plaid-acc-9", name: "Total Checking", mask: "4321", type: "depository", subtype: "checking" }],
          },
        ],
      },
    ]);
    const chip = await screen.findByTestId("learned-rule-account-r1");
    expect(chip.textContent).toContain("4321");
  });

  it("a rule pointing at a category outside the list still shows that category's name", async () => {
    setup([{ method: "GET", path: LIST, body: [rule("r1", { categoryId: "cx" })] }]);
    const sel = (await screen.findByTestId("learned-rule-category-r1")) as HTMLSelectElement;
    expect(sel.value).toBe("cx");
    expect(sel.selectedOptions[0]!.textContent).toBe("Uncategorized");
  });

  it("Turn off PATCHes disabled; an off rule cannot file past charges", async () => {
    setup(learnedServer([rule("r1")]));
    fireEvent.click(await screen.findByTestId("learned-rule-toggle-r1"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ disabled: true }));
    await waitFor(() => expect(screen.getByTestId("learned-rule-toggle-r1").textContent).toBe("Turn on"));
    expect((screen.getByTestId("learned-rule-apply-r1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Delete asks first; Keep backs out; Delete removes the rule", async () => {
    setup(learnedServer([rule("r1")]));
    fireEvent.click(await screen.findByTestId("learned-rule-delete-r1"));
    expect(screen.getByTestId("learned-rule-delete-ask-r1").textContent).toContain("Delete this rule?");
    fireEvent.click(screen.getByTestId("learned-rule-delete-keep-r1"));
    expect(screen.queryByTestId("learned-rule-delete-ask-r1")).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("learned-rule-delete-r1"));
    fireEvent.click(screen.getByTestId("learned-rule-delete-confirm-r1"));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("learned-rule-r1")).toBeNull());
  });

  it("Apply to past charges asks for a dry run first, shows what would move, and files only on 'File them'", async () => {
    const sample = Array.from({ length: 5 }, (_, i) => ({
      transactionId: `t${i}`,
      description: `CORNER MARKET #${i}`,
      occurredOn: `2026-09-0${i + 1}`,
      amount: `-${10 + i}.50`,
    }));
    const { invalidate } = setup([
      { method: "GET", path: LIST, body: [rule("r1")] },
      {
        method: "POST",
        path: /\/api\/learned-rules\/r1\/apply-retroactively(\?.*)?$/,
        body: ({ url }) =>
          url.includes("dryRun=true") ? { updated: 0, dryRun: true, count: 7, sample } : { updated: 7 },
      },
    ]);
    fireEvent.click(await screen.findByTestId("learned-rule-apply-r1"));
    const preview = await screen.findByTestId("learned-rule-preview-r1");
    const posts = () => calls.filter((c) => c.method === "POST");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe("/api/learned-rules/r1/apply-retroactively?dryRun=true");
    expect(preview.textContent).toContain("7 past charges will move into Groceries.");
    expect(within(screen.getByTestId("learned-rule-sample-r1")).getAllByRole("listitem")).toHaveLength(5);
    expect(preview.textContent).toContain("Sep 1");
    expect(preview.textContent).toContain("-$10.50");
    expect(preview.textContent).toContain("Showing the 5 most recent of 7.");
    // The dry run writes nothing, so it refreshes nothing app-wide.
    expect(invalidated(invalidate, ["/api/spine"])).toBe(false);

    fireEvent.click(screen.getByTestId("learned-rule-file-r1"));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.url).toBe("/api/learned-rules/r1/apply-retroactively");
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ title: "Filed 7 past charges." }));
    expect(screen.queryByTestId("learned-rule-preview-r1")).toBeNull();
    // Filing moves categories: the app-wide refresh plus every list that shows them.
    expect(invalidated(invalidate, ["/api/spine"])).toBe(true);
    expect(invalidated(invalidate, ["/api/reports/spending-facts"])).toBe(true);
    expect(invalidated(invalidate, ["/api/transactions", { limit: 100 }])).toBe(true);
    expect(invalidated(invalidate, ["/api/budget/months/2026-10-01"])).toBe(true);
    expect(invalidated(invalidate, ["/api/categorization/review", { limit: 50 }])).toBe(true);
  });

  it("Cancel closes the preview without filing; a dry run that finds nothing says so", async () => {
    let count = 2;
    setup([
      { method: "GET", path: LIST, body: [rule("r1")] },
      {
        method: "POST",
        path: /apply-retroactively/,
        body: () => ({ updated: 0, dryRun: true, count, sample: [] }),
      },
    ]);
    fireEvent.click(await screen.findByTestId("learned-rule-apply-r1"));
    await screen.findByTestId("learned-rule-preview-r1");
    fireEvent.click(screen.getByTestId("learned-rule-preview-cancel-r1"));
    expect(screen.queryByTestId("learned-rule-preview-r1")).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);

    count = 0;
    fireEvent.click(screen.getByTestId("learned-rule-apply-r1"));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ title: "No past charges to file." }));
    expect(screen.queryByTestId("learned-rule-preview-r1")).toBeNull();
  });

  it("empty: says nothing is learned yet", async () => {
    setup([{ method: "GET", path: LIST, body: [] }]);
    expect((await screen.findByTestId("learned-rules-empty")).textContent).toContain(
      "H2 hasn't learned a merchant yet",
    );
    expect(screen.queryByTestId("learned-rules-count")).toBeNull();
  });

  it("a failed load says so — never 'nothing learned' — and Try again asks again", async () => {
    setup([
      {
        method: "GET",
        path: LIST,
        status: 500,
        body: { error: "down" },
      },
    ]);
    const err = await screen.findByTestId("learned-rules-error");
    expect(err.textContent).toContain("Couldn't load what H2 learned.");
    expect(screen.queryByTestId("learned-rules-empty")).toBeNull();
    const before = calls.length;
    fireEvent.click(screen.getByTestId("learned-rules-retry"));
    await waitFor(() => expect(calls.length).toBe(before + 1));
  });
});

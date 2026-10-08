import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { createQueryClient } from "@/data/queryClient";
import Activity, { type ActivityViewKey } from "./Activity";

/**
 * A fake server for the Activity tests: `fetch` is replaced, so the REAL
 * generated hooks run (their URLs, methods and bodies are what the tests
 * check). Each handler returns [status, body]; anything unhandled is a 404.
 */
export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
export type Handler = (call: Call) => [number, unknown] | undefined;

export const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday, 10:00 in Chicago

export function installApi(handlers: Handler[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://x.test");
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      const call: Call = { method, path: url.pathname, query: url.searchParams, body };
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
  return {
    calls,
    find: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)),
  };
}

export const on =
  (method: string, path: string | RegExp, reply: object | undefined | ((c: Call) => unknown), status = 200): Handler =>
  (c) => {
    if (c.method !== method) return undefined;
    if (typeof path === "string" ? c.path !== path : !path.test(c.path)) return undefined;
    return [status, typeof reply === "function" ? (reply as (c: Call) => unknown)(c) : reply];
  };

export function renderActivity(view: ActivityViewKey) {
  const client = createQueryClient();
  const opts = client.getDefaultOptions();
  client.setDefaultOptions({ ...opts, queries: { ...opts.queries, retry: false } });
  return render(
    <QueryClientProvider client={client}>
      <Activity view={view} now={NOW} />
    </QueryClientProvider>,
  );
}

export const CATEGORIES = [
  { id: "c1", name: "Groceries", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 1 },
  { id: "c2", name: "Dining out", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 2 },
  { id: "c3", name: "Fuel", kind: "expense", groupName: "Transport", sourceKind: "manual", sortOrder: 1 },
];

export const ledgerRow = (id: string, on: string, name: string, amount: string, categoryId: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  occurredOn: on,
  description: name.toUpperCase(),
  displayName: name,
  merchantSignature: name.toLowerCase(),
  amount,
  categoryId,
  pending: false,
  reimbursable: false,
  reimbursed: false,
  countsInBalance: true,
  plaidAccountId: "acct1",
  ...extra,
});

export const ledgerPage = (rows: unknown[], nextCursor: string | null = null, matchingCount = rows.length) => ({
  rows,
  nextCursor,
  limit: 50,
  matchingCount,
});

export const PLAID_ITEMS = [
  {
    id: "item1",
    itemId: "i1",
    institutionSlug: "sample",
    affectedCount: 0,
    accounts: [
      { id: "acct1", accountId: "pa1", name: "Checking", mask: "4421", type: "depository" },
      { id: "acct2", accountId: "pa2", name: "Savings", mask: "0198", type: "depository" },
    ],
  },
];

export const SPINE = {
  asOf: "2026-10-07T14:59:00Z",
  bank: { balance: "1.00", asOfDate: "2026-10-07T14:48:00Z", source: "plaid", lastContactAt: "2026-10-07T14:48:00Z", lastFailureAt: null, stale: false, staleReason: null },
  reviewCount: 0,
};

/** The reads every screen makes, so a test lists only what it is about. */
export const baseReads: Handler[] = [
  on("GET", "/api/budget/categories", CATEGORIES),
  on("GET", "/api/plaid/items", PLAID_ITEMS),
  on("GET", "/api/spine", SPINE),
  on("GET", "/api/agent/actions", { actions: [] }),
  on("GET", "/api/agent/findings", { findings: [] }),
  on("GET", "/api/categorization/review", { items: [], total: 0 }),
];

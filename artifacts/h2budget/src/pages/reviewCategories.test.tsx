import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReviewCategoriesPage from "./review-categories";
import { Toaster } from "@/components/ui/toaster";

/**
 * (F1) Review › Categories against a fake server: `fetch` is replaced and the
 * real generated hooks run, so URLs, methods and bodies are what the app sends.
 * Ported from h2's `activity.test.tsx` "Review queue" block (165-436 range).
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

const CATEGORIES = [
  { id: "c1", name: "Groceries", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 1 },
  { id: "c2", name: "Dining out", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 2 },
  { id: "c3", name: "Fuel", kind: "expense", groupName: "Transport", sourceKind: "manual", sortOrder: 1 },
];
const item = (n: number, over: Record<string, unknown> = {}) => ({
  decisionId: `d${n}`,
  transactionId: `t${n}`,
  occurredOn: `2026-10-0${n}`,
  description: `Merchant ${n}`,
  amount: "-20.00",
  account: "••4421",
  currentCategoryId: null,
  suggestedCategoryId: "c1",
  confidence: 0.7,
  band: "queue",
  source: "memory",
  explanation: "x",
  createdAt: `2026-10-0${n}T12:00:00Z`,
  flags: { novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false },
  ...over,
});
const resolution = (over: Record<string, unknown> = {}) => (c: Call) => ({
  decisionId: c.path.split("/")[4],
  transactionId: "t",
  resolution: "accepted",
  categoryId: "c1",
  userDecisionId: "u1",
  retroactiveCandidates: null,
  ...over,
});
const reviewApi = (items: unknown[], extra: Handler[] = [], over: Record<string, unknown> = {}) =>
  installApi([
    on("GET", "/api/categorization/review", { items, total: items.length }),
    on("POST", /\/api\/categorization\/review\/[^/]+\/(accept|skip|correct)$/, resolution(over)),
    on("GET", "/api/budget/categories", CATEGORIES),
    ...extra,
  ]);
const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReviewCategoriesPage />
      <Toaster />
    </QueryClientProvider>,
  );
};

const press = (key: string, target: EventTarget = document) => {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
};

beforeEach(() => undefined);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Review › Categories", () => {
  it("asks for 20 at a time; lists oldest first with the proposal as a provisional chip, one line why, flags as words", async () => {
    const api = reviewApi([item(3, { source: "recurring" }), item(1, { flags: { novelMerchant: true, amountAnomaly: true, splitNeedsRebalance: false } }), item(2, { source: "rule" })]);
    mount();
    const rows = await screen.findAllByTestId("review-item");
    expect(api.find("GET", /categorization\/review$/)[0]!.query.get("limit")).toBe("20");
    expect(rows.map((r) => /Merchant (\d)/.exec(r.textContent ?? "")![1])).toEqual(["1", "2", "3"]);
    const chip = within(rows[0]!).getByTestId("review-chip");
    expect(chip.textContent).toContain("Groceries");
    expect(chip.hasAttribute("data-provisional")).toBe(true);
    expect(within(rows[0]!).getByTestId("review-why").textContent).toBe("Learned from a correction");
    expect(within(rows[0]!).getAllByTestId("review-flag").map((f) => f.textContent)).toEqual(["New merchant", "Unusual amount"]);
    expect(within(rows[1]!).getByTestId("review-why").textContent).toBe("Matches a rule");
    expect(within(rows[2]!).getByTestId("review-why").textContent).toBe("Looks like a recurring bill");
    expect(screen.getByTestId("review-count").textContent).toContain("3 to review");
  });

  it("keyboard: j/k move, a accepts, s skips, c changes; each calls the right endpoint", async () => {
    const api = reviewApi([item(1), item(2), item(3)]);
    mount();
    await screen.findAllByTestId("review-item");
    const current = () => screen.getAllByTestId("review-item").findIndex((r) => r.getAttribute("aria-current") === "true");
    expect(current()).toBe(0);
    press("j");
    expect(current()).toBe(1);
    press("k");
    expect(current()).toBe(0);

    press("a");
    await waitFor(() => expect(api.find("POST", /review\/d1\/accept$/)).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("review-item")).toHaveLength(2));

    press("s");
    await waitFor(() => expect(api.find("POST", /review\/d2\/skip$/)).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("review-item")).toHaveLength(1));

    press("c");
    fireEvent.click(await screen.findByRole("button", { name: "Fuel" }));
    await waitFor(() => expect(api.find("POST", /review\/d3\/correct$/)).toHaveLength(1));
    expect(api.find("POST", /review\/d3\/correct$/)[0]!.body).toEqual({ categoryId: "c3" });
  });

  it("the three buttons do the same, and the queue refetches after an answer", async () => {
    const api = reviewApi([item(1), item(2)]);
    mount();
    const rows = await screen.findAllByTestId("review-item");
    fireEvent.click(within(rows[0]!).getByTestId("review-accept"));
    await waitFor(() => expect(api.find("POST", /review\/d1\/accept$/)).toHaveLength(1));
    fireEvent.click(within(screen.getAllByTestId("review-item")[0]!).getByTestId("review-skip"));
    await waitFor(() => expect(api.find("POST", /review\/d2\/skip$/)).toHaveLength(1));
    expect(await screen.findByTestId("review-empty")).toBeTruthy();
    await waitFor(() => expect(api.find("GET", /categorization\/review$/).length).toBeGreaterThan(1));
  });

  it("keys are ignored while typing in a field", async () => {
    const api = reviewApi([item(1)]);
    mount();
    await screen.findAllByTestId("review-item");
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    press("a");
    expect(api.find("POST", /accept$/)).toHaveLength(0);
    field.remove();
  });

  it("an item with no proposal has no Accept (and the a key does nothing)", async () => {
    const api = reviewApi([item(1, { suggestedCategoryId: null, explanation: "The bank removed this charge." })]);
    mount();
    const row = await screen.findByTestId("review-item");
    expect(within(row).queryByTestId("review-accept")).toBeNull();
    expect(within(row).getByTestId("review-why").textContent).toBe("The bank removed this charge.");
    press("a");
    expect(api.find("POST", /accept$/)).toHaveLength(0);
  });

  it("an answer the server refuses brings the item back with a notice", async () => {
    installApi([
      on("GET", "/api/categorization/review", { items: [item(1)], total: 1 }),
      on("GET", "/api/budget/categories", CATEGORIES),
      on("POST", /accept$/, { error: "no" }, 500),
    ]);
    mount();
    fireEvent.click(await screen.findByTestId("review-accept"));
    expect((await screen.findByText("Couldn't save that answer. It's still in the queue.")).textContent).toBeTruthy();
    expect(screen.getAllByTestId("review-item")).toHaveLength(1);
  });

  it("empty: 'Nothing to review. H2 filed everything it was sure about.'", async () => {
    reviewApi([]);
    mount();
    expect((await screen.findByTestId("review-empty")).textContent).toBe("Nothing to review. H2 filed everything it was sure about.");
  });

  it("a failed load says so, with Try again", async () => {
    installApi([on("GET", "/api/categorization/review", { error: "x" }, 500), on("GET", "/api/budget/categories", CATEGORIES)]);
    mount();
    expect((await screen.findByTestId("review-failed")).textContent).toContain("Couldn't load the review queue.");
  });
});

describe("Review › Categories — the two-action toast and undo", () => {
  it("Accept says what H2 will remember and offers Undo, which posts the user decision id and puts the item back", async () => {
    const api = reviewApi([item(1)], [on("POST", "/api/category-decisions/u1/undo", { decisionId: "u1", transactionId: "t1", categoryId: null })]);
    mount();
    fireEvent.click(await screen.findByTestId("review-accept"));
    const toast = await screen.findByTestId("toast").catch(() => null);
    const text = toast?.textContent ?? document.body.textContent ?? "";
    expect(text).toContain("Filed under Groceries. H2 will remember Merchant 1.");
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.find("POST", /category-decisions\/u1\/undo$/)).toHaveLength(1));
    expect(await screen.findByText("Put back.")).toBeTruthy();
    expect(screen.getAllByTestId("review-item")).toHaveLength(1);
  });

  it("no Undo when the server wrote no user decision; no 'Apply' unless it reports similar charges", async () => {
    reviewApi([item(1)], [], { userDecisionId: null });
    mount();
    fireEvent.click(await screen.findByTestId("review-accept"));
    expect(await screen.findByText(/Filed under Groceries/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Apply to/ })).toBeNull();
  });

  it("'Apply to N similar' sits beside Undo, and nothing moves until it is pressed", async () => {
    const rule = { id: "ru1", signature: "merchant 1", scope: "merchant", categoryId: "c2", count: 1, disabled: false, amountBandLo: null, amountBandHi: null, plaidAccountId: null, lastConfirmedAt: null, source: "user", createdAt: "2026-10-07T00:00:00Z" };
    const api = reviewApi(
      [item(1)],
      [
        on("GET", "/api/learned-rules", [rule]),
        on("POST", "/api/learned-rules/ru1/apply-retroactively", { updated: 4 }),
      ],
      { resolution: "corrected", categoryId: "c2", retroactiveCandidates: { count: 4, sample: [] } },
    );
    mount();
    fireEvent.click(await screen.findByTestId("review-change"));
    fireEvent.change(await screen.findByTestId("category-search"), { target: { value: "dining" } });
    expect(screen.getAllByTestId("category-option").map((o) => o.textContent)).toEqual(["Dining out"]);
    fireEvent.click(screen.getByTestId("category-option"));
    const apply = await screen.findByRole("button", { name: "Apply to 4 similar" });
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(api.find("POST", /apply-retroactively/)).toHaveLength(0);
    fireEvent.click(apply);
    await waitFor(() => expect(api.find("POST", /learned-rules\/ru1\/apply-retroactively$/)).toHaveLength(1));
    expect(await screen.findByText("Filed 4 similar charges.")).toBeTruthy();
  });
});

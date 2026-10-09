import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Transaction } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { SplitByCategoryButton } from "./SplitByCategoryButton";

/**
 * (F4) Split by category against a fake server (the real generated hooks run).
 * Ported from h2's `activity.test.tsx` "the row menu and the split sheet".
 */
interface Call { method: string; path: string; body: unknown }
function installApi(opts: { splits?: unknown; post?: number; del?: number } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://x.test");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (/\/transactions\/t1\/splits$/.test(url.pathname)) {
        if (method === "GET") return new Response(JSON.stringify(opts.splits ?? { transactionId: "t1", amount: "-18.40", invalid: false, splits: [] }), { status: 200, headers: { "content-type": "application/json" } });
        if (method === "POST") return new Response(opts.post && opts.post >= 400 ? JSON.stringify({ error: "no" }) : null, { status: opts.post ?? 204, headers: { "content-type": "application/json" } });
        if (method === "DELETE") return new Response(null, { status: opts.del ?? 204 });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }),
  );
  return { calls, find: (m: string) => calls.filter((c) => c.method === m && /t1\/splits$/.test(c.path)) };
}

const TX = { id: "t1", description: "CORNER MARKET", displayName: "Corner Market", amount: "-18.40", occurredOn: "2026-10-07", categoryId: "c1" } as unknown as Transaction;
const CATS = [{ id: "c1", name: "Groceries" }, { id: "c2", name: "Dining out" }];
const mount = (splitCount?: number) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SplitByCategoryButton tx={TX} categories={CATS} splitCount={splitCount} />
      <Toaster />
    </QueryClientProvider>,
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const open = async () => {
  fireEvent.click(screen.getByTestId("button-split-category-t1"));
  return screen.findByTestId("split-form");
};
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Split by category", () => {
  it("is labelled apart from the allowance-bucket split, and shows the row's split count", async () => {
    installApi();
    mount(3);
    expect(screen.getByTestId("button-split-category-t1").textContent).toBe("Split ×3");
    expect(screen.getByLabelText("Split Corner Market by category")).toBeTruthy();
    await open();
    expect(screen.getByRole("dialog").textContent).toContain("Split by category");
    expect(screen.getByRole("dialog").textContent).toContain("not the allowance-bucket split");
  });

  it("Save stays off until the remainder reads $0.00, then POSTs signed parts", async () => {
    const api = installApi();
    mount();
    await open();
    const save = screen.getByTestId("split-save") as HTMLButtonElement;
    const remainder = screen.getByTestId("split-remainder");
    expect(save.disabled).toBe(true);
    type("Amount for part 1", "10");
    expect(remainder.textContent).toBe("Left to assign $8.40");
    expect(save.disabled).toBe(true);
    type("Amount for part 2", "8.40");
    fireEvent.change(screen.getByLabelText("Category for part 2"), { target: { value: "c2" } });
    expect(remainder.textContent).toBe("Balanced $0.00");
    expect(save.disabled).toBe(false);
    type("Amount for part 2", "9");
    expect(remainder.textContent).toBe("Over by $0.60");
    expect(save.disabled).toBe(true);
    type("Amount for part 2", "8.40");
    fireEvent.click(save);
    await waitFor(() => expect(api.find("POST")).toHaveLength(1));
    expect(api.find("POST")[0]!.body).toEqual({
      splits: [
        { categoryId: "c1", amount: "-10.00" },
        { categoryId: "c2", amount: "-8.40" },
      ],
    });
    expect(await screen.findByText("Split into 2.")).toBeTruthy();
  });

  it("an unfiled part keeps Save off even when the amounts balance", async () => {
    installApi();
    mount();
    await open();
    type("Amount for part 1", "10");
    type("Amount for part 2", "8.40");
    expect(screen.getByTestId("split-remainder").textContent).toBe("Balanced $0.00");
    expect((screen.getByTestId("split-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Add a part stops at MAX_PARTS (20)", async () => {
    installApi();
    mount();
    await open();
    for (let i = 0; i < 25; i++) {
      const add = screen.getByTestId("split-add") as HTMLButtonElement;
      if (!add.disabled) fireEvent.click(add);
    }
    expect(screen.getAllByTestId("split-part")).toHaveLength(20);
    expect((screen.getByTestId("split-add") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an existing split opens for editing, says when the charge moved, and can be removed", async () => {
    const api = installApi({
      splits: {
        transactionId: "t1", amount: "-18.40", invalid: true,
        splits: [
          { id: "s1", categoryId: "c1", amount: "-10.00" },
          { id: "s2", categoryId: "c2", amount: "-8.40" },
        ],
      },
    });
    mount(2);
    await open();
    expect((screen.getByLabelText("Amount for part 1") as HTMLInputElement).value).toBe("10.00");
    expect((screen.getByLabelText("Category for part 2") as HTMLSelectElement).value).toBe("c2");
    expect(screen.getByTestId("split-invalid").textContent).toContain("counts whole");
    fireEvent.click(screen.getByTestId("split-remove"));
    await waitFor(() => expect(api.find("DELETE")).toHaveLength(1));
    expect(await screen.findByText("Split removed.")).toBeTruthy();
  });

  it("a refusal says nothing changed", async () => {
    installApi({ post: 400 });
    mount();
    await open();
    type("Amount for part 1", "10");
    type("Amount for part 2", "8.40");
    fireEvent.change(screen.getByLabelText("Category for part 2"), { target: { value: "c2" } });
    fireEvent.click(screen.getByTestId("split-save"));
    expect(await screen.findByText("Couldn't split that charge. Nothing changed.")).toBeTruthy();
  });
});

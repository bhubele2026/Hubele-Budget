import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiUsageSummary, MemoryItem, MeResponse, WishlistItem, WishlistList } from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";

/**
 * ⭐ MEMORY, THE WISH LIST AND THE AI COST — each page shows what the server
 * sent and sends exactly what the person asked for. The cost page does no
 * arithmetic: a test reads its source for any.
 */
type Fn = ReturnType<typeof vi.fn>;
const mocks = vi.hoisted(() => ({
  put: null as unknown as Fn,
  del: null as unknown as Fn,
  createWish: null as unknown as Fn,
  updateWish: null as unknown as Fn,
  budget: null as unknown as Fn,
  proposals: null as unknown,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  const mut = (k: "put" | "del" | "createWish" | "updateWish" | "budget") => () => ({ mutateAsync: mocks[k], mutate: mocks[k], isPending: false });
  return {
    ...actual,
    usePutMemory: mut("put"),
    useDeleteMemory: mut("del"),
    useCreateWishlistItem: mut("createWish"),
    useUpdateWishlistItem: mut("updateWish"),
    useUpdateAiBudget: mut("budget"),
    useListAgentProposals: () => mocks.proposals,
  };
});

import { MemoryView, NEVER_STORED } from "./AskMemory";
import { WishlistView, AFFORD_LINE, parseAmount } from "@/screens/plan/PlanWishlist";
import { AiCostView, capOf } from "@/screens/household/AiCost";

const NOW = new Date("2026-10-07T15:00:00Z");
const loaded = <T,>(data: T | undefined, over: Partial<Read<T>> = {}): Read<T> => ({ data, state: data === undefined ? "cold" : "loaded", isFetching: false, refetch: vi.fn(), ...over });
const mount = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  mocks.put = vi.fn().mockResolvedValue({});
  mocks.del = vi.fn().mockResolvedValue({});
  mocks.createWish = vi.fn().mockResolvedValue({});
  mocks.updateWish = vi.fn().mockResolvedValue({});
  mocks.budget = vi.fn().mockResolvedValue({});
  mocks.proposals = { data: { proposals: [] }, isFetching: false };
});
afterEach(cleanup);

const mem = (id: string, scope: MemoryItem["scope"], key: string, text: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id, scope, key, value: { text }, source: "user_stated", createdByKind: "user", memberUserId: null, updatedAt: "2026-10-05T12:00:00Z", ...over,
});

describe("Memory", () => {
  const MEMS = [
    mem("k1", "categorization", "sample_diner", "Sample Diner is Dining out."),
    mem("k2", "categorization", "corner_market", "Corner Market is Groceries.", { source: "inferred", value: { text: "Corner Market is Groceries.", evidence: ["txn-aaa111"] } }),
    mem("k3", "spending", "weekend_limit", "Weekends under $150.", { source: "agent_proposed", memberUserId: "u1" }),
  ];

  it("grouped by topic, key and value as words, the source in words, evidence as links, and the never-stored line", () => {
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    expect(screen.getByTestId("memory-categorization")).toBeTruthy();
    expect(screen.getByTestId("memory-spending")).toBeTruthy();
    expect(screen.queryByTestId("memory-debt")).toBeNull();
    const rows = screen.getAllByTestId("memory-item");
    expect(rows[0]!.textContent).toContain("Sample diner");
    expect(rows.map((r) => /You said|H2 inferred|H2 proposed/.exec(r.textContent!)![0])).toEqual(["You said", "H2 inferred", "H2 proposed"]);
    expect(within(rows[1]!).getByTestId("memory-evidence").getAttribute("href")).toBe("/activity?txn=txn-aaa111");
    expect(screen.getByTestId("memory-foot").textContent).toBe(NEVER_STORED);
    expect(NEVER_STORED).toBe("H2 never stores account numbers or balances here.");
  });

  it("edit sends the new value with the note's scope and key (PUT)", async () => {
    const user = userEvent.setup();
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    await user.click(within(screen.getAllByTestId("memory-item")[0]!).getByTestId("memory-edit"));
    const box = await screen.findByTestId("memory-edit-input");
    await user.clear(box);
    await user.type(box, "Sample Diner is Fun.");
    await user.click(screen.getByTestId("memory-save"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put).toHaveBeenCalledWith({ scope: "categorization", key: "sample_diner", data: { value: "Sample Diner is Fun." } });
  });

  it("a member's own note stays theirs when edited; an empty edit sends nothing", async () => {
    const user = userEvent.setup();
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    await user.click(within(screen.getAllByTestId("memory-item")[2]!).getByTestId("memory-edit"));
    const box = await screen.findByTestId("memory-edit-input");
    await user.clear(box);
    await user.click(screen.getByTestId("memory-save"));
    expect(mocks.put).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.type(box, "Under $120.");
    await user.click(screen.getByTestId("memory-save"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith({ scope: "spending", key: "weekend_limit", data: { value: "Under $120.", mine: true } }));
  });

  it("delete asks first, then calls DELETE with the note's id", async () => {
    const user = userEvent.setup();
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    await user.click(within(screen.getAllByTestId("memory-item")[1]!).getByTestId("memory-delete"));
    expect(mocks.del).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("memory-forget-yes"));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith({ id: "k2" }));
  });

  it("empty and failed states are words", () => {
    mount(<MemoryView memories={loaded([] as MemoryItem[])} now={NOW} />);
    expect(screen.getByTestId("memory-empty")).toBeTruthy();
    cleanup();
    mount(<MemoryView memories={loaded<MemoryItem[]>(undefined, { state: "failed" })} now={NOW} />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load what H2 remembers.");
  });
});

describe("Wish list", () => {
  const item = (id: string, title: string, over: Partial<WishlistItem> = {}): WishlistItem => ({
    id, title, amount: 480, url: null, categoryId: null, targetDate: null, requestedBy: "u1", requestedAt: "2026-10-05T12:00:00Z",
    waitingUntil: "2026-10-12", waitingDaysLeft: 5, decision: "pending", decidedAt: null, ...over,
  });
  const list = (items: WishlistItem[]): Read<WishlistList> => loaded({ items, waitDays: 7 });

  it("title, amount, asked date, 'Wait until', decisions; decided items sit apart without controls; the Afford line", () => {
    mount(
      <WishlistView
        list={list([item("w1", "Standing desk"), item("w2", "Rain jacket", { waitingDaysLeft: 0, decision: "approved", amount: 120 }), item("w3", "Board game", { decision: "bought", amount: 45 })])}
      />,
    );
    const live = within(screen.getByTestId("wish-active")).getAllByTestId("wish-item");
    expect(live).toHaveLength(2);
    expect(live[0]!.textContent).toContain("Standing desk");
    expect(live[0]!.textContent).toContain("$480");
    expect(within(live[0]!).getByTestId("wish-wait").textContent).toBe("Wait until Oct 12");
    expect(within(live[1]!).getByTestId("wish-wait").textContent).toBe("Waiting period over");
    const done = within(screen.getByTestId("wish-decided")).getAllByTestId("wish-item");
    expect(done).toHaveLength(1);
    expect(within(done[0]!).queryByTestId("wish-bought")).toBeNull();
    expect(screen.getByTestId("afford-note").textContent).toBe(AFFORD_LINE);
  });

  it("Bought and Dropped send the decision", async () => {
    const user = userEvent.setup();
    mount(<WishlistView list={list([item("w1", "Standing desk")])} />);
    await user.click(screen.getByTestId("wish-bought"));
    await waitFor(() => expect(mocks.updateWish).toHaveBeenCalledWith({ id: "w1", data: { decision: "bought" } }));
    await user.click(screen.getByTestId("wish-dropped"));
    await waitFor(() => expect(mocks.updateWish).toHaveBeenCalledWith({ id: "w1", data: { decision: "declined" } }));
  });

  it("Add: the sheet needs a title, takes dollars and an optional link, and sends the body", async () => {
    const user = userEvent.setup();
    mount(<WishlistView list={list([])} />);
    expect(screen.getByTestId("wishlist-note")).toBeTruthy();
    await user.click(screen.getByTestId("wish-add"));
    await user.click(await screen.findByTestId("wish-save"));
    expect(mocks.createWish).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("wish-title"), "Rain jacket");
    await user.type(screen.getByTestId("wish-amount"), "$1,120.50");
    await user.type(screen.getByTestId("wish-url"), "https://example.com/jacket");
    await user.click(screen.getByTestId("wish-save"));
    await waitFor(() => expect(mocks.createWish).toHaveBeenCalledTimes(1));
    expect(mocks.createWish).toHaveBeenCalledWith({ data: { title: "Rain jacket", amount: 1120.5, url: "https://example.com/jacket" } });
  });

  it("title alone is enough; a bad link is refused", async () => {
    const user = userEvent.setup();
    mount(<WishlistView list={list([])} />);
    await user.click(screen.getByTestId("wish-add"));
    await user.type(await screen.findByTestId("wish-title"), "Lamp");
    await user.type(screen.getByTestId("wish-url"), "javascript:alert(1)");
    await user.click(screen.getByTestId("wish-save"));
    expect(mocks.createWish).not.toHaveBeenCalled();
    await user.clear(screen.getByTestId("wish-url"));
    await user.click(screen.getByTestId("wish-save"));
    await waitFor(() => expect(mocks.createWish).toHaveBeenCalledWith({ data: { title: "Lamp" } }));
  });

  it("parseAmount", () => {
    expect([parseAmount(""), parseAmount("$12"), parseAmount("1,000.5"), parseAmount("12.345"), parseAmount("abc")]).toEqual([null, 12, 1000.5, "bad", "bad"]);
  });
});

describe("AI cost", () => {
  const USAGE: AiUsageSummary = {
    month: "2026-10",
    monthToDateUsd: 1.84,
    calls: 96,
    failures: 3,
    blocked: 1,
    cacheHitRatio: 0.72,
    byTask: [
      { task: "chat", costUsd: 0.91, calls: 24, failures: 1 },
      { task: "categorize", costUsd: 0.62, calls: 58, failures: 1 },
    ],
    budget: { monthlyCapUsd: 5, hardCapUsd: 10, dailyCaps: {}, pausedUntil: null },
    recentRuns: [{ id: "r1", kind: "chat", trigger: "user", status: "succeeded", startedAt: "2026-10-07T14:20:00Z", finishedAt: null, summary: "2 tools, 1 proposal", inputTokens: 1, outputTokens: 1, costUsd: 0.04 }],
  };
  const data = (usage: AiUsageSummary | undefined, owner = true) => ({ usage: loaded(usage), me: loaded({ isOwner: owner } as MeResponse) });

  it("shows the server's numbers as sent: month, by task, counts, cache, caps, last runs", () => {
    mount(<AiCostView data={data(USAGE)} now={NOW} />);
    expect(screen.getByTestId("figure-ai-month").textContent).toContain("$1.84");
    const rows = screen.getAllByTestId("ai-task-row").map((r) => r.textContent);
    expect(rows).toEqual(["Ask$0.91241", "Filing charges$0.62581"]);
    expect([screen.getByTestId("ai-calls"), screen.getByTestId("ai-failures"), screen.getByTestId("ai-blocked"), screen.getByTestId("ai-cache")].map((e) => e.textContent)).toEqual(["96", "3", "1", "72%"]);
    expect(screen.getByTestId("ai-cap-monthly").textContent).toContain("Within the cap");
    expect(screen.getByTestId("ai-cap-monthly").textContent).toContain("of $5");
    expect(screen.getByTestId("ai-cap-hard").textContent).toContain("of $10");
    expect(screen.getByTestId("ai-run").textContent).toContain("$0.04");
    expect(screen.getByTestId("ai-run").textContent).toContain("2 tools, 1 proposal");
  });

  it("owner: cap edits go to PUT /ai/budget with only what changed", async () => {
    const user = userEvent.setup();
    mount(<AiCostView data={data(USAGE)} now={NOW} />);
    const m = screen.getByTestId("ai-monthly-input");
    await user.clear(m);
    await user.type(m, "$8");
    await user.click(screen.getByTestId("ai-caps-save"));
    await waitFor(() => expect(mocks.budget).toHaveBeenCalledWith({ data: { monthlyCapUsd: 8 } }));
  });

  it("owner: Pause needs a day and sends it; Resume clears it", async () => {
    const user = userEvent.setup();
    mount(<AiCostView data={data(USAGE)} now={NOW} />);
    await user.click(screen.getByTestId("ai-pause"));
    expect(mocks.budget).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("ai-pause-date"), "2026-10-20");
    await user.click(screen.getByTestId("ai-pause"));
    await waitFor(() => expect(mocks.budget).toHaveBeenCalledTimes(1));
    const sent = (mocks.budget.mock.calls[0]![0] as { data: { pausedUntil: string } }).data.pausedUntil;
    expect(new Date(sent).getFullYear()).toBe(2026);
    cleanup();
    mount(<AiCostView data={data({ ...USAGE, budget: { ...USAGE.budget, pausedUntil: "2026-10-20T05:00:00Z" } })} now={NOW} />);
    expect(screen.getByTestId("ai-pause-state").textContent).toContain("paused until Oct 20");
    await user.click(screen.getByTestId("ai-resume"));
    await waitFor(() => expect(mocks.budget).toHaveBeenLastCalledWith({ data: { pausedUntil: null } }));
  });

  it("a member sees the numbers and no controls", () => {
    mount(<AiCostView data={data(USAGE, false)} now={NOW} />);
    expect(screen.queryByTestId("ai-caps-form")).toBeNull();
    expect(screen.queryByTestId("ai-pause")).toBeNull();
    expect(screen.getByText("The household owner sets the caps.")).toBeTruthy();
  });

  it("capOf", () => {
    expect([capOf("$8"), capOf("12.50"), capOf("x"), capOf("")]).toEqual([8, 12.5, null, null]);
  });

  it("the page's source does no arithmetic on a figure it was sent", () => {
    // Only reads, formats and compares: no + - * / % on a dollar amount.
    const src = readFileSync(join(import.meta.dirname, "../household/AiCost.tsx"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.includes("import "))
      .join("\n");
    const code = src.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|<\/?[A-Za-z][^>]*>|\/>/g, "");
    expect(code).not.toMatch(/(usage|u|budget|t|r|c)\.(monthToDateUsd|costUsd|calls|failures|blocked|cacheHitRatio|monthlyCapUsd|hardCapUsd)\s*[-+*/%]/);
    expect(code).not.toMatch(/[-+*/%]\s*(usage|u|budget|t|r|c)\.(monthToDateUsd|costUsd|calls|failures|blocked|cacheHitRatio|monthlyCapUsd|hardCapUsd)/);
    expect(code).not.toMatch(/\.reduce\(|Math\.(round|floor|ceil|max|min)|\.toFixed\(/);
  });
});

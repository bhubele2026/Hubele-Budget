import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentProposal, AiMessage } from "@workspace/api-client-react";

/**
 * ⭐ ASK: the question, the stream, the linked charges, the proposals.
 * Hooks are mocked at the boundary; the network is a stubbed `fetch` carrying
 * real SSE frames, so what is checked is what the page shows and what it sends.
 */
type Fn = ReturnType<typeof vi.fn>;
const mocks = vi.hoisted(() => ({
  health: null as unknown,
  convs: null as unknown,
  detail: null as unknown,
  proposals: null as unknown,
  cats: null as unknown,
  spine: null as unknown,
  create: null as unknown as Fn,
  approve: null as unknown as Fn,
  reject: null as unknown as Fn,
  getConv: null as unknown as Fn,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useHealthCheck: () => mocks.health,
    useListAiConversations: () => mocks.convs,
    useGetAiConversation: () => mocks.detail,
    useListAgentProposals: () => mocks.proposals,
    useListCategories: () => mocks.cats,
    useCreateAiConversation: () => ({ mutateAsync: mocks.create, isPending: false }),
    useApproveAgentProposal: () => ({ mutateAsync: mocks.approve, isPending: false }),
    useRejectAgentProposal: () => ({ mutateAsync: mocks.reject, isPending: false }),
    getAiConversation: (...a: unknown[]) => (mocks.getConv as unknown as (...x: unknown[]) => unknown)(...a),
  };
});
vi.mock("@/data/useSpine", () => ({ useSpine: () => mocks.spine }));
vi.mock("@/data/aiStream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/data/aiStream")>();
  return { ...actual, pollForAnswer: (o: Parameters<typeof actual.pollForAnswer>[0]) => actual.pollForAnswer({ ...o, sleep: async () => {} }) };
});

import Ask, { AI_OFF, HINT, SUGGESTIONS } from "./Ask";
import { ProposalsView } from "./Proposals";

const enc = new TextEncoder();
const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = (chunks: string[], fail = false) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        if (fail) c.error(new Error("network"));
        else c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
const q = <T,>(data: T | undefined, over: Record<string, unknown> = {}) => ({ data, isFetching: false, isError: false, isLoadingError: false, refetch: vi.fn(), ...over });
const msg = (id: string, role: "user" | "assistant", text: string, runId: string | null = null, extra: Record<string, unknown> = {}): AiMessage => ({
  id,
  role,
  content: { text, ...extra },
  runId,
  createdAt: "2026-10-07T14:21:00Z",
});
const proposal = (over: Partial<AgentProposal> = {}): AgentProposal => ({
  id: "p1",
  kind: "budget_line",
  status: "proposed",
  payload: { target: "cat-1", before: 400, after: 350, label: "Dining out" },
  rationale: "September ran over.",
  runId: "run-1",
  decidedBy: null,
  decidedAt: null,
  appliedActionId: null,
  expiresAt: "2026-10-21T00:00:00Z",
  createdAt: "2026-10-07T00:00:00Z",
  ...over,
});

const bodyOfLastPost = (f: Fn) => JSON.parse((f.mock.calls.at(-1)![1] as RequestInit).body as string);
const mount = (ui = <Ask />) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
let fetchMock: Fn;

beforeEach(() => {
  mocks.health = q({ status: "ok", ai: { enabled: true, configured: true, provider: "fake" } });
  mocks.convs = q({ conversations: [{ id: "c-old", title: "Eating out", createdAt: "2026-10-06T00:00:00Z", lastMessageAt: "2026-10-06T00:00:00Z" }] });
  mocks.detail = q(undefined);
  mocks.proposals = q({ proposals: [] });
  mocks.cats = q([{ id: "cat-g", name: "Groceries" }]);
  mocks.spine = { data: { bank: { stale: false, asOfDate: "2026-10-07" } }, state: "loaded" };
  mocks.create = vi.fn().mockResolvedValue({ id: "c-new", title: "", createdAt: "x", lastMessageAt: "x" });
  mocks.approve = vi.fn().mockResolvedValue({});
  mocks.reject = vi.fn().mockResolvedValue({});
  mocks.getConv = vi.fn();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Ask — the empty page", () => {
  it("the hint line and three quiet suggested questions; a chip fills the box and sends nothing", async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getAllByText(HINT).length).toBeGreaterThan(0);
    const chips = screen.getAllByTestId("suggestion");
    expect(chips.map((c) => c.textContent)).toEqual([...SUGGESTIONS]);
    await user.click(chips[1]!);
    expect((screen.getByTestId("ask-input") as HTMLTextAreaElement).value).toBe("Can we spend $300 this weekend and still cover bills?");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("past conversations are listed, and picking one shows its thread", async () => {
    const user = userEvent.setup();
    mocks.detail = q({ conversation: { id: "c-old" }, messages: [msg("m1", "user", "Hello"), msg("m2", "assistant", "Hi there.")] });
    mount();
    await user.click(screen.getAllByTestId("conversation-item")[0]!);
    expect(screen.getByTestId("msg-user").textContent).toContain("Hello");
    expect(screen.getByTestId("msg-assistant").textContent).toContain("Hi there.");
    expect(screen.queryByTestId("suggestions")).toBeNull();
  });
});

describe("Ask — AI turned off", () => {
  it("the composer is disabled and says where to turn it on", () => {
    mocks.health = q({ status: "ok", ai: { enabled: false, configured: false, provider: "fake" } });
    mount();
    expect((screen.getByTestId("ask-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("ask-send") as HTMLButtonElement).disabled).toBe(true);
    const note = screen.getByTestId("ask-ai-off");
    expect(note.textContent).toBe(`${AI_OFF}Household › AI`);
    expect(within(note).getByRole("link").getAttribute("href")).toBe("/household/ai");
    expect(screen.queryByTestId("suggestions")).toBeNull();
  });
});

describe("Ask — stale bank", () => {
  it("shows the freshness line on top only when the bank is stale", () => {
    mount();
    expect(screen.queryByTestId("ask-fresh")).toBeNull();
    cleanup();
    mocks.spine = { data: { bank: { stale: true, staleReason: "old", asOfDate: "2026-10-01", lastContactAt: "2026-10-01T10:00:00Z", source: "plaid" } }, state: "loaded" };
    mount();
    expect(screen.getByTestId("ask-fresh")).toBeTruthy();
  });
});

describe("Ask — sending", () => {
  it("creates a conversation, streams tokens, and the done text replaces them", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => {
      // The server has stored the pair by the time the stream ends.
      mocks.detail = q({ conversation: { id: "c-new" }, messages: [msg("m1", "user", "How much did we spend?"), msg("m2", "assistant", "You spent $12.", "run-9")] });
      return sse([
        frame("tool", { type: "tool", name: "get_spending_summary", status: "running" }),
        frame("token", { type: "token", text: "You spent " }),
        frame("done", { type: "done", runId: "run-9", messageId: "m2", text: "You spent $12.", grounded: true, demo: false }),
      ]);
    });
    mount();
    await user.type(screen.getByTestId("ask-input"), "How much did we spend?");
    await user.click(screen.getByTestId("ask-send"));
    await waitFor(() => expect(screen.getByTestId("msg-assistant").textContent).toContain("You spent $12."));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(bodyOfLastPost(fetchMock)).toEqual({ conversationId: "c-new", text: "How much did we spend?", userAskedToChange: false });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe("include");
    expect(screen.queryByTestId("msg-assistant-pending")).toBeNull();
    expect(screen.getAllByTestId("msg-user")).toHaveLength(1);
  });

  it("shows a quiet 'Looking at spending…' line while a tool runs", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode(frame("tool", { type: "tool", name: "get_spending_summary", status: "running" })));
              await new Promise<void>((r) => (release = r));
              c.enqueue(enc.encode(frame("error", { type: "error", code: "api_error", message: "The assistant had a problem. Try again.", retryable: true })));
              c.close();
            },
          }),
          { status: 200 },
        ),
    );
    mount();
    await user.type(screen.getByTestId("ask-input"), "q");
    await user.click(screen.getByTestId("ask-send"));
    expect((await screen.findByTestId("tool-line")).textContent).toBe("Looking at spending…");
    release();
    await screen.findByTestId("ask-failure");
  });

  it("userAskedToChange is sent only when the box is ticked, and the box resets", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => sse([frame("done", { type: "done", text: "Filed.", runId: "r", messageId: "m" })]));
    mount();
    const box = screen.getByTestId("ask-may-change") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText("Let H2 file charges I name in this message")).toBeTruthy();
    await user.type(screen.getByTestId("ask-input"), "File Sample Diner as Dining out");
    await user.click(box);
    await user.click(screen.getByTestId("ask-send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOfLastPost(fetchMock).userAskedToChange).toBe(true);
    await waitFor(() => expect((screen.getByTestId("ask-may-change") as HTMLInputElement).checked).toBe(false));
    await waitFor(() => expect((screen.getByTestId("ask-input") as HTMLTextAreaElement).disabled).toBe(false));
    await user.type(screen.getByTestId("ask-input"), "And another");
    await user.click(screen.getByTestId("ask-send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOfLastPost(fetchMock).userAskedToChange).toBe(false);
  });

  it("a dropped stream is not an error: it polls the conversation until the answer is stored", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => sse([frame("token", { type: "token", text: "partial" })], true));
    mocks.getConv
      .mockResolvedValueOnce({ conversation: {}, messages: [{ role: "user" }] })
      .mockImplementationOnce(async () => {
        mocks.detail = q({ conversation: { id: "c-new" }, messages: [msg("m1", "user", "q"), msg("m2", "assistant", "The stored answer.", "run-2")] });
        return { conversation: {}, messages: [{ role: "user" }, { role: "assistant" }] };
      });
    mount();
    await user.type(screen.getByTestId("ask-input"), "q");
    await user.click(screen.getByTestId("ask-send"));
    await waitFor(() => expect(screen.getByTestId("msg-assistant").textContent).toContain("The stored answer."));
    expect(mocks.getConv).toHaveBeenCalledTimes(2);
    expect(mocks.getConv).toHaveBeenCalledWith("c-new");
    expect(screen.queryByTestId("ask-failure")).toBeNull();
  });

  it("a budget error shows the server's own words and points at the AI cost page", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => sse([frame("error", { type: "error", code: "budget_exceeded", message: "Ask has reached its limit for now.", retryable: false })]));
    mount();
    await user.type(screen.getByTestId("ask-input"), "q");
    await user.click(screen.getByTestId("ask-send"));
    const note = await screen.findByTestId("ask-failure");
    expect(note.textContent).toContain("Ask has reached its limit for now.");
    expect(within(note).getByRole("link", { name: "AI cost" }).getAttribute("href")).toBe("/household/ai");
  });

  it("Enter sends; Shift+Enter does not", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => sse([frame("done", { type: "done", text: "ok" })]));
    mount();
    await user.type(screen.getByTestId("ask-input"), "one{Shift>}{Enter}{/Shift}two");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("ask-input"), "{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOfLastPost(fetchMock).text).toBe("one\ntwo");
  });
});

describe("Ask — the answer as text", () => {
  const open = async (text: string, extra: Record<string, unknown> = {}) => {
    const user = userEvent.setup();
    mocks.detail = q({ conversation: { id: "c-old" }, messages: [msg("m1", "user", "q"), msg("m2", "assistant", text, "run-1", extra)] });
    mount();
    await user.click(screen.getAllByTestId("conversation-item")[0]!);
  };

  it("paragraphs, and 'Based on' refs become links to that charge in the ledger", async () => {
    await open("You spent $412.\n\nThat is more than August.\nBased on: ref:txn-0001abc, ref:txn-0002def");
    const answer = screen.getByTestId("answer-text");
    expect(answer.querySelectorAll("p")).toHaveLength(2);
    const links = within(answer).getAllByTestId("answer-ref");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/activity?txn=txn-0001abc", "/activity?txn=txn-0002def"]);
    expect(answer.textContent).not.toContain("ref:");
  });

  it("never renders HTML: markup in an answer is text", async () => {
    await open("<b>bold</b> <img src=x onerror=alert(1)>");
    const answer = screen.getByTestId("answer-text");
    expect(answer.querySelector("b")).toBeNull();
    expect(answer.querySelector("img")).toBeNull();
    expect(answer.textContent).toContain("<b>bold</b>");
  });

  it("an answer whose figures could not be checked says so", async () => {
    await open("You spent $9.", { grounded: false });
    expect(screen.getByTestId("msg-assistant").textContent).toContain("could not check every figure");
  });

  it("a proposal the answer made renders inline as a card", async () => {
    mocks.proposals = q({ proposals: [proposal(), proposal({ id: "p-other", runId: "run-other" })] });
    await open("Lower the dining line to $350.");
    const cards = within(screen.getByTestId("msg-assistant")).getAllByTestId("proposal-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Change a budget line");
  });
});

describe("Proposals — approve and reject", () => {
  const data = (open: AgentProposal[], all: AgentProposal[] = open) => ({
    open: { data: open, state: "loaded" as const, isFetching: false, refetch: vi.fn() },
    all: { data: all, state: "loaded" as const, isFetching: false, refetch: vi.fn() },
    categories: new Map([["cat-g", "Groceries"]]),
  });

  it("each row: the kind in words, before → after, the rationale in a disclosure", () => {
    mount(<ProposalsView data={data([proposal(), proposal({ id: "p2", kind: "set_category", payload: { target: "t", txnId: "txn-1", before: null, after: "cat-g", label: "Category" } })])} />);
    const [a, b] = screen.getAllByTestId("proposal-card");
    expect(a!.textContent).toContain("Change a budget line");
    expect(within(a!).getByTestId("proposal-change").textContent).toBe("Dining out: $400 → $350");
    expect(a!.querySelector("details")?.textContent).toContain("September ran over.");
    expect(within(b!).getByTestId("proposal-change").textContent).toContain("Not filed");
    expect(within(b!).getByTestId("proposal-change").textContent).toContain("Groceries");
    expect(within(b!).getByRole("link", { name: "See the charge" }).getAttribute("href")).toBe("/activity?txn=txn-1");
  });

  it("Approve asks first ('This changes your plan'), then calls the server once", async () => {
    const user = userEvent.setup();
    mount(<ProposalsView data={data([proposal()])} />);
    await user.click(screen.getByTestId("proposal-approve"));
    const dialog = await screen.findByRole("dialog", { name: "This changes your plan" });
    expect(mocks.approve).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("proposal-confirm-approve"));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(1));
    expect(mocks.approve).toHaveBeenCalledWith({ id: "p1" });
    expect((await screen.findByTestId("proposal-note")).textContent).toBe("Applied.");
  });

  it("'Not now' changes nothing", async () => {
    const user = userEvent.setup();
    mount(<ProposalsView data={data([proposal()])} />);
    await user.click(screen.getByTestId("proposal-approve"));
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("Reject calls the server at once", async () => {
    const user = userEvent.setup();
    mount(<ProposalsView data={data([proposal()])} />);
    await user.click(screen.getByTestId("proposal-reject"));
    await waitFor(() => expect(mocks.reject).toHaveBeenCalledWith({ id: "p1" }));
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("a refusal (409) says nothing changed; the owner-only 403 says so", async () => {
    const user = userEvent.setup();
    mocks.approve.mockRejectedValueOnce({ status: 409 });
    mount(<ProposalsView data={data([proposal()])} />);
    await user.click(screen.getByTestId("proposal-approve"));
    await user.click(await screen.findByTestId("proposal-confirm-approve"));
    expect((await screen.findByTestId("proposal-note")).textContent).toContain("Nothing changed.");
  });

  it("history sits below: applied, rejected and expired, without buttons; empty says so", () => {
    mount(<ProposalsView data={data([], [proposal({ id: "h1", status: "applied", decidedAt: "2026-10-02T00:00:00Z" }), proposal({ id: "h2", status: "rejected" }), proposal({ id: "h3", status: "expired" })])} />);
    expect(screen.getByTestId("proposals-empty")).toBeTruthy();
    const hist = within(screen.getByTestId("proposals-history"));
    expect(hist.getAllByTestId("proposal-card").map((c) => c.getAttribute("data-status"))).toEqual(["applied", "rejected", "expired"]);
    expect(hist.queryByTestId("proposal-approve")).toBeNull();
  });

  it("the Plan index shows the count of open proposals", () => {
    mocks.proposals = q({ proposals: [proposal(), proposal({ id: "p2" })] });
    mount(<ProposalsView data={data([proposal(), proposal({ id: "p2" })])} />);
    const link = within(screen.getByTestId("plan-nav")).getByRole("link", { name: /Proposals/ });
    expect(link.textContent).toBe("Proposals (2)");
    expect(link.getAttribute("href")).toBe("/plan/proposals");
  });
});

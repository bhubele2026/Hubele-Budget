import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { READ_CLICK_FROM, WHATS_NEW } from "@workspace/avalanche-core/whatsNew";

/**
 * (WN) The host: when it greets (after the page is quiet; never before the
 * server answers; held by an open dialog or a focused field; re-asks the
 * server first), what the press does (POST with OWN_INVALIDATION — the
 * dashboard's numbers are not refetched; a failed save says so and does not
 * greet again), and that only the owner asks for the read report.
 * Fake timers; the /features hooks are stand-ins over real react-query.
 */

const h = vi.hoisted(() => ({
  me: vi.fn(),
  mark: vi.fn(),
  reads: vi.fn(),
  owner: false as boolean | "unknown",
  toast: vi.fn(),
}));

vi.mock("@workspace/api-client-react/features", async () => {
  const rq = await import("@tanstack/react-query");
  return {
    getGetWhatsNewMeQueryKey: () => ["/api/whats-new/me"],
    getGetWhatsNewReadsQueryKey: () => ["/api/whats-new/reads"],
    getWhatsNewMe: () => h.me(),
    useGetWhatsNewMe: (o: { query: Record<string, unknown> }) => rq.useQuery({ queryKey: ["/api/whats-new/me"], queryFn: () => h.me(), ...o.query }),
    useGetWhatsNewReads: (o: { query: Record<string, unknown> }) =>
      rq.useQuery({ queryKey: ["/api/whats-new/reads"], queryFn: () => h.reads(), ...o.query }),
    useMarkWhatsNewRead: (o: { mutation: Record<string, unknown> }) =>
      rq.useMutation({ mutationFn: ({ data }: { data: { ids: string[] } }) => h.mark(data), ...o.mutation }),
  };
});
vi.mock("@workspace/api-client-react", () => ({
  getGetVersionQueryKey: () => ["/api/version"],
  getGetSpineQueryKey: () => ["/api/spine"],
  getGetForecastBankBalanceExplainQueryKey: () => ["/api/forecast/bank-balance-explain"],
}));
vi.mock("@/hooks/useOwner", () => ({ useOwner: () => h.owner }));
vi.mock("@/hooks/use-toast", () => ({ toast: (t: unknown) => h.toast(t) }));

import WhatsNewHost, { SAVE_FAILED_WORDS, _resetWhatsNewSessionsForTests } from "./WhatsNewHost";
import { GREET_MIN_MS, MAX_WAIT_MS, QUIET_MS, RECHECK_MS } from "./greet";
import { _resetWhatsNewSignalForTests, requestWhatsNewOpen, useWhatsNewUnread } from "@/lib/whatsNewSignal";
import { onWriteSuccess } from "@/lib/mutationInvalidation";

const NOTE = WHATS_NEW[0]!.id;
// Every shipped note from the click date on: what greets a person who has read nothing.
const ALL_IDS = WHATS_NEW.filter((u) => u.id >= READ_CLICK_FROM).map((u) => u.id);
const UNREAD = { read: [] as string[], from: READ_CLICK_FROM };
const READ = { read: ALL_IDS, from: READ_CLICK_FROM };

let qc: QueryClient;
let signal: number | null | undefined;

function Signal() {
  signal = useWhatsNewUnread();
  return null;
}

function mount(path = "/home", userId = "user-a") {
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <Signal />
        <WhatsNewHost userId={userId} />
      </Router>
    </QueryClientProvider>,
  );
}

/** Let promises settle, then move the clock. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
/** Long enough for the greeting: the minimum wait, a quiet stretch, the idle callback. */
const GREET_AFTER = GREET_MIN_MS + QUIET_MS + 400;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T17:00:00Z"));
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    mutationCache: new MutationCache({ onSuccess: (_d, _v, _c, m) => onWriteSuccess(qc, m) }),
  });
  h.me.mockReset();
  h.mark.mockReset();
  h.reads.mockReset();
  h.toast.mockReset();
  h.owner = false;
  signal = undefined;
  _resetWhatsNewSessionsForTests();
  _resetWhatsNewSignalForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("when it greets", () => {
  it("never before the server answers, and not at all when it fails (the signal stays unknown)", async () => {
    h.me.mockReturnValue(new Promise(() => {}));
    mount();
    await advance(MAX_WAIT_MS + 5000);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    expect(signal).toBeNull();
    cleanup();

    qc.clear();
    h.me.mockRejectedValue(new Error("offline"));
    mount();
    await advance(MAX_WAIT_MS + 5000);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    expect(signal).toBeNull();
  });

  it("greets once the page is quiet and idle — not before the minimum wait", async () => {
    h.me.mockResolvedValue(UNREAD);
    mount();
    await advance(10);
    expect(signal).toBe(ALL_IDS.length);
    await advance(GREET_MIN_MS - 100);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    await advance(GREET_AFTER);
    expect(screen.getByTestId("whats-new-sheet").getAttribute("data-must-read")).toBe("true");
    // It asked the server again right before opening.
    expect(h.me).toHaveBeenCalledTimes(2);
  });

  it("waits while a request is in flight", async () => {
    h.me.mockResolvedValue(UNREAD);
    let release!: () => void;
    void qc.prefetchQuery({ queryKey: ["/api/slow"], queryFn: () => new Promise((r) => (release = () => r(1))) });
    mount();
    await advance(GREET_AFTER + 3000);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    release();
    await advance(GREET_AFTER);
    expect(screen.getByTestId("whats-new-sheet")).toBeTruthy();
  });

  it("is held while a dialog is open, then greets once it closes", async () => {
    h.me.mockResolvedValue(UNREAD);
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("data-state", "open");
    document.body.appendChild(other);
    mount();
    await advance(GREET_AFTER + 10 * RECHECK_MS);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    other.remove();
    await advance(RECHECK_MS + 50);
    expect(screen.getByTestId("whats-new-sheet")).toBeTruthy();
  });

  it("is held while someone is typing, then greets once the field loses focus", async () => {
    h.me.mockResolvedValue(UNREAD);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    mount();
    await advance(GREET_AFTER + 5 * RECHECK_MS);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    input.blur();
    await advance(RECHECK_MS + 50);
    expect(screen.getByTestId("whats-new-sheet")).toBeTruthy();
  });

  it("does not greet on the bank's sign-in return page", async () => {
    h.me.mockResolvedValue(UNREAD);
    mount("/plaid-oauth");
    await advance(GREET_AFTER + 5 * RECHECK_MS);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
  });

  it("the fresh ask before opening stops it when the note was read on another device", async () => {
    h.me.mockResolvedValueOnce(UNREAD).mockResolvedValue(READ);
    mount();
    await advance(10);
    expect(signal).toBe(ALL_IDS.length);
    await advance(GREET_AFTER + 500);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    expect(signal).toBe(0);
  });

  it("nothing unread: no greeting, and the signal says 0", async () => {
    h.me.mockResolvedValue(READ);
    mount();
    await advance(GREET_AFTER + 5000);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    expect(signal).toBe(0);
  });
});

describe("the press", () => {
  async function greeted() {
    h.me.mockResolvedValue(UNREAD);
    mount();
    await advance(GREET_AFTER + 200);
    expect(screen.getByTestId("whats-new-sheet")).toBeTruthy();
  }

  it("closes at once, POSTs the unread ids with OWN_INVALIDATION, and never refetches the dashboard", async () => {
    qc.setQueryData(["/api/spine"], { reviewCount: 1 });
    h.mark.mockResolvedValue({ ids: ALL_IDS });
    await greeted();
    fireEvent.click(screen.getByTestId("whats-new-button"));
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
    await advance(10);
    expect(h.mark).toHaveBeenCalledWith({ ids: ALL_IDS });
    const m = qc.getMutationCache().getAll()[0]!;
    expect(m.meta).toEqual({ invalidateAfterWrite: false });
    expect(m.state.status).toBe("success");
    expect(qc.getQueryState(["/api/spine"])!.isInvalidated).toBe(false);
    // The cache learns the read; the signal drops to 0; no second greeting.
    expect((qc.getQueryData(["/api/whats-new/me"]) as { read: string[] }).read).toEqual(ALL_IDS);
    expect(signal).toBe(0);
    await advance(GREET_AFTER + 5000);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
  });

  it("a save that still fails after its retries says so, and the sheet does not come back in this tab", async () => {
    h.mark.mockRejectedValue(new Error("offline"));
    await greeted();
    fireEvent.click(screen.getByTestId("whats-new-button"));
    await advance(10_000);
    expect(h.mark).toHaveBeenCalledTimes(3);
    expect(h.toast).toHaveBeenCalledWith({ title: SAVE_FAILED_WORDS });
    expect(SAVE_FAILED_WORDS).toBe("H2 couldn't save that. It will ask again next time.");
    await advance(GREET_AFTER + 10_000);
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
  });
});

describe("the link and the owner's report", () => {
  it("'What's new' opens the history; a member never asks for the report", async () => {
    h.me.mockResolvedValue(READ);
    h.owner = false;
    mount();
    await advance(10);
    act(() => requestWhatsNewOpen());
    expect(screen.getByTestId("whats-new-sheet").getAttribute("data-must-read")).toBe("false");
    await advance(100);
    expect(h.reads).not.toHaveBeenCalled();
    expect(screen.queryByTestId("whats-new-readby")).toBeNull();
    fireEvent.click(screen.getByTestId("whats-new-button"));
    expect(screen.queryByTestId("whats-new-sheet")).toBeNull();
  });

  it("the owner's sheet asks for the report and shows the line", async () => {
    h.me.mockResolvedValue(READ);
    h.owner = true;
    h.reads.mockResolvedValue({ updates: [{ id: NOTE, readers: [{ userId: "m", name: "Jen", readAt: "2026-10-15T18:00:00Z" }] }] });
    mount();
    await advance(10);
    expect(h.reads).not.toHaveBeenCalled(); // only when the sheet is open
    act(() => requestWhatsNewOpen());
    await advance(10);
    expect(h.reads).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("whats-new-readby").textContent).toBe("Read by Jen on Thursday, October 15");
  });

  it("the server unreachable: the link still opens the history, with no New chip", async () => {
    h.me.mockRejectedValue(new Error("offline"));
    mount();
    await advance(100);
    act(() => requestWhatsNewOpen());
    expect(screen.getByTestId("whats-new-sheet").getAttribute("data-must-read")).toBe("false");
    expect(screen.queryByTestId("whats-new-new")).toBeNull();
    expect(signal).toBeNull();
  });
});

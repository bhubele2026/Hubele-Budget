import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useTxDeepLink, GIVE_UP_MS, ledgerLoaded } from "./useTxDeepLink";

// (F8) `?tx=` on a ledger: scroll to the row once it is on screen, prefer the
// visible tree, strip only `tx` from the URL, and stop the scroll-to-today.

function Ledger({ ready, ids, scroll, loaded, scopeKey, onGiveUp }: { ready: boolean; ids: string[]; scroll?: boolean; loaded?: boolean; scopeKey?: unknown; onGiveUp?: () => void }) {
  const scrolled = useRef(false);
  const focus = useTxDeepLink({
    ready,
    rowTestIds: (id) => [`row-amex-${id}`, `row-amex-mobile-${id}`],
    scrolledRef: scrolled,
    scroll,
    loaded,
    scopeKey,
    onGiveUp,
    deps: [ids.length],
  });
  return (
    <div data-focus={focus ?? ""} data-scrolled={String(scrolled.current)}>
      {ids.map((id) => (
        <div key={id} data-testid={id} />
      ))}
    </div>
  );
}

const scrolls: string[] = [];
beforeEach(() => {
  scrolls.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolls.push(this.getAttribute("data-testid") ?? "");
  } as typeof Element.prototype.scrollIntoView;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("useTxDeepLink", () => {
  it("waits for the rows, scrolls to the row, and strips only tx from the URL", () => {
    window.history.replaceState(null, "", "/amex?month=2026-09-01&tx=t-9");
    const { rerender } = render(<Ledger ready={false} ids={[]} />);
    expect(scrolls).toEqual([]);
    expect(window.location.search).toBe("?month=2026-09-01&tx=t-9");
    rerender(<Ledger ready ids={["row-amex-t-1", "row-amex-t-9", "row-amex-mobile-t-9"]} />);
    expect(scrolls).toEqual(["row-amex-t-9"]);
    expect(window.location.search).toBe("?month=2026-09-01");
  });

  it("(Q6b) ready but the row is not there yet: stays armed, then scrolls exactly once when it arrives", () => {
    window.history.replaceState(null, "", "/amex?tx=t-9");
    const { rerender } = render(<Ledger ready ids={["row-amex-t-1"]} />);
    expect(scrolls).toEqual([]);
    expect(window.location.search).toBe("?tx=t-9");
    rerender(<Ledger ready ids={["row-amex-t-1", "row-amex-t-9"]} />);
    rerender(<Ledger ready ids={["row-amex-t-1", "row-amex-t-9", "row-amex-t-2"]} />);
    expect(scrolls).toEqual(["row-amex-t-9"]);
    expect(window.location.search).toBe("");
  });

  it("(Q6b) scroll=false: the page scrolls itself; the param is still stripped", () => {
    window.history.replaceState(null, "", "/amex?tx=t-9");
    render(<Ledger ready scroll={false} ids={["row-amex-t-9"]} />);
    expect(scrolls).toEqual([]);
    expect(window.location.search).toBe("");
  });

  it("prefers the visible tree", () => {
    window.history.replaceState(null, "", "/amex?tx=t-9");
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid")?.includes("mobile") ? document.body : null;
      },
    });
    try {
      render(<Ledger ready ids={["row-amex-t-9", "row-amex-mobile-t-9"]} />);
      expect(scrolls).toEqual(["row-amex-mobile-t-9"]);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetParent", desc);
    }
  });

  it("no tx: nothing happens", () => {
    window.history.replaceState(null, "", "/amex?month=2026-09-01");
    render(<Ledger ready ids={["row-amex-t-9"]} />);
    expect(scrolls).toEqual([]);
    expect(window.location.search).toBe("?month=2026-09-01");
  });

  it("the focus clears after a short pulse", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/amex?tx=t-9");
      const { container } = render(<Ledger ready ids={["row-amex-t-9"]} />);
      expect(container.firstElementChild!.getAttribute("data-focus")).toBe("t-9");
      act(() => {
        vi.advanceTimersByTime(2100);
      });
      expect(container.firstElementChild!.getAttribute("data-focus")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the focus still clears when more rows arrive during the pulse", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/amex?tx=t-9");
      const { container, rerender } = render(<Ledger ready ids={["row-amex-t-9"]} />);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      rerender(<Ledger ready ids={["row-amex-t-9", "row-amex-t-10"]} />);
      expect(scrolls).toEqual(["row-amex-t-9"]);
      act(() => {
        vi.advanceTimersByTime(1600);
      });
      expect(container.firstElementChild!.getAttribute("data-focus")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("(Q6b) a row that never appears", () => {
  it("once the ledger has loaded and the row is absent, the link is dropped after a short wait", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/amex?card=c1&tx=gone");
      const gave = vi.fn();
      const { container } = render(<Ledger ready loaded ids={["row-amex-t-1"]} onGiveUp={gave} />);
      expect(window.location.search).toBe("?card=c1&tx=gone");
      act(() => { vi.advanceTimersByTime(GIVE_UP_MS + 50); });
      expect(window.location.search).toBe("?card=c1");
      expect(gave).toHaveBeenCalledTimes(1);
      expect(container.firstElementChild!.getAttribute("data-focus")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
  it("a row that arrives inside the wait is still scrolled to, not dropped", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/amex?tx=late");
      const gave = vi.fn();
      const { rerender } = render(<Ledger ready loaded ids={[]} onGiveUp={gave} />);
      rerender(<Ledger ready loaded ids={["row-amex-late"]} onGiveUp={gave} />);
      act(() => { vi.advanceTimersByTime(GIVE_UP_MS + 50); });
      expect(scrolls).toEqual(["row-amex-late"]);
      expect(window.location.search).toBe("");
      expect(gave).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("not loaded yet: the link waits", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/amex?tx=gone");
      render(<Ledger ready loaded={false} ids={[]} />);
      act(() => { vi.advanceTimersByTime(GIVE_UP_MS * 3); });
      expect(window.location.search).toBe("?tx=gone");
    } finally {
      vi.useRealTimers();
    }
  });
  it("switching card before the row appeared drops the link at once", () => {
    window.history.replaceState(null, "", "/amex?card=c1&tx=gone");
    const gave = vi.fn();
    const { rerender } = render(<Ledger ready ids={[]} scopeKey="c1" onGiveUp={gave} />);
    rerender(<Ledger ready ids={[]} scopeKey="c2" onGiveUp={gave} />);
    expect(window.location.search).toBe("?card=c1");
    expect(gave).toHaveBeenCalledTimes(1);
  });
  it("(Q6b r3) a reload that starts inside the wait does not give up mid-load; the row that arrives in the second load is opened", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/amex?card=c1&month=2026-10-01&tx=new");
      const gave = vi.fn();
      const { rerender } = render(<Ledger ready loaded ids={[]} onGiveUp={gave} />);
      act(() => { vi.advanceTimersByTime(1000); });
      rerender(<Ledger ready loaded={false} ids={[]} onGiveUp={gave} />);
      act(() => { vi.advanceTimersByTime(GIVE_UP_MS); });
      expect(window.location.search).toBe("?card=c1&month=2026-10-01&tx=new");
      expect(gave).not.toHaveBeenCalled();
      rerender(<Ledger ready loaded ids={["row-amex-new"]} onGiveUp={gave} />);
      act(() => { vi.advanceTimersByTime(50); });
      expect(scrolls).toEqual(["row-amex-new"]);
      expect(gave).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("(Q6b r3) a reload that ends without the row restarts the wait, then drops the link", () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/amex?tx=gone");
      const gave = vi.fn();
      const { rerender } = render(<Ledger ready loaded ids={[]} onGiveUp={gave} />);
      act(() => { vi.advanceTimersByTime(1000); });
      rerender(<Ledger ready loaded={false} ids={[]} onGiveUp={gave} />);
      rerender(<Ledger ready loaded ids={[]} onGiveUp={gave} />);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(gave).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(600); });
      expect(gave).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("(Q6b r3) a FAILED month fetch is not 'loaded': the link is kept for a reload", async () => {
    window.history.replaceState(null, "", "/amex?card=c1&month=2026-10-01&tx=t1");
    const gave = vi.fn();
    function Page() {
      const q = useQuery({ queryKey: ["m"], queryFn: async () => { throw new Error("503"); }, retry: false });
      return <Ledger ready={!q.isLoading} loaded={ledgerLoaded(q)} ids={[]} onGiveUp={gave} />;
    }
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><Page /></QueryClientProvider>);
    await waitFor(() => expect(qc.getQueryState(["m"])?.status).toBe("error"));
    await new Promise((r) => setTimeout(r, GIVE_UP_MS + 200));
    expect(window.location.search).toBe("?card=c1&month=2026-10-01&tx=t1");
    expect(gave).not.toHaveBeenCalled();
  });
  it("(Q6b r3) ledgerLoaded: success, settled, current scope only", () => {
    const q = { isLoading: false, isSuccess: true, isPlaceholderData: false, isFetching: false };
    expect(ledgerLoaded(q)).toBe(true);
    expect(ledgerLoaded({ ...q, isSuccess: false })).toBe(false);
    expect(ledgerLoaded({ ...q, isPlaceholderData: true })).toBe(false);
    expect(ledgerLoaded({ ...q, isFetching: true })).toBe(false);
    expect(ledgerLoaded({ ...q, isLoading: true })).toBe(false);
  });
});

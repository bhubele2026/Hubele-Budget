import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRef } from "react";
import { useTxDeepLink } from "./useTxDeepLink";

// (F8) `?tx=` on a ledger: scroll to the row once it is on screen, prefer the
// visible tree, strip only `tx` from the URL, and stop the scroll-to-today.

function Ledger({ ready, ids }: { ready: boolean; ids: string[] }) {
  const scrolled = useRef(false);
  const focus = useTxDeepLink({ ready, rowTestIds: (id) => [`row-amex-${id}`, `row-amex-mobile-${id}`], scrolledRef: scrolled });
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
});

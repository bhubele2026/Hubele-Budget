import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * (WN) The mount is on the open path, so it must stay quiet: off in the test
 * suite unless `enabled` (App-level tests never meet a sheet or a request);
 * enabled, it loads the host only for a signed-in person on an app route, at
 * idle — or at once when "What's new" is pressed first.
 */

const h = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, userId: "user-a" as string | null },
  hostRenders: 0,
}));
vi.mock("@clerk/react", () => ({ useAuth: () => h.auth }));
vi.mock("./WhatsNewHost", () => ({
  default: ({ userId }: { userId: string }) => {
    h.hostRenders++;
    return <div data-testid="host-stub">{userId}</div>;
  },
}));

import { WhatsNewMount } from "./WhatsNewMount";
import { _resetWhatsNewSignalForTests, requestWhatsNewOpen } from "@/lib/whatsNewSignal";
import { _resetPerfMarksForTests, markReady } from "@/lib/perfMarks";
import { _resetSpeculativeForTests } from "@/lib/speculative";
import { HOME_MARKS } from "@/hooks/useLandingWarmup";

function mount(path: string, enabled?: boolean) {
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Router hook={hook}>
        <WhatsNewMount enabled={enabled} />
      </Router>
    </QueryClientProvider>,
  );
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  _resetPerfMarksForTests();
  _resetSpeculativeForTests();
  h.auth = { isLoaded: true, isSignedIn: true, userId: "user-a" };
  h.hostRenders = 0;
  _resetWhatsNewSignalForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WhatsNewMount", () => {
  it("renders nothing and loads nothing in the test suite unless enabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { container } = mount("/home");
      await flush(10_000);
      expect(container.innerHTML).toBe("");
      expect(h.hostRenders).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("enabled: loads the host once the page is quiet, for a signed-in person", async () => {
    mount("/banking", true);
    expect(screen.queryByTestId("host-stub")).toBeNull();
    await flush(3500);
    expect(screen.getByTestId("host-stub").textContent).toBe("user-a");
  });

  it("(perf phase 2) on Home: not before the real numbers are in", async () => {
    mount("/home", true);
    await flush(5000);
    expect(screen.queryByTestId("host-stub")).toBeNull();
    await act(async () => { for (const m of HOME_MARKS) markReady(m); });
    await flush(1000);
    expect(screen.getByTestId("host-stub").textContent).toBe("user-a");
  });

  it("(perf phase 2) on Home with marks that never come: it still greets, after the give-up", async () => {
    mount("/home", true);
    await flush(16_000);
    expect(screen.getByTestId("host-stub")).toBeTruthy();
  });

  it("enabled: never on the front door or the sign-in pages, nor signed out", async () => {
    for (const path of ["/", "/sign-in", "/sign-up/verify"]) {
      mount(path, true);
      await flush(5000);
      expect(screen.queryByTestId("host-stub"), path).toBeNull();
      cleanup();
    }
    h.auth = { isLoaded: true, isSignedIn: false, userId: null };
    mount("/home", true);
    await flush(5000);
    expect(screen.queryByTestId("host-stub")).toBeNull();
  });

  it("enabled: a press before the host loaded loads it at once", async () => {
    // The press does not wait for a quiet page.
    mount("/banking", true);
    act(() => requestWhatsNewOpen());
    await flush(10);
    expect(screen.getByTestId("host-stub")).toBeTruthy();
  });
});

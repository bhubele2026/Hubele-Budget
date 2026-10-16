import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

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

function mount(path: string, enabled?: boolean) {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <WhatsNewMount enabled={enabled} />
    </Router>,
  );
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
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

  it("enabled: loads the host at idle for a signed-in person", async () => {
    mount("/home", true);
    expect(screen.queryByTestId("host-stub")).toBeNull();
    await flush(3500);
    expect(screen.getByTestId("host-stub").textContent).toBe("user-a");
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
    // No idle callback in jsdom: the fallback is a 1.5 s timer. The press beats it.
    mount("/banking", true);
    act(() => requestWhatsNewOpen());
    await flush(10);
    expect(screen.getByTestId("host-stub")).toBeTruthy();
  });
});

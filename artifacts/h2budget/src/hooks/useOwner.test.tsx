import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ownerOf } from "./useOwner";

/**
 * (Q4) The owner gate has three answers. "Unknown" (the request is out) draws a
 * same-size placeholder: never the owner's controls, never the denial.
 */
describe("ownerOf", () => {
  it("true, false and unknown are three different answers", () => {
    expect(ownerOf({ data: { isOwner: true } })).toBe(true);
    expect(ownerOf({ data: { isOwner: false } })).toBe(false);
    expect(ownerOf({ data: undefined, isLoading: true })).toBe("unknown");
  });
  it("if /me itself failed, the controls show and the server decides", () => {
    expect(ownerOf({ data: undefined, isError: true })).toBe(true);
  });
});

const h = vi.hoisted(() => ({ me: undefined as unknown }));
vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({ data: h.me, isLoading: h.me === undefined, isError: false }),
  useCreateAllowancePlan: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react/features")>()),
  useCreateAllowancePlan: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PlanPrompt } from "@/pages/spending/PlanPrompt";
import { WaysBackBody } from "@/components/ways-back/WaysBackSheet";
import { useOwner } from "./useOwner";

afterEach(() => cleanup());
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("plan prompt: no denial while /me is out", () => {
  const mount = (owner: boolean | "unknown") =>
    render(
      <QueryClientProvider client={qc()}>
        <PlanPrompt view="week" start="2026-10-11" prefills={[]} canSet={owner} />
      </QueryClientProvider>,
    );

  it("unknown: a placeholder, not 'Only the household owner sets the weekly plan'", () => {
    mount("unknown");
    expect(screen.getByTestId("plan-prompt-owner-unknown")).toBeTruthy();
    expect(screen.queryByText(/Only the household owner/)).toBeNull();
  });
  it("false: the denial", () => {
    mount(false);
    expect(screen.getByTestId("plan-prompt-readonly").textContent).toContain("Only the household owner sets the weekly plan");
  });
  it("true: neither the denial nor the placeholder", () => {
    mount(true);
    expect(screen.queryByTestId("plan-prompt-readonly")).toBeNull();
    expect(screen.queryByTestId("plan-prompt-owner-unknown")).toBeNull();
  });
});

describe("ways back: no 'Ask the owner' while /me is out", () => {
  const ways = {
    overBy: 4000, weekEnd: "2026-10-17",
    hold: { leavesUntilPayday: null }, trims: [],
    carryOver: { applied: false, adjustment: null, nextWeekStart: "2026-10-18", nextWeekCap: 30000 },
  } as never;
  const mount = (owner: boolean | "unknown") =>
    render(<WaysBackBody ways={ways} owner={owner} ownerName="the owner" busy={false} error={null} onCarry={vi.fn()} onUndo={vi.fn()} />);

  it("unknown: a placeholder, neither button", () => {
    mount("unknown");
    expect(screen.getByTestId("carry-owner-unknown")).toBeTruthy();
    expect(screen.queryByTestId("carry-ask")).toBeNull();
    expect(screen.queryByTestId("carry-go")).toBeNull();
  });
  it("false: the ask; true: the action", () => {
    mount(false);
    expect(screen.getByTestId("carry-ask")).toBeTruthy();
    cleanup();
    mount(true);
    expect(screen.getByTestId("carry-go")).toBeTruthy();
  });
});

describe("useOwner reads the shared /me", () => {
  function Probe() {
    return <span data-testid="o">{String(useOwner())}</span>;
  }
  it("unknown while out, then the answer", () => {
    h.me = undefined;
    const { rerender } = render(<Probe />);
    expect(screen.getByTestId("o").textContent).toBe("unknown");
    h.me = { isOwner: false };
    rerender(<Probe />);
    expect(screen.getByTestId("o").textContent).toBe("false");
  });
});

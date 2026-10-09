import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiUsageSummary } from "@workspace/api-client-react/features";

// (F10) Settings › AI cost — ported from h2's `ask/askPages.test.tsx` "AI cost".

const mocks = vi.hoisted(() => ({ budget: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock("@workspace/api-client-react/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react/features")>();
  return { ...actual, useUpdateAiBudget: () => ({ mutate: mocks.budget, isPending: false }) };
});
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import { AiCostView, type AiCostData } from "./AiCostTab";

const NOW = new Date("2026-10-07T15:00:00Z");
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
  recentRuns: [
    {
      id: "r1",
      kind: "chat",
      trigger: "user",
      status: "succeeded",
      startedAt: "2026-10-07T14:20:00Z",
      finishedAt: null,
      summary: "2 tools, 1 proposal",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.04,
    },
  ],
} as AiUsageSummary;

const data = (usage: AiUsageSummary | undefined, owner: boolean | null = true, over: Partial<AiCostData["usage"]> = {}): AiCostData => ({
  usage: { data: usage, state: usage === undefined ? "cold" : "loaded", isFetching: false, refetch: vi.fn(), ...over },
  owner,
});
const mount = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  mocks.budget = vi.fn();
  toastMock.mockClear();
});
afterEach(cleanup);

describe("AI cost", () => {
  it("shows the server's numbers as sent: month, by task, counts, cache, caps, last runs", () => {
    mount(<AiCostView data={data(USAGE)} now={NOW} />);
    expect(screen.getByTestId("figure-ai-month").textContent).toBe("$1.84");
    expect(screen.getByTestId("ai-month").textContent).toContain("Spent so far in October 2026");
    const rows = screen.getAllByTestId("ai-task-row").map((r) => r.textContent);
    expect(rows).toEqual(["Ask$0.91241", "Filing charges$0.62581"]);
    expect(
      [screen.getByTestId("ai-calls"), screen.getByTestId("ai-failures"), screen.getByTestId("ai-blocked"), screen.getByTestId("ai-cache")].map(
        (e) => e.textContent,
      ),
    ).toEqual(["96", "3", "1", "72%"]);
    expect(screen.getByTestId("ai-cap-monthly").textContent).toContain("Within the cap");
    expect(screen.getByTestId("ai-cap-monthly").textContent).toContain("of $5.00");
    expect(screen.getByTestId("ai-cap-hard").textContent).toContain("of $10.00");
    expect(screen.getByTestId("ai-run").textContent).toContain("$0.04");
    expect(screen.getByTestId("ai-run").textContent).toContain("2 tools, 1 proposal");
    expect(screen.getByTestId("ai-run").textContent).toContain("Done");
  });

  it("a cap with no limit says none set; close to and over the cap say so", () => {
    mount(<AiCostView data={data({ ...USAGE, monthToDateUsd: 4.5, budget: { ...USAGE.budget, hardCapUsd: 0 } })} now={NOW} />);
    expect(screen.getByTestId("ai-cap-monthly").textContent).toContain("Close to the cap");
    expect(screen.getByTestId("ai-cap-hard").textContent).toBe("Hard stop: none set.");
    cleanup();
    mount(<AiCostView data={data({ ...USAGE, monthToDateUsd: 6 })} now={NOW} />);
    expect(screen.getByTestId("ai-cap-monthly").getAttribute("data-status")).toBe("over");
    expect(screen.getByTestId("ai-cap-monthly").textContent).toContain("Over the cap");
  });

  it("owner: cap edits go to PUT /ai/budget with only what changed; a bad amount sends nothing", async () => {
    mount(<AiCostView data={data(USAGE)} now={NOW} />);
    const save = screen.getByTestId("ai-caps-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("ai-monthly-input"), { target: { value: "$8" } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.budget).toHaveBeenCalledTimes(1));
    expect(mocks.budget.mock.calls[0]![0]).toEqual({ data: { monthlyCapUsd: 8 } });
    fireEvent.change(screen.getByTestId("ai-hard-input"), { target: { value: "lots" } });
    fireEvent.click(save);
    expect(mocks.budget).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "Use dollars, like 20 or 20.50.", variant: "destructive" });
  });

  it("a refusal shows the server's words", async () => {
    mocks.budget.mockImplementation((_v: unknown, o?: { onError?: (e: unknown) => void }) =>
      o?.onError?.({ status: 400, data: { error: "The hard limit cannot be lower than the monthly budget." } }),
    );
    mount(<AiCostView data={data(USAGE)} now={NOW} />);
    fireEvent.change(screen.getByTestId("ai-monthly-input"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("ai-caps-save"));
    expect(toastMock).toHaveBeenCalledWith({
      title: "The hard limit cannot be lower than the monthly budget.",
      variant: "destructive",
    });
  });

  it("owner: Pause needs a day and sends it; Resume clears it", async () => {
    const { unmount } = mount(<AiCostView data={data(USAGE)} now={NOW} />);
    fireEvent.click(screen.getByTestId("ai-pause"));
    expect(mocks.budget).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("ai-pause-date"), { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByTestId("ai-pause"));
    expect(mocks.budget).toHaveBeenCalledTimes(1);
    const sent = (mocks.budget.mock.calls[0]![0] as { data: { pausedUntil: string } }).data.pausedUntil;
    expect(new Date(sent).getTime()).toBe(new Date("2026-10-20T00:00:00").getTime());
    unmount();
    mount(
      <AiCostView data={data({ ...USAGE, budget: { ...USAGE.budget, pausedUntil: "2026-10-20T05:00:00Z" } })} now={NOW} />,
    );
    expect(screen.getByTestId("ai-pause-state").textContent).toContain("paused until Oct 20");
    fireEvent.click(screen.getByTestId("ai-resume"));
    expect(mocks.budget).toHaveBeenLastCalledWith({ data: { pausedUntil: null } }, expect.anything());
  });

  it("a member sees the numbers and no controls", () => {
    mount(<AiCostView data={data(USAGE, false)} now={NOW} />);
    expect(screen.getByTestId("figure-ai-month").textContent).toBe("$1.84");
    expect(screen.queryByTestId("ai-caps-form")).toBeNull();
    expect(screen.queryByTestId("ai-pause")).toBeNull();
    expect(screen.getByText("The household owner sets the caps.")).toBeTruthy();
  });

  it("cold shows a skeleton; a failed read says so with Try again", () => {
    const { unmount } = mount(<AiCostView data={data(undefined)} now={NOW} />);
    expect(screen.getByTestId("ai-cost-skeleton")).toBeTruthy();
    unmount();
    const refetch = vi.fn();
    mount(<AiCostView data={data(undefined, true, { state: "failed", refetch })} now={NOW} />);
    expect(screen.getByTestId("ai-cost-error").textContent).toContain("Couldn't load the AI cost.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("the tab's source does no arithmetic on a figure it was sent", () => {
    // Only reads, formats and compares: no + - * / % on a dollar amount.
    const src = readFileSync(join(import.meta.dirname, "AiCostTab.tsx"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.includes("import "))
      .join("\n");
    const code = src.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|<\/?[A-Za-z][^>]*>|\/>/g, "");
    expect(code).not.toMatch(
      /(usage|u|budget|t|r|c)\.(monthToDateUsd|costUsd|calls|failures|blocked|cacheHitRatio|monthlyCapUsd|hardCapUsd)\s*[-+*/%]/,
    );
    expect(code).not.toMatch(
      /[-+*/%]\s*(usage|u|budget|t|r|c)\.(monthToDateUsd|costUsd|calls|failures|blocked|cacheHitRatio|monthlyCapUsd|hardCapUsd)/,
    );
    expect(code).not.toMatch(/\.reduce\(|Math\.(round|floor|ceil|max|min)|\.toFixed\(/);
  });
});

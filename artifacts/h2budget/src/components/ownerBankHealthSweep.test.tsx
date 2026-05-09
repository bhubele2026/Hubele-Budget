import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

let meData: { isOwner: boolean } | undefined = undefined;
const runMutate = vi.fn();
let runIsPending = false;
let mutationOptionsRef: {
  onSuccess?: (data: unknown) => void;
  onError?: (err: unknown) => void;
} = {};
const toastSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@workspace/api-client-react", () => {
  return {
    useGetMe: () => ({ data: meData, isLoading: false }),
    useRunPlaidMalformedTokenSweep: (options?: {
      mutation?: {
        onSuccess?: (data: unknown) => void;
        onError?: (err: unknown) => void;
      };
    }) => {
      mutationOptionsRef = options?.mutation ?? {};
      return { mutate: runMutate, isPending: runIsPending };
    },
  };
});

import { OwnerBankHealthSweepSection } from "./owner-bank-health-sweep";

function renderSection() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <OwnerBankHealthSweepSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  meData = undefined;
  runIsPending = false;
  runMutate.mockReset();
  toastSpy.mockReset();
  mutationOptionsRef = {};
});

describe("OwnerBankHealthSweepSection", () => {
  it("renders nothing for non-owner users", () => {
    meData = { isOwner: false };
    const { container } = renderSection();
    expect(container.firstChild).toBeNull();
  });

  it("renders the trigger button for the owner and posts on click", () => {
    meData = { isOwner: true };
    renderSection();
    expect(screen.getByTestId("card-owner-bank-health-sweep")).toBeTruthy();
    const btn = screen.getByTestId("button-run-bank-health-sweep");
    fireEvent.click(btn);
    expect(runMutate).toHaveBeenCalledTimes(1);
  });

  it("renders the returned summary inline (counts, sample of flagged items, alert outcome)", () => {
    meData = { isOwner: true };
    renderSection();
    act(() => mutationOptionsRef.onSuccess?.({
      scanned: 7,
      flagged: 6,
      flaggedItems: [
        { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        { itemRowId: "r2", itemId: "ext-2", institutionName: "Wells Fargo" },
        { itemRowId: "r3", itemId: "ext-3", institutionName: "Amex" },
        { itemRowId: "r4", itemId: "ext-4", institutionName: "BofA" },
        { itemRowId: "r5", itemId: "ext-5", institutionName: "Citi" },
        { itemRowId: "r6", itemId: "ext-6", institutionName: "Discover" },
      ],
      alert: {
        channel: "email",
        reason: null,
        recipient: "ops@example.com",
        error: null,
      },
    }));
    expect(screen.getByTestId("text-sweep-scanned").textContent).toBe("7");
    expect(screen.getByTestId("text-sweep-flagged").textContent).toBe("6");
    expect(screen.getByTestId("row-sweep-flagged-r1")).toBeTruthy();
    expect(screen.getByTestId("row-sweep-flagged-r5")).toBeTruthy();
    expect(screen.queryByTestId("row-sweep-flagged-r6")).toBeNull();
    expect(screen.getByTestId("text-sweep-overflow").textContent).toContain(
      "1 more",
    );
    expect(screen.getByTestId("text-sweep-alert").textContent).toContain(
      "ops@example.com",
    );
  });

  it("describes a skipped (below-threshold) alert outcome", () => {
    meData = { isOwner: true };
    renderSection();
    act(() => mutationOptionsRef.onSuccess?.({
      scanned: 5,
      flagged: 0,
      flaggedItems: [],
      alert: {
        channel: "skipped",
        reason: "below-threshold",
        recipient: null,
        error: null,
      },
    }));
    expect(screen.getByTestId("text-sweep-no-flagged")).toBeTruthy();
    expect(screen.getByTestId("text-sweep-alert").textContent).toContain(
      "below-threshold",
    );
  });

  it("describes a null alert (evaluator threw) without hiding the counts", () => {
    meData = { isOwner: true };
    renderSection();
    act(() => mutationOptionsRef.onSuccess?.({
      scanned: 4,
      flagged: 1,
      flaggedItems: [
        { itemRowId: "r1", itemId: "ext-1", institutionName: null },
      ],
      alert: null,
    }));
    expect(screen.getByTestId("text-sweep-scanned").textContent).toBe("4");
    expect(screen.getByTestId("text-sweep-alert").textContent).toContain(
      "evaluator threw",
    );
    expect(screen.getByTestId("row-sweep-flagged-r1").textContent).toContain(
      "Unknown bank",
    );
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { ProbablyPaidStrip } from "./ProbablyPaidStrip";
import { statusBadge } from "./statusBadge";
import type { PlanLine } from "@/lib/forecastMatch";

// (One-time bill move) The Review strip for a `needs_review` pair: labelled
// "Match needs review", answered with the same Confirm (→ matched) and
// Not this (→ not_match) as a suggestion.

const plan = (needsReview: boolean): PlanLine => ({
  kind: "plan",
  date: "2026-10-20",
  itemId: "roof",
  label: "Roof repair",
  amount: -300,
  status: "future",
  matchedTxnId: null,
  probablyPaid: {
    txnId: "t1",
    planDate: "2026-10-20",
    txnAmount: -300,
    difference: 0,
    dayDelta: -31,
    confidence: "low",
    ambiguous: false,
    offCurve: false,
    txnDate: "2026-09-19",
    txnDescription: "ROOF CO",
    ...(needsReview ? { needsReview: true } : {}),
  },
});

afterEach(() => cleanup());

describe("needs-review strip", () => {
  it("reads 'Match needs review', still in forecast, no confidence; Confirm writes matched and Not this writes not_match", () => {
    const onAnswer = vi.fn();
    render(<ProbablyPaidStrip plan={plan(true)} txnId="t1" onAnswer={onAnswer} />);
    expect(screen.getByTestId("probably-paid-kind-t1").textContent).toBe("Match needs review");
    expect(screen.getByTestId("probably-paid-curve-t1").textContent).toBe("Still in forecast");
    expect(screen.queryByTestId("probably-paid-confidence-t1")).toBeNull();
    fireEvent.click(screen.getByTestId("probably-paid-confirm-t1"));
    expect(onAnswer).toHaveBeenLastCalledWith("matched");
    fireEvent.click(screen.getByTestId("probably-paid-reject-t1"));
    expect(onAnswer).toHaveBeenLastCalledWith("not_match");
    expect(screen.queryByTestId("probably-paid-partial-t1")).toBeNull();
  });

  it("a server suggestion still reads 'Suggested' with its confidence", () => {
    render(<ProbablyPaidStrip plan={plan(false)} txnId="t1" onAnswer={vi.fn()} />);
    expect(screen.getByTestId("probably-paid-kind-t1").textContent).toBe("Suggested");
    expect(screen.getByTestId("probably-paid-confidence-t1").textContent).toBe("low");
  });

  it("the plan row badge says it in words", () => {
    render(<>{statusBadge("needs_review")}</>);
    expect(screen.getByText("Match needs review")).toBeTruthy();
  });
});

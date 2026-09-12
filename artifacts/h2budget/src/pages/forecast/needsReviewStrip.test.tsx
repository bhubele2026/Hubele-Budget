import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { ProbablyPaidStrip } from "./ProbablyPaidStrip";
import { statusBadge } from "./statusBadge";
import type { PlanLine, ProbablyPaid } from "@/lib/forecastMatch";

// (One-time bill move) The Review strip for a pair that needs review. A match
// reads "Match needs review" (Confirm → matched, Not this → not_match). A
// partial reads "Partial payment needs review": Partial (keeps the remainder)
// is its primary answer, and "Confirm full" stays available but secondary.

// ⚠️ MERGE COUPLING: the only `ProbablyPaid` this file builds. A field added to
// `ProbablyPaid` (PR-B adds a required `tier`) is added here.
const plan = (needsReview: ProbablyPaid["needsReview"], txnAmount = -300): PlanLine => ({
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
    txnAmount,
    difference: Math.abs(txnAmount) - 300,
    dayDelta: -31,
    confidence: "low",
    ambiguous: false,
    offCurve: false,
    txnDate: "2026-09-19",
    txnDescription: "ROOF CO",
    ...(needsReview ? { needsReview } : {}),
  },
});

const answerButtons = () =>
  Array.from(screen.getByTestId("probably-paid-t1").querySelectorAll("button")).map((b) => b.textContent);

afterEach(() => cleanup());

describe("needs-review strip", () => {
  it("a match: 'Match needs review', still in forecast, no confidence; Confirm writes matched and Not this writes not_match", () => {
    const onAnswer = vi.fn();
    render(<ProbablyPaidStrip plan={plan("match")} txnId="t1" onAnswer={onAnswer} />);
    expect(screen.getByTestId("probably-paid-kind-t1").textContent).toBe("Match needs review");
    expect(screen.getByTestId("probably-paid-curve-t1").textContent).toBe("Still in forecast");
    expect(screen.queryByTestId("probably-paid-confidence-t1")).toBeNull();
    expect(answerButtons()).toEqual(["Confirm", "Not this"]);
    fireEvent.click(screen.getByTestId("probably-paid-confirm-t1"));
    expect(onAnswer).toHaveBeenLastCalledWith("matched");
    fireEvent.click(screen.getByTestId("probably-paid-reject-t1"));
    expect(onAnswer).toHaveBeenLastCalledWith("not_match");
  });

  it("a partial: Partial is the primary answer, 'Confirm full' is secondary, Not this stays", () => {
    const onAnswer = vi.fn();
    render(<ProbablyPaidStrip plan={plan("partial", -200)} txnId="t1" onAnswer={onAnswer} />);
    expect(screen.getByTestId("probably-paid-kind-t1").textContent).toBe("Partial payment needs review");
    expect(answerButtons()).toEqual(["Partial", "Confirm full", "Not this"]);
    const partial = screen.getByTestId("probably-paid-partial-t1");
    const confirm = screen.getByTestId("probably-paid-confirm-t1");
    expect(partial.className).not.toBe(confirm.className);
    fireEvent.click(partial);
    expect(onAnswer).toHaveBeenLastCalledWith("partial");
    fireEvent.click(confirm);
    expect(onAnswer).toHaveBeenLastCalledWith("matched");
  });

  it("a server suggestion still reads 'Suggested' with its confidence", () => {
    render(<ProbablyPaidStrip plan={plan(undefined)} txnId="t1" onAnswer={vi.fn()} />);
    expect(screen.getByTestId("probably-paid-kind-t1").textContent).toBe("Suggested");
    expect(screen.getByTestId("probably-paid-confidence-t1").textContent).toBe("low");
    expect(answerButtons()).toEqual(["Confirm", "Not this"]);
  });

  it("the plan row badges say it in words", () => {
    render(
      <>
        {statusBadge("needs_review")}
        {statusBadge("needs_review_partial")}
      </>,
    );
    expect(screen.getByText("Match needs review")).toBeTruthy();
    expect(screen.getByText("Partial payment needs review")).toBeTruthy();
  });
});

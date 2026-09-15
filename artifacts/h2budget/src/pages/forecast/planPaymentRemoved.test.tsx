import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { DndContext } from "@dnd-kit/core";
import { PlanDropRow } from "./PlanDropRow";
import type { PlanLine } from "@/lib/forecastMatch";

// (PR-I round 2, review HIGH-2) A bill the household matched to a payment the
// bank then removed is open again — on the curve and in Review. The row says
// why, in words.

const water = (paymentRemovedByBank?: boolean): PlanLine => ({
  kind: "plan",
  date: "2026-05-12",
  itemId: "rec-water",
  label: "City Water",
  amount: -150,
  status: "pending_plan",
  matchedTxnId: null,
  ...(paymentRemovedByBank ? { paymentRemovedByBank } : {}),
});

const show = (row: PlanLine) =>
  render(
    <DndContext>
      <PlanDropRow row={row} onSelect={vi.fn()} activeDragId={null} />
    </DndContext>,
  );

afterEach(() => cleanup());

describe("plan row: payment removed by the bank", () => {
  it("says so on the open bill", () => {
    show(water(true));
    expect(screen.getByTestId("plan-payment-removed-rec-water-2026-05-12").textContent).toBe(
      "Its payment was removed by the bank",
    );
  });

  it("says nothing on an ordinary open bill", () => {
    show(water());
    expect(screen.queryByTestId("plan-payment-removed-rec-water-2026-05-12")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { CAP_WORDS, TIGHT_AT, capOf, meterStatus, percent, taskWord, usd } from "./aiCostWords";

// (F10) Ported from h2's `ask/askPages.test.tsx` "AI cost" (`capOf`) and
// `kit/Meter.test.tsx` (`meterStatus`).

describe("AI cost words", () => {
  it("capOf reads a dollar box", () => {
    expect([capOf("$8"), capOf("12.50"), capOf("1,200"), capOf("x"), capOf(""), capOf("1.234")]).toEqual([
      8, 12.5, 1200, null, null, null,
    ]);
  });

  it.each([
    [0, 600, "on"],
    [509.99, 600, "on"],
    [600 * TIGHT_AT, 600, "tight"],
    [600, 600, "tight"],
    [600.01, 600, "over"],
    [900, 600, "over"],
  ] as const)("meterStatus %s of %s → %s", (spent, limit, status) => {
    expect(meterStatus(spent, limit)).toBe(status);
  });

  it("with no limit, any spending is over and none is within", () => {
    expect(meterStatus(0, 0)).toBe("on");
    expect(meterStatus(5, 0)).toBe("over");
  });

  it("words: tasks, cap states, dollars and cents, percent", () => {
    expect(taskWord("chat")).toBe("Ask");
    expect(taskWord("categorize")).toBe("Filing charges");
    expect(taskWord("new_task-kind")).toBe("new task kind");
    expect(CAP_WORDS).toEqual({ on: "Within the cap", tight: "Close to the cap", over: "Over the cap" });
    expect(usd(1.84)).toBe("$1.84");
    expect(usd(0.04)).toBe("$0.04");
    expect(percent(0.72)).toBe("72%");
  });
});

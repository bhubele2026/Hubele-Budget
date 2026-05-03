import { describe, it, expect } from "vitest";
import { computeRunningBalances } from "./runningBalance";

describe("computeRunningBalances", () => {
  it("anchors the newest row to the snapshot balance", () => {
    const rows = [
      { id: "a", occurredOn: "2026-05-03", amount: "-25.00" },
      { id: "b", occurredOn: "2026-05-01", amount: "-100.00" },
      { id: "c", occurredOn: "2026-04-29", amount: "1500.00" },
    ];
    const m = computeRunningBalances(rows, 1375);
    expect(m.get("a")).toBe(1375);
    expect(m.get("b")).toBe(1400);
    expect(m.get("c")).toBe(1500);
  });

  it("handles numeric amounts and rounds to cents", () => {
    const rows = [
      { id: "a", occurredOn: "2026-05-03", amount: -12.34 },
      { id: "b", occurredOn: "2026-05-02", amount: -7.66 },
    ];
    const m = computeRunningBalances(rows, 100);
    expect(m.get("a")).toBe(100);
    expect(m.get("b")).toBe(112.34);
  });

  it("returns empty map for empty input", () => {
    expect(computeRunningBalances([], 500).size).toBe(0);
  });

  it("treats invalid amounts as zero", () => {
    const rows = [
      { id: "a", occurredOn: "2026-05-03", amount: "not-a-number" },
      { id: "b", occurredOn: "2026-05-02", amount: "-10.00" },
    ];
    const m = computeRunningBalances(rows, 200);
    expect(m.get("a")).toBe(200);
    expect(m.get("b")).toBe(200);
  });
});

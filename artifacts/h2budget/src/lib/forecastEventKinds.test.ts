import { describe, it, expect } from "vitest";
import {
  classifyEvent, kindEvents, groupMarkers, runsBelow, daySummary, stepDate,
} from "./forecastEventKinds";

const links = new Map([["car", "debt1"]]);
const ev = (date: string, label: string, amount: string, itemId?: string, originalDate?: string) =>
  ({ date, label, amount, itemId, originalDate });

describe("forecastEventKinds", () => {
  it("classifies by sign, card words and debt links", () => {
    expect(classifyEvent({ label: "Pay", amount: 10 }, links)).toBe("payday");
    expect(classifyEvent({ label: "Amex payment", amount: -10, itemId: "car" }, links)).toBe("card");
    expect(classifyEvent({ label: "Car loan", amount: -10, itemId: "car" }, links)).toBe("debt");
    expect(classifyEvent({ label: "Water", amount: -10, itemId: "w" }, links)).toBe("bill");
  });

  it("groups a crowded day into one marker with a count and the largest kind", () => {
    const k = kindEvents([ev("d1", "Water", "-20", "w"), ev("d1", "Car loan", "-300", "car"), ev("d2", "Pay", "900", "p")], links);
    const g = groupMarkers(k, new Map([["d1", 100], ["d2", 1000]]));
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ date: "d1", count: 2, kind: "debt", balance: 100 });
    expect(g[0].events.map((e) => e.label)).toEqual(["Car loan", "Water"]);
  });

  it("finds runs under a limit and widens a one-day dip", () => {
    const s = ["a", "b", "c", "d", "e"].map((rawDate, i) => ({ rawDate, balance: [900, 400, 900, -5, -5][i] }));
    expect(runsBelow(s, 500)).toEqual([{ x1: "a", x2: "c" }, { x1: "d", x2: "e" }]);
    expect(runsBelow(s, 0)).toEqual([{ x1: "d", x2: "e" }]);
  });

  it("summarises a day from the series and events without inventing numbers", () => {
    const s = [{ rawDate: "d1", balance: 1000 }, { rawDate: "d2", balance: 400 }];
    const k = kindEvents([ev("d2", "Rent", "-600", "r", "d0"), ev("d2", "Pay", "50", "p")], links);
    const d = daySummary("d2", s, k);
    expect(d).toMatchObject({ opening: 1000, close: 400, income: 50, inWindow: true, carriedForwardCount: 1, scheduledCount: 1 });
    expect(d.outflows.bill).toBe(-600);
    expect(daySummary("zz", s, k)).toMatchObject({ inWindow: false, close: null, opening: null });
  });

  it("steps days and clamps at the ends", () => {
    const s = [{ rawDate: "a" }, { rawDate: "b" }];
    expect(stepDate(s, null, 1)).toBe("a");
    expect(stepDate(s, null, -1)).toBe("b");
    expect(stepDate(s, "b", 1)).toBe("b");
    expect(stepDate(s, "b", -1)).toBe("a");
  });
});

import { describe, it, expect } from "vitest";
import {
  classifyEvent, kindEvents, kindDayItems, groupMarkers, runsBelow, daySummary, stepDate,
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

  // ⭐ (T3) dayItems: every item the walk applied — paydays and counted bank rows included.
  it("kinds dayItems: income is a payday, a bank row is bank activity (labelled from the bundle), a zero plan moves nothing", () => {
    const { kinded, bank } = kindDayItems(
      [
        { date: "d1", kind: "income", amount: "2000.00", label: "Paycheck", itemId: "p", occurrenceDate: "d1", originalDate: "d1" },
        { date: "d1", kind: "expense", amount: "-50.00", label: "Car loan", itemId: "car", occurrenceDate: "d0", originalDate: "d0" },
        { date: "d1", kind: "expense", amount: "0.00", label: "Nothing", itemId: "z" },
        { date: "d1", kind: "bank_row", amount: "-12.34", txnId: "t1", matched: true },
        { date: "d1", kind: "bank_row", amount: "40.00", txnId: "t2", matched: false },
      ],
      links,
      (id) => (id === "t1" ? "Corner shop" : null),
    );
    expect(kinded.map((e) => [e.label, e.kind, e.amount, e.dragged, e.occurrenceDate])).toEqual([
      ["Paycheck", "payday", 2000, false, "d1"],
      ["Car loan", "debt", -50, true, "d0"],
    ]);
    expect(bank).toEqual([
      { date: "d1", amount: -12.34, label: "Corner shop", txnId: "t1", matched: true },
      { date: "d1", amount: 40, label: "Bank activity", txnId: "t2", matched: false },
    ]);
  });

  it("a day opens on the previous close (the curve's start on day one) and opening + in − out = close", () => {
    // start 1000 → d1: +2000 pay, −600 rent, −12.34 shop, +40 refund = 2427.66 → d2: −27.66 = 2400
    const s = [{ rawDate: "d1", balance: 2427.66 }, { rawDate: "d2", balance: 2400 }];
    const { kinded, bank } = kindDayItems(
      [
        { date: "d1", kind: "income", amount: "2000.00", label: "Pay", itemId: "p" },
        { date: "d1", kind: "expense", amount: "-600.00", label: "Rent", itemId: "r" },
        { date: "d1", kind: "bank_row", amount: "-12.34", txnId: "t1" },
        { date: "d1", kind: "bank_row", amount: "40.00", txnId: "t2" },
        { date: "d2", kind: "bank_row", amount: "-27.66", txnId: "t3" },
      ],
      links,
    );
    const cents = (n: number | null) => Math.round((n ?? NaN) * 100);
    for (const date of ["d1", "d2"]) {
      const d = daySummary(date, s, kinded, { bank, startingBalance: 1000 });
      const moved = d.income + d.bankIn + d.outflows.bill + d.outflows.card + d.outflows.debt + d.bankOut;
      expect(cents(d.opening) + cents(moved)).toBe(cents(d.close));
    }
    const d1 = daySummary("d1", s, kinded, { bank, startingBalance: 1000 });
    expect(d1).toMatchObject({ opening: 1000, income: 2000, bankIn: 40, bankOut: -12.34, close: 2427.66 });
    expect(d1.bankRows.map((b) => b.txnId)).toEqual(["t1", "t2"]);
    // Without a start, day one still opens on "—" (null), as before.
    expect(daySummary("d1", s, kinded).opening).toBeNull();
  });

  it("steps days and clamps at the ends", () => {
    const s = [{ rawDate: "a" }, { rawDate: "b" }];
    expect(stepDate(s, null, 1)).toBe("a");
    expect(stepDate(s, null, -1)).toBe("b");
    expect(stepDate(s, "b", 1)).toBe("b");
    expect(stepDate(s, "b", -1)).toBe("a");
  });
});

describe("(Readable forecast) the avalanche payment, short names, in / out, the next days", () => {
  it("the weekly avalanche extra is a debt payment, even when the debt it pays is a card", async () => {
    const { classifyEvent: classify, shortEventLabel, AVALANCHE_EXTRA_ID } = await import("./forecastEventKinds");
    expect(classify({ label: "Avalanche payment → Maple Card", amount: -620, itemId: AVALANCHE_EXTRA_ID }, new Map())).toBe("debt");
    expect(classify({ label: "Avalanche payment → Harbor Auto Loan", amount: -620, itemId: "avalanche:extra" }, new Map())).toBe("debt");
    // Anything else keeps its kind.
    expect(classify({ label: "Maple card payment", amount: -40, itemId: "m" }, new Map())).toBe("card");
    expect(shortEventLabel({ label: "Avalanche payment → Maple Card", itemId: "avalanche:extra" })).toBe("Avalanche → Maple Card");
    expect(shortEventLabel({ label: "Rent", itemId: "rent" })).toBe("Rent");
  });

  it("in / out by day group exactly as the day panel does", async () => {
    const { inOutByDate, kindDayItems: kdi, daySummary: ds } = await import("./forecastEventKinds");
    const { kinded, bank } = kdi(
      [
        { date: "d1", kind: "income", amount: "900.00", label: "Pay", itemId: "p" },
        { date: "d1", kind: "expense", amount: "-120.00", label: "Water", itemId: "w" },
        { date: "d1", kind: "expense", amount: "-300.00", label: "Avalanche payment → Maple Card", itemId: "avalanche:extra" },
        { date: "d1", kind: "bank_row", amount: "-6.50", txnId: "t1" },
        { date: "d1", kind: "bank_row", amount: "20.00", txnId: "t2" },
      ],
      new Map(),
    );
    const t = inOutByDate(kinded, bank).get("d1")!;
    const sum = ds("d1", [{ rawDate: "d1", balance: 1493.5 }], kinded, { bank, startingBalance: 1000 });
    expect(t.moneyIn).toBe(sum.income + sum.bankIn);
    expect(t.moneyOut).toBe(sum.outflows.bill + sum.outflows.card + sum.outflows.debt + sum.bankOut);
    expect(sum.outflows.debt).toBe(-300);
    expect(sum.opening! + t.moneyIn + t.moneyOut).toBeCloseTo(sum.close!, 9);
  });

  it("upcomingDays: today always, then only days that move, inside the window", async () => {
    const { upcomingDays, kindDayItems: kdi } = await import("./forecastEventKinds");
    const series = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-24", "2026-11-25"].map((rawDate, i) => ({
      rawDate,
      balance: [1000, 1000, 400, 300, 2000][i],
    }));
    const { kinded, bank } = kdi(
      [
        { date: "2026-11-12", kind: "expense", amount: "-600.00", label: "Rent", itemId: "r" },
        { date: "2026-11-24", kind: "expense", amount: "-100.00", label: "Phone", itemId: "ph" },
        { date: "2026-11-25", kind: "income", amount: "1700.00", label: "Pay", itemId: "p" },
      ],
      new Map(),
    );
    const rows = upcomingDays(series, kinded, bank, { today: "2026-11-10", days: 14, buffer: 500, lowestDate: "2026-11-24" });
    expect(rows.map((r) => r.date)).toEqual(["2026-11-10", "2026-11-12"]);
    expect(rows[0]).toMatchObject({ isToday: true, moneyIn: 0, moneyOut: 0, close: 1000 });
    expect(rows[1]).toMatchObject({ outNames: ["Rent"], underBuffer: true, belowZero: false, lowest: true });
    const wide = upcomingDays(series, kinded, bank, { today: "2026-11-10", days: 30, buffer: 500, lowestDate: "2026-11-24" });
    expect(wide.map((r) => r.date)).toEqual(["2026-11-10", "2026-11-12", "2026-11-24", "2026-11-25"]);
    // The cash signal's own low day is the one flagged.
    expect(wide.filter((r) => r.lowest).map((r) => r.date)).toEqual(["2026-11-24"]);
  });
});

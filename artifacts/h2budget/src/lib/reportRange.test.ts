import { describe, it, expect } from "vitest";
import { lastDaysSpan, parseDay, searchWithMode, spanFromSearch, spanLabel, spanQuery } from "./reportRange";

// Fri 2026-10-16, noon local: the presets are today back the mode's days (the pages' own window).
const NOW = new Date(2026, 9, 16, 12, 0, 0);

describe("(R) report range as address state", () => {
  it("no params: the week preset, the pages' own window (today back 7 days)", () => {
    expect(spanFromSearch("", NOW)).toEqual({ mode: "wk", from: "2026-10-09", to: "2026-10-16", days: 7 });
  });

  it("?mode=mo and ?mode=yr are presets; junk falls back to the week", () => {
    expect(spanFromSearch("?mode=mo", NOW).mode).toBe("mo");
    expect(spanFromSearch("?mode=yr", NOW).mode).toBe("yr");
    expect(spanFromSearch("?mode=quarter", NOW).mode).toBe("wk");
  });

  it("?from&to is a custom span: no preset lit, the days between", () => {
    expect(spanFromSearch("?from=2026-09-16&to=2026-10-16", NOW)).toEqual({ mode: null, from: "2026-09-16", to: "2026-10-16", days: 30 });
  });

  it("a custom span wins over ?mode", () => {
    expect(spanFromSearch("?mode=yr&from=2026-09-16&to=2026-10-16", NOW).mode).toBeNull();
  });

  it("a half, an impossible date or a reversed span is not a span", () => {
    expect(spanFromSearch("?from=2026-09-16", NOW).mode).toBe("wk");
    expect(spanFromSearch("?from=2026-02-31&to=2026-03-10", NOW).mode).toBe("wk");
    expect(spanFromSearch("?from=2026-10-16&to=2026-09-16", NOW).mode).toBe("wk");
    expect(parseDay("2026-13-01")).toBeNull();
  });

  it("a preset drops the custom span and keeps every other param; the week is not written", () => {
    expect(searchWithMode("?from=2026-09-16&to=2026-10-16&tx=abc", "mo")).toBe("?tx=abc&mode=mo");
    expect(searchWithMode("?mode=mo&from=2026-09-16&to=2026-10-16", "wk")).toBe("");
  });

  it("the hub's 30 days is today back 30, and its query reads back to the same span", () => {
    const s = lastDaysSpan(30, NOW);
    expect(s).toEqual({ from: "2026-09-16", to: "2026-10-16" });
    const read = spanFromSearch(spanQuery(s.from, s.to), NOW);
    expect([read.from, read.to, read.days]).toEqual(["2026-09-16", "2026-10-16", 30]);
  });

  it("the label reads 'Sep 16 – Oct 16' (year only when it leaves this one)", () => {
    const y = new Date().getFullYear();
    expect(spanLabel(`${y}-09-16`, `${y}-10-16`)).toBe("Sep 16 – Oct 16");
    expect(spanLabel("2020-12-20", "2021-01-19")).toBe("Dec 20, 2020 – Jan 19, 2021");
  });
});

import { describe, it, expect } from "vitest";
import { agoShort, dayOf, freshnessStamps } from "./accountFreshness";
import { NOT_TRACKED, snapshotCaption, snapshotLine } from "./snapshotWords";

const NOW = Date.parse("2026-10-09T15:00:00Z"); // 10:00 CT

describe("account freshness: three stamps, three moments (WP3)", () => {
  it("names each stamp; 'data through' is a data date", () => {
    expect(freshnessStamps({
      syncedAt: "2026-10-09T13:00:00Z",
      balanceAt: "2026-10-09T09:30:00Z",
      dataThrough: "2026-10-07",
    }, NOW)).toEqual(["synced 2 h ago", "balance read 5 h ago", "data through Oct 7"]);
  });
  it("leaves out what is not known, never a placeholder", () => {
    expect(freshnessStamps({ syncedAt: null, balanceAt: undefined, dataThrough: null }, NOW)).toEqual([]);
    expect(freshnessStamps({ dataThrough: "2026-10-07" }, NOW)).toEqual(["data through Oct 7"]);
    expect(freshnessStamps({ syncedAt: "not a date" }, NOW)).toEqual([]);
  });
  it("short relative times, clamped at 'just now'", () => {
    expect(agoShort("2026-10-09T14:59:40Z", NOW)).toBe("just now");
    expect(agoShort("2026-10-09T15:05:00Z", NOW)).toBe("just now"); // clock skew
    expect(agoShort("2026-10-09T14:15:00Z", NOW)).toBe("45 min ago");
    expect(agoShort("2026-10-06T15:00:00Z", NOW)).toBe("3 d ago");
  });
  it("days read on the household calendar; a bare date is already a day", () => {
    expect(dayOf("2026-10-07")).toBe("Oct 7");
    expect(dayOf("2026-10-08T03:00:00Z")).toBe("Oct 7"); // still Oct 7 in Chicago
    expect(dayOf(null)).toBeNull();
  });
});

describe("the snapshot rule (WP3)", () => {
  it("a reading says its day and that it is not rolled forward", () => {
    const s = { balance: "3100", at: "2026-10-06T14:00:00Z" };
    expect(snapshotCaption(s)).toBe("as of Oct 6 · not rolled forward");
    expect(snapshotLine(s)).toBe("Snapshot $3,100.00 · as of Oct 6 · not rolled forward");
  });
  it("a real zero reading is $0.00", () => {
    expect(snapshotLine({ balance: "0.00", at: "2026-10-06T14:00:00Z" })).toBe("Snapshot $0.00 · as of Oct 6 · not rolled forward");
  });
  it("no reading is words", () => {
    expect(NOT_TRACKED.savings).toBe("Savings balance is not tracked yet.");
  });
});

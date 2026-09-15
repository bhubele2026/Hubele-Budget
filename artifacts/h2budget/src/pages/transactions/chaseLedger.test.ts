import { describe, expect, it } from "vitest";
import type { LedgerPage, LedgerRow } from "@workspace/api-client-react";
import {
  BALANCE_DATES_MAX,
  LEDGER_PAGE_SIZE,
  balanceDates,
  countedAmount,
  sumCounted,
  flattenLedgerPages,
  ledgerRowLabels,
  moneyOrNull,
  sampleDays,
  splitAtToday,
  toBulkFilter,
  toLedgerParams,
} from "./chaseLedger";

/** (PR14) The pure half of the Chase inbox: filters, the today split, paging. */

describe("splitAtToday", () => {
  it("a range already past: the whole range is the register, nothing after today", () => {
    expect(splitAtToday({ from: "2026-08-01", to: "2026-08-31" }, "2026-09-16")).toEqual({
      register: { from: "2026-08-01", to: "2026-08-31" },
      after: null,
    });
  });

  it("a range reaching past today: the register stops at today and the rest is asked for apart", () => {
    expect(splitAtToday({ from: "2026-09-13", to: "2026-09-19" }, "2026-09-16")).toEqual({
      register: { from: "2026-09-13", to: "2026-09-16" },
      after: { from: "2026-09-17", to: "2026-09-19" },
    });
  });

  it("a range ending today has nothing after it", () => {
    expect(splitAtToday({ from: "2026-09-01", to: "2026-09-16" }, "2026-09-16").after).toBeNull();
  });

  it("a range wholly after today has no register at all", () => {
    expect(splitAtToday({ from: "2026-10-01", to: "2026-10-31" }, "2026-09-16")).toEqual({
      register: null,
      after: { from: "2026-10-01", to: "2026-10-31" },
    });
  });

  it("crosses a month and a year end", () => {
    expect(splitAtToday({ from: "2026-12-27", to: "2027-01-02" }, "2026-12-31").after).toEqual({
      from: "2027-01-01",
      to: "2027-01-02",
    });
  });
});

describe("the list's query and the bulk filter are one filter", () => {
  const filter = {
    account: "acct-1",
    from: "2026-09-13",
    to: "2026-09-16",
    reviewed: false,
    uncategorized: true,
  };

  it("the list asks with strings and a page of 50", () => {
    expect(toLedgerParams(filter)).toEqual({
      limit: LEDGER_PAGE_SIZE,
      account: "acct-1",
      from: "2026-09-13",
      to: "2026-09-16",
      reviewed: "false",
      uncategorized: "true",
    });
    expect(LEDGER_PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  it("bulk review sends the same keys as booleans, with no limit and nothing unset", () => {
    expect(toBulkFilter(filter)).toEqual({
      account: "acct-1",
      from: "2026-09-13",
      to: "2026-09-16",
      reviewed: false,
      uncategorized: true,
    });
    expect(toBulkFilter({ from: "2026-09-13" })).toEqual({ from: "2026-09-13" });
  });

  it("every key the list sends (but the page size) is in the bulk filter", () => {
    const f = { ...filter, pending: true, categoryId: "cat-1", uncategorized: false };
    const listKeys = Object.keys(toLedgerParams(f)).filter((k) => k !== "limit").sort();
    expect(Object.keys(toBulkFilter(f)).sort()).toEqual(listKeys);
  });
});

describe("flattenLedgerPages", () => {
  const row = (id: string) => ({ id }) as LedgerRow;
  const page = (ids: string[]) => ({ rows: ids.map(row) }) as LedgerPage;

  it("keeps the server's order across pages", () => {
    expect(flattenLedgerPages([page(["a", "b"]), page(["c"])]).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("lists a row the cursor hands back twice once", () => {
    expect(flattenLedgerPages([page(["a", "b"]), page(["b", "c"])]).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("no pages is no rows", () => {
    expect(flattenLedgerPages(undefined)).toEqual([]);
  });
});

describe("moneyOrNull never invents a zero", () => {
  it("missing or unreadable money is null", () => {
    expect(moneyOrNull(null)).toBeNull();
    expect(moneyOrNull(undefined)).toBeNull();
    expect(moneyOrNull("")).toBeNull();
    expect(moneyOrNull("abc")).toBeNull();
  });
  it("a real zero stays zero", () => {
    expect(moneyOrNull("0.00")).toBe(0);
    expect(moneyOrNull("-12.34")).toBe(-12.34);
  });
});

describe("balance dates", () => {
  it("samples a year to at most 40 days and keeps both ends", () => {
    const days = sampleDays("2026-01-01", "2026-12-31");
    expect(days.length).toBeLessThanOrEqual(41);
    expect(days[0]).toBe("2026-01-01");
    expect(days[days.length - 1]).toBe("2026-12-31");
  });
  it("a week is every day", () => {
    expect(sampleDays("2026-09-13", "2026-09-16")).toEqual([
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
  });
  it("one request: sorted, unique, and never over the server's 120", () => {
    expect(balanceDates(["2026-09-05", "2026-09-12"], ["2026-09-12", "2026-09-01"])).toEqual([
      "2026-09-01",
      "2026-09-05",
      "2026-09-12",
    ]);
    const many = Array.from({ length: 200 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
    const capped = balanceDates(many);
    expect(capped.length).toBeLessThanOrEqual(BALANCE_DATES_MAX);
  });
});

describe("ledgerRowLabels: the words carry the state", () => {
  const base = {
    afterToday: false,
    heldAhead: false,
    stalePending: false,
    countsInBalance: true,
    balanceReason: "counted",
  };
  it("an ordinary row has none", () => {
    expect(ledgerRowLabels(base)).toEqual([]);
  });
  it("names each special row", () => {
    // (PR-I) Renamed from "Pending 14+ days" to the owner's wording; same row, same single label.
    expect(ledgerRowLabels({ ...base, stalePending: true }).map((l) => l.label)).toEqual(["Pending unusually long"]);
    expect(ledgerRowLabels({ ...base, heldAhead: true }).map((l) => l.label)).toEqual(["Already in balance"]);
    expect(ledgerRowLabels({ ...base, afterToday: true }).map((l) => l.label)).toEqual(["After today"]);
    const twin = ledgerRowLabels({ ...base, countsInBalance: false, balanceReason: "superseded" });
    expect(twin.map((l) => l.label)).toEqual(["Not counted"]);
    expect(twin[0]!.title).toBe("Replaced by its posted row.");
  });
});

describe("(PR14 review M1) counted amounts", () => {
  it("a counted row adds its balance amount; a twin, duplicate or replaced row adds 0", () => {
    expect(countedAmount({ amount: "-82.92", countsInBalance: true, balanceAmount: "-82.92" })).toBe(-82.92);
    expect(countedAmount({ amount: "-63.21", countsInBalance: false, balanceAmount: "0.00" })).toBe(0);
  });
  it("on an account with no register (balanceAmount null), countsInBalance decides", () => {
    expect(countedAmount({ amount: "-30.00", countsInBalance: true, balanceAmount: null })).toBe(-30);
    expect(countedAmount({ amount: "-30.00", countsInBalance: false, balanceAmount: null })).toBe(0);
  });
  it("sums in whole cents", () => {
    const row = (a: string) => ({ amount: a, countsInBalance: true, balanceAmount: a });
    expect(sumCounted([row("0.10"), row("0.20")])).toBe(0.3);
    expect(sumCounted([row("-82.92"), { amount: "-63.21", countsInBalance: false, balanceAmount: "0.00" }])).toBe(-82.92);
  });
});

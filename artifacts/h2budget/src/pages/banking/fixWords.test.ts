import { describe, it, expect } from "vitest";
import { figureChanges, limitationWords, refusalCode, refusalWords, rowChangeWords } from "./fixWords";

/** (Q5) The correction workflow's words. Synthetic. */
const period = (o: Record<string, string | null> = {}) => ({ start: "2026-10-11", end: "2026-10-17", plan: "300.00", actual: "100.00", known: "100.00", unresolved: "0.00", remaining: "200.00", over: null, ...o });
const buckets = (o: Record<string, [number, string, string]> = {}) =>
  Object.fromEntries(["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"].map((k) => {
    const [count, inn, out] = o[k] ?? [0, "0.00", "0.00"];
    return [k, { count, moneyIn: inn, moneyOut: out, net: "0.00" }];
  }));
const banking = (b: Record<string, [number, string, string]>, a: Record<string, [number, string, string]>, inbox: [number, number] = [0, 0]) => ({
  account: { id: "x", institution: "Chase", name: "Checking", mask: "4321" }, from: "2026-10-01", to: "2026-10-14",
  before: { buckets: buckets(b), asPlanned: { count: 0, net: "0.00" }, unresolvedInRange: inbox[0] },
  after: { buckets: buckets(a), asPlanned: { count: 0, net: "0.00" }, unresolvedInRange: inbox[1] },
});
const preview = (figures: Record<string, unknown>) => ({ figures: { week: { before: period(), after: period() }, month: { before: period(), after: period() }, budgetMonths: [], banking: [], ...figures } }) as never;

describe("figureChanges", () => {
  it("lists only the totals whose before and after differ, with the glossary's names", () => {
    const c = figureChanges(preview({ week: { before: period({ unresolved: "40.00", actual: "140.00" }), after: period({ unresolved: "0.00", actual: "100.00" }) } }));
    expect(c.map((x) => `${x.scope}|${x.label}|${x.before}→${x.after}`)).toEqual([
      "This week|Unconfirmed|$40.00→$0.00",
      "This week|Cautious total (includes unconfirmed)|$140.00→$100.00",
    ]);
  });
  it("nothing moves: nothing listed (a value compared as cents, not as text)", () => {
    expect(figureChanges(preview({ week: { before: period({ known: "100.0" }), after: period({ known: "100.00" }) } }))).toEqual([]);
  });
  it("over is said as Over when either side is over, else as Left", () => {
    const over = figureChanges(preview({ month: { before: period({ remaining: "-40.00", over: "40.00" }), after: period({ remaining: "10.00", over: null }) } }));
    expect(over.map((x) => `${x.label}|${x.before}→${x.after}`)).toEqual(["Over|$40.00→—"]);
    const left = figureChanges(preview({ month: { before: period({ remaining: "200.00" }), after: period({ remaining: "220.00" }) } }));
    expect(left.map((x) => `${x.label}|${x.before}→${x.after}`)).toEqual(["Left|$200.00→$220.00"]);
  });
  it("Budget month lines that move, and its income / expenses / net", () => {
    const m = (inc: string, exp: string, lineAmt: string) => ({ income: inc, expenses: exp, net: "0.00", lines: [{ categoryId: "c1", name: "HELOC", kind: "expense", actual: lineAmt }] });
    const c = figureChanges(preview({ budgetMonths: [{ monthStart: "2026-10-01", before: m("2500.00", "100.00", "0.00"), after: m("2500.00", "1250.40", "1150.40") }] }));
    expect(c.map((x) => `${x.scope}|${x.label}|${x.before}→${x.after}`)).toEqual([
      "October budget|Expenses|$100.00→$1,250.40",
      "October budget|HELOC|$0.00→$1,150.40",
    ]);
  });
  it("Banking: buckets by their direction-aware titles, rows before → after, and what is left to review; the scope names the dates the dry run read", () => {
    const c = figureChanges(preview({ banking: [banking({ unmatched: [2, "0.00", "40.00"], timingDifference: [1, "0.00", "5.00"] }, { unmatched: [0, "0.00", "0.00"], timingDifference: [1, "0.00", "5.00"] }, [3, 1])] }), "2026-10-15");
    expect(c.map((x) => `${x.scope}|${x.label}|${x.before}→${x.after}`)).toEqual([
      "Banking · Chase Checking ••4321 · Oct 1 – Oct 14|Unplanned activity|2 rows→0 rows",
      "Banking · Chase Checking ••4321 · Oct 1 – Oct 14|Charges to match|3→1",
    ]);
  });
  it("a one-day range is said as one day", () => {
    const b = { ...banking({ unmatched: [1, "0.00", "9.00"] }, { unmatched: [0, "0.00", "0.00"] }), from: "2026-10-12", to: "2026-10-12" };
    expect(figureChanges(preview({ banking: [b] }), "2026-10-15")[0]!.scope).toBe("Banking · Chase Checking ••4321 · Oct 12");
  });
  it("a Banking answer with no 'after' is not guessed", () => {
    const b = banking({}, {});
    expect(figureChanges(preview({ banking: [{ ...b, after: null }] }))).toEqual([]);
  });
});

describe("rowChangeWords", () => {
  const state = (o: Record<string, unknown> = {}) => ({ categoryId: "c-din", isTransfer: false, weeklyAllowance: true, monthlyAllowance: false, ...o });
  const proposal = { rows: [{ id: "r1", category: { id: "c-din", name: "Dining" } }], action: { target: { label: "HELOC", categoryName: "Home loan" } } } as never;
  it("filed under, transfer, allowance flags and the matched bill — only what changes", () => {
    const row = { id: "r1", before: state(), after: state({ categoryId: "c-loan", isTransfer: true, weeklyAllowance: false }), resolution: { recurringItemId: "b", occurrenceDate: "2026-10-12", status: "matched" }, resolutionSkipped: null } as never;
    expect(rowChangeWords(row, proposal)).toEqual(["Filed under Home loan (was Dining)", "Counted as a transfer", "Leaves the weekly plan", "Matched to HELOC on Oct 12"]);
    const same = { id: "r1", before: state(), after: state(), resolution: null, resolutionSkipped: "occurrence_shared" } as never;
    expect(rowChangeWords(same, proposal)).toEqual(["Another row answers this bill"]);
  });
});

describe("limitations and refusals", () => {
  it("one plain line, nothing when none remain", () => {
    expect(limitationWords([])).toBeNull();
    expect(limitationWords(["listed_rows_only"])).toBe("Only the rows listed are changed.");
    expect(limitationWords(["listed_rows_only", "forecast_pairs_as_before"])).toBe("Only the rows listed are changed. Bill matches on the forecast may shift once saved.");
  });
  it("the server's own words for a refusal, else the fallback", () => {
    const e = { status: 409, data: { code: "changed_since", error: "Two rows were filed by hand since." } };
    expect(refusalWords(e, "x")).toBe("Two rows were filed by hand since.");
    expect(refusalCode(e)).toBe("changed_since");
    expect(refusalWords(new Error("boom"), "Nothing was changed.")).toBe("Nothing was changed.");
    expect(refusalCode(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { checkExplainWords, signedMoney, verdictWords } from "./checkExplainWords";
import { T2, ownerExplain } from "../__test-helpers__/checkExplainFixture";

/** (T2) "Review difference" words — the owner's case and its neighbours. Synthetic. */

const lineOf = (w: ReturnType<typeof checkExplainWords>, key: string) => w.lines.find((l) => l.key === key)!;

describe("(T2) checkExplainWords — the owner's case, exactly", () => {
  it("⭐ every line, and the verdict: H2 can't find what explains it", () => {
    const w = checkExplainWords(ownerExplain());
    expect(w.title).toBe("Balance check · Oct 15, 7:02 AM");
    expect(w.account).toBe("Sample Bank Everyday Checking ••0001");
    expect(w.lines.map((l) => [l.label, l.value])).toEqual([
      ["Previous reading", "$432.00 · Oct 14, 7:00 AM (bank, available)"],
      ["Bank reading at the check", "$0.00 · Oct 15, 7:02 AM"],
      ["H2 expected", "$432.00 = previous reading + 0 bank rows between ($0.00)"],
      ["Difference", "$432.00 — bank lower"],
      ["Left out (pending deposits the bank's figure does not hold)", "none"],
      ["Added (deposits that posted since the previous reading)", "none"],
      ["Rows H2 recorded itself (not from the bank)", "none"],
      ["Arrived since the check", "none"],
    ]);
    expect(w.verdict).toBe(
      'H2 can\'t find what explains this $432.00. H2 now starts from the bank\'s $0.00 reading, so today\'s balances agree. The next Sync checks again from the bank\'s current figure; if they agree then, this check stays in history as "was off by $432.00 on Oct 15".',
    );
  });

  it("rows H2 recorded itself are listed with what they mean; the verdict says they add up", () => {
    const w = checkExplainWords(
      ownerExplain({
        manualRows: {
          amount: "-432.00",
          rows: [{ id: "m1", date: "2026-10-14", description: "Log payment · Amex", amount: "-432.00", pending: false, source: "manual" }],
        },
        verdict: "manual_rows_match",
      }),
    );
    const manual = lineOf(w, "manual");
    expect(manual.value).toBe("−$432.00");
    expect(manual.rows.map((r) => r.text)).toEqual([
      "Log payment · Amex · −$432.00 · Oct 14 · counts in H2's balance, not in the bank's rows",
    ]);
    expect(w.verdict).toBe(
      "The rows H2 recorded itself add up to the difference. They count in H2's balance today; the bank's own rows did not show them at the check.",
    );
  });

  it("counted rows between the readings are named, once each; a late row is said apart", () => {
    const w = checkExplainWords(
      ownerExplain({
        counted: {
          listed: true,
          rowCount: 1,
          net: "-20.00",
          addsUp: true,
          rows: [{ id: "c1", date: "2026-10-14", description: "CORNER MARKET", amount: "-20.00", pending: false, source: "plaid:sample" }],
        },
        rowsSince: { count: 1, rows: [{ id: "l1", date: "2026-10-15", description: "LATE DEBIT", amount: "-432.00", pending: false, source: "plaid:sample" }] },
        check: { ...ownerExplain().check, status: "resolved_since" },
        verdict: "late_rows_tie",
      }),
    );
    expect(lineOf(w, "expected").value).toBe("$432.00 = previous reading + 1 bank row between (−$20.00)");
    expect(lineOf(w, "expected").rows.map((r) => r.text)).toEqual(["CORNER MARKET · −$20.00 · Oct 14"]);
    expect(lineOf(w, "since")).toMatchObject({ value: "1 row" });
    expect(lineOf(w, "since").rows[0]!.text).toBe("LATE DEBIT · −$432.00 · Oct 15");
    expect(w.verdict).toBe("Rows that arrived after the check explain it (Resolved since).");
  });

  it("when today's figures are not one reading, the verdict does not claim they agree", () => {
    const e = ownerExplain({ today: { h2Balance: "12.00", bankReading: "0.00", bankAsOf: T2, sameMoment: true } });
    expect(verdictWords(e)).toBe(
      'H2 can\'t find what explains this $432.00. The next Sync checks again from the bank\'s current figure; if they agree then, this check stays in history as "was off by $432.00 on Oct 15".',
    );
  });

  it("rows changed since the check: said, never hidden", () => {
    const w = checkExplainWords(ownerExplain({ counted: { listed: true, rowCount: 0, net: "0.00", addsUp: false, rows: [] } }));
    expect(lineOf(w, "expected").note).toBe("Rows changed since the check, so these no longer add up to what H2 expected then.");
  });

  it("never checked: no lines, no verdict", () => {
    const w = checkExplainWords(ownerExplain({ record: null, verdict: null }));
    expect(w.lines).toEqual([]);
    expect(w.verdict).toBeNull();
  });

  it("signed amounts", () => {
    expect(signedMoney("-432")).toBe("−$432.00");
    expect(signedMoney("12")).toBe("+$12.00");
    expect(signedMoney("0.00")).toBe("$0.00");
  });
});

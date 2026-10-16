import { describe, it, expect } from "vitest";
import { checkState, checkView, confidenceView, type CheckLike } from "./bankConfidenceView";

/** (Q5, T2) The separate facts about the bank balance, and the check's one state machine. Synthetic. */
const NOW = Date.parse("2026-10-15T17:00:00Z");
const check = (o: Partial<CheckLike> = {}): CheckLike => ({
  status: "matches", reason: null, stale: false, staleReason: null, checkedAt: "2026-10-15T12:02:00Z", difference: "0.00", direction: null, ...o,
});
/** The owner's case: the Sync read $0.00, H2 expected $432.00, and re-anchored to the bank. */
const owner = (o: Partial<CheckLike> = {}): CheckLike =>
  check({
    status: "off_by",
    difference: "432.00",
    direction: "bank_lower",
    bank: { balance: "0.00", at: "2026-10-15T12:02:00.000Z" },
    h2: { balance: "432.00" },
    lastDrift: null,
    ...o,
  });
const TODAY_ZERO = { h2: "0.00", reading: "0.00", asOf: "2026-10-15T12:02:00.000Z", source: "plaid" };

describe("(T2) checkState — one chip, one line, one action", () => {
  it("⭐ the owner's case: Difference needs review, the check's own moment, today's two figures agree", () => {
    expect(checkState(owner(), NOW, TODAY_ZERO)).toEqual({
      chip: "Difference needs review",
      tone: "bad",
      line: "At the last check (Oct 15) the bank was $432.00 lower than H2 expected.",
      agree: "Today H2 $0.00 and the bank $0.00 agree.",
      history: null,
      action: "review",
    });
  });

  it("today's agreement is said only when the two figures tie to the cent AND the check read the current anchor", () => {
    expect(checkState(owner(), NOW, { ...TODAY_ZERO, h2: "10.00" }).agree).toBeNull();
    expect(checkState(owner(), NOW, { ...TODAY_ZERO, asOf: "2026-10-16T12:00:00.000Z" }).agree).toBeNull();
    expect(checkState(owner(), NOW).agree).toBeNull();
    // The same moment written another way is the same moment.
    expect(checkState(owner(), NOW, { ...TODAY_ZERO, asOf: "2026-10-15T07:02:00-05:00" }).agree).toBe("Today H2 $0.00 and the bank $0.00 agree.");
  });

  it("bank higher reads the other way", () => {
    expect(checkState(owner({ direction: "bank_higher", difference: "62.50" }), NOW).line).toBe(
      "At the last check (Oct 15) the bank was $62.50 higher than H2 expected.",
    );
  });

  it("matches is green: checked when, and the two figures the check compared", () => {
    expect(checkState(check({ bank: { balance: "120.00", at: "x" }, h2: { balance: "120.00" } }), NOW)).toMatchObject({
      chip: "Balances match",
      tone: "ok",
      line: "Checked 4 h ago · bank $120.00 = H2 $120.00",
      action: null,
    });
  });

  it("resolved since is green, with the check's own difference (not the history)", () => {
    const s = checkState(owner({ status: "resolved_since", lastDrift: { checkedAt: "2026-10-02T12:00:00Z", difference: "9.00" } }), NOW);
    expect(s).toMatchObject({
      chip: "Resolved since",
      tone: "ok",
      line: "Was off by $432.00 at the Oct 15 check; rows that arrived later explain it.",
      history: "Earlier: off by $9.00 on Oct 2",
      action: null,
    });
    // Only age makes it grey.
    expect(checkState(owner({ status: "resolved_since", stale: true, staleReason: "age" }), NOW).tone).toBe("grey");
  });

  it("an out-of-date check is grey, says why, and offers Sync to check — never green, never rust", () => {
    expect(checkState(owner({ stale: true, staleReason: "anchor_changed", checkedAt: "2026-10-14T12:00:00Z" }), NOW)).toMatchObject({
      chip: "Check is out of date",
      tone: "grey",
      line: "The bank balance was re-read since the last check (Oct 14). It was off by $432.00 then.",
      action: "sync",
    });
    // (H4) A typed balance replaced the anchor: said as typed, not as a bank read.
    expect(checkState(check({ stale: true, staleReason: "anchor_changed", checkedAt: "2026-10-14T12:00:00Z" }), NOW, { ...TODAY_ZERO, source: "manual" }).line).toBe(
      "A balance was typed in since the last check (Oct 14).",
    );
    expect(checkState(check({ stale: true, staleReason: "rows_since" }), NOW).line).toBe("Rows arrived after the last check (Oct 15).");
    expect(checkState(check({ stale: true, staleReason: "age", checkedAt: "2026-10-05T12:00:00Z" }), NOW).line).toBe("Last checked 10 days ago.");
  });

  it.each([
    ["never", null, "sync"],
    [null, null, "sync"],
    ["not_forecast_account", "H2 checks the planned account only.", null],
    ["anchor_too_old", "The last balance was too old to compare.", "sync"],
    ["balance_unavailable", "The bank gave no balance.", "sync"],
  ])("not checked (%s) is grey: its reason and action", (reason, line, action) => {
    expect(checkState(check({ status: "not_checked", reason, checkedAt: null, difference: null }), NOW)).toMatchObject({
      chip: "Not checked",
      tone: "grey",
      line,
      action,
    });
  });

  it("the history line keeps an earlier difference visible after a later check ties", () => {
    expect(checkState(check({ lastDrift: { checkedAt: "2026-10-15T12:02:00Z", difference: "432.00" } }), NOW).history).toBe(
      "Earlier: off by $432.00 on Oct 15",
    );
  });
});

describe("checkView — the chip the dashboard shows is the Banking chip", () => {
  it("matches / resolved since are green; a difference is rust; an old or unchecked one is grey", () => {
    expect(checkView(check(), NOW)).toEqual({ word: "Balances match", tone: "ok", matched: true });
    expect(checkView(check({ status: "resolved_since" }), NOW)).toMatchObject({ word: "Resolved since", tone: "ok" });
    expect(checkView(owner(), NOW)).toEqual({ word: "Difference needs review", tone: "bad", matched: false });
    expect(checkView(check({ stale: true, staleReason: "age" }), NOW)).toEqual({ word: "Check is out of date", tone: "grey", matched: true });
    expect(checkView(check({ status: "not_checked", reason: "never", checkedAt: null }), NOW)).toEqual({ word: "Not checked", tone: "grey", matched: false });
  });
});

describe("confidenceView", () => {
  const base = { fetchedAt: "2026-10-15T15:00:00Z", bankBalance: "2985.00", bankAsOf: "2026-10-15T15:00:00Z", h2Balance: "3047.50", pendingCount: 2, check: check() };
  it("separate facts: updated, H2 today beside the bank's reading, the check, pending", () => {
    const v = confidenceView(base, NOW);
    expect(v.updated).toBe("Updated 2 h ago");
    expect(v.balances).toBe("Checking $3,047.50 today · bank read $2,985.00 2 h ago");
    expect(v.check.word).toBe("Balances match");
    expect(v.pending).toBe("2 pending");
    expect(v.tone).toBe("ok");
  });
  it("a fresh fetch does not make an unchecked balance green", () => {
    const v = confidenceView({ ...base, check: check({ status: "not_checked", reason: "never", checkedAt: null }) }, NOW);
    expect(v.updated).toBe("Updated 2 h ago");
    expect(v.tone).toBe("grey");
  });
  it("nothing pending says nothing; an unknown side is not guessed", () => {
    const v = confidenceView({ ...base, pendingCount: 0, bankBalance: null }, NOW);
    expect(v.pending).toBeNull();
    expect(v.balances).toBeNull();
    expect(confidenceView({ ...base, fetchedAt: null }, NOW).updated).toBeNull();
  });
  it("a bank balance of $0.00 is a real figure, not missing", () => {
    expect(confidenceView({ ...base, bankBalance: "0.00", h2Balance: "0.00" }, NOW).balances).toBe("Checking $0.00 today · bank read $0.00 2 h ago");
  });
});

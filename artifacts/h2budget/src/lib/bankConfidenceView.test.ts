import { describe, it, expect } from "vitest";
import { checkView, confidenceView, type CheckLike } from "./bankConfidenceView";

/** (Q5) The four separate facts about the bank balance. Synthetic. */
const NOW = Date.parse("2026-10-14T17:00:00Z");
const check = (o: Partial<CheckLike> = {}): CheckLike => ({
  status: "matches", reason: null, stale: false, checkedAt: "2026-10-14T15:00:00Z", difference: "0.00", direction: null, ...o,
});

describe("checkView", () => {
  it("matches is green; resolved since is green", () => {
    expect(checkView(check(), NOW)).toEqual({ word: "Matches bank", tone: "ok", matched: true });
    expect(checkView(check({ status: "resolved_since" }), NOW).tone).toBe("ok");
  });
  it("off by names the amount and the way, in rust", () => {
    expect(checkView(check({ status: "off_by", difference: "62.50", direction: "bank_lower" }), NOW)).toEqual({ word: "Off by $62.50 — bank lower", tone: "bad", matched: false });
    expect(checkView(check({ status: "off_by", difference: "10.00", direction: "bank_higher" }), NOW).word).toBe("Off by $10.00 — bank higher");
  });
  it("an old check is grey and says how old; it is never green, even when it matched", () => {
    const old = checkView(check({ stale: true, checkedAt: "2026-10-05T12:00:00Z" }), NOW);
    expect(old).toEqual({ word: "Checked 9 days ago", tone: "grey", matched: true });
    const oldOff = checkView(check({ status: "off_by", stale: true, checkedAt: "2026-10-05T12:00:00Z", difference: "62.50" }), NOW);
    expect(oldOff).toEqual({ word: "Checked 9 days ago · was off by $62.50", tone: "grey", matched: false });
    // under two days it is the relative form, not "0 days ago"
    expect(checkView(check({ stale: true, checkedAt: "2026-10-14T05:00:00Z" }), NOW).word).toBe("Checked 12 h ago");
  });
  it.each([
    ["never", "Not checked yet — Sync to check"],
    ["not_forecast_account", "Not checked yet — planned account only"],
    ["anchor_too_old", "Not checked yet — last balance too old"],
    ["balance_unavailable", "Not checked yet — bank gave no balance"],
    [null, "Not checked yet — Sync to check"],
  ])("not checked (%s) is grey with its reason", (reason, word) => {
    expect(checkView(check({ status: "not_checked", reason, checkedAt: null }), NOW)).toEqual({ word, tone: "grey", matched: false });
  });
});

describe("confidenceView", () => {
  const base = { fetchedAt: "2026-10-14T15:00:00Z", bankBalance: "2985.00", h2Balance: "3047.50", pendingCount: 2, check: check() };
  it("four separate facts: updated, bank vs H2, the check, pending", () => {
    const v = confidenceView(base, NOW);
    expect(v.updated).toBe("Updated 2 h ago");
    expect(v.balances).toBe("Bank $2,985.00 · H2 $3,047.50");
    expect(v.check.word).toBe("Matches bank");
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
    expect(confidenceView({ ...base, bankBalance: "0.00", h2Balance: "0.00" }, NOW).balances).toBe("Bank $0.00 · H2 $0.00");
  });
});

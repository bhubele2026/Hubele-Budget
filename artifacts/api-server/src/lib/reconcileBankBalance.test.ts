import { describe, it, expect } from "vitest";
import {
  anchorIsReconcilable,
  reconcileBankBalance,
  RECONCILE_MAX_ANCHOR_AGE_DAYS,
} from "./reconcileBankBalance";

describe("reconcileBankBalance", () => {
  it("ties when the ledger explains the bank exactly", () => {
    const r = reconcileBankBalance({
      anchorBalance: 4726.97,
      ledgerNetSinceAnchor: -442.91,
      bankAvailable: 4284.06,
    });
    expect(r.predicted).toBe(4284.06);
    expect(r.unexplained).toBe(0);
    expect(r.drifted).toBe(false);
  });

  it("⭐ names the exact gap when a deposit never arrived (2026-08-25)", () => {
    // Brad's case, to the cent. Chase held $4,453.96; our rows only accounted
    // for $4,284.06 because a $169.90 deposit from the previous Friday was
    // never delivered by Plaid's cursor. Four days on every screen, silently.
    const r = reconcileBankBalance({
      anchorBalance: 4726.97,
      ledgerNetSinceAnchor: -442.91,
      bankAvailable: 4453.96,
    });
    expect(r.predicted).toBe(4284.06);
    expect(r.unexplained).toBe(169.9); // the bank has more than we can explain
    expect(r.drifted).toBe(true);
  });

  it("goes negative when we hold a row the bank does not (a duplicate or a reversal)", () => {
    const r = reconcileBankBalance({
      anchorBalance: 1000,
      ledgerNetSinceAnchor: -150, // counted twice
      bankAvailable: 925,
    });
    expect(r.predicted).toBe(850);
    expect(r.unexplained).toBe(75);
    expect(r.drifted).toBe(true);
  });

  it("treats sub-cent float noise as a tie, not as a missing row", () => {
    const r = reconcileBankBalance({
      anchorBalance: 0.1,
      ledgerNetSinceAnchor: 0.2,
      bankAvailable: 0.3, // 0.1 + 0.2 === 0.30000000000000004 in floating point
    });
    expect(r.drifted).toBe(false);
  });

  it("fires at exactly one cent — the smallest difference a row can make", () => {
    const r = reconcileBankBalance({
      anchorBalance: 100,
      ledgerNetSinceAnchor: 0,
      bankAvailable: 100.01,
    });
    expect(r.unexplained).toBe(0.01);
    expect(r.drifted).toBe(true);
  });
});

describe("anchorIsReconcilable", () => {
  const now = new Date("2026-08-25T12:00:00Z");

  it("accepts a fresh anchor", () => {
    expect(anchorIsReconcilable(new Date("2026-08-24T12:00:00Z"), now)).toBe(true);
  });

  it("accepts one taken this instant", () => {
    expect(anchorIsReconcilable(now, now)).toBe(true);
  });

  it("refuses an anchor older than the window", () => {
    const old = new Date(
      now.getTime() - (RECONCILE_MAX_ANCHOR_AGE_DAYS + 1) * 86_400_000,
    );
    // Not because the maths breaks — because it would report every historical
    // gap at once, every time, until nobody reads the warning.
    expect(anchorIsReconcilable(old, now)).toBe(false);
  });

  it("refuses a future-dated anchor (clock skew)", () => {
    expect(anchorIsReconcilable(new Date("2026-08-26T12:00:00Z"), now)).toBe(false);
  });
});

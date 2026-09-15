import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  cashSignalFingerprint,
  isCashSignalQueryKey,
  watchCashSignalFamily,
} from "./cashSignalFamilyInvalidation";

/**
 * (PR-K follow-up, LOW) One horizon family, one answer.
 *
 * The Forecast page's 30-day tab and the Cash flow card's 90-day request
 * cache under two different keys, even though the server computes both with
 * the same function. After a background bank sync the two entries could each
 * stay "fresh" for up to 5 minutes with different balances for the same day.
 * `watchCashSignalFamily` fixes this centrally, once, in `App.tsx` — these
 * tests exercise it exactly as `App.tsx` uses it: subscribe once, then let
 * ordinary `setQueryData` calls stand in for real fetch responses "arriving"
 * (a real fetch dispatches the identical `{ type: "updated", action: {
 * type: "success" } }` cache event `setQueryData` does).
 *
 * All names/numbers here are synthetic.
 */

const THIRTY = ["/api/forecast/cash-signal", { horizonDays: 30 }] as const;
const NINETY = ["/api/forecast/cash-signal", { horizonDays: 90 }] as const;
const UNRELATED = ["/api/forecast", { days: 90 }] as const;

function signal(bankToday: string, snapshotAt: string | null, extra: Record<string, unknown> = {}) {
  return { bankToday, snapshotAt, status: "ready", account: { via: "pointer" }, ...extra };
}

const invalidated = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated ?? false;

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("isCashSignalQueryKey / cashSignalFingerprint — the building blocks", () => {
  it("matches only the cash-signal family, by key prefix", () => {
    expect(isCashSignalQueryKey(THIRTY)).toBe(true);
    expect(isCashSignalQueryKey(NINETY)).toBe(true);
    expect(isCashSignalQueryKey(UNRELATED)).toBe(false);
  });

  it("fingerprints bankToday + snapshotAt, and nothing else", () => {
    expect(cashSignalFingerprint(signal("100.00", "2026-05-01T00:00:00Z"))).toEqual({
      bankToday: "100.00",
      snapshotAt: "2026-05-01T00:00:00Z",
    });
  });

  it("is null for a payload with neither field — nothing to compare", () => {
    expect(cashSignalFingerprint({ foo: "bar" })).toBeNull();
    expect(cashSignalFingerprint(undefined)).toBeNull();
    expect(cashSignalFingerprint(null)).toBeNull();
  });
});

describe("watchCashSignalFamily — cross-horizon reconciliation", () => {
  it("a newer 90-day response marks a stale 30-day entry invalid", () => {
    const qc = client();
    watchCashSignalFamily(qc);
    // Both start in agreement.
    qc.setQueryData(THIRTY, signal("100.00", "2026-05-01T00:00:00Z"));
    qc.setQueryData(NINETY, signal("100.00", "2026-05-01T00:00:00Z"));
    expect(invalidated(qc, THIRTY)).toBe(false);

    // A background bank sync moves the balance; the 90-day tab (say, the
    // Cash flow card) happens to refetch first and sees it before the 30-day
    // tab's own 5-minute staleTime has elapsed.
    qc.setQueryData(NINETY, signal("250.00", "2026-05-02T09:00:00Z"));

    expect(invalidated(qc, THIRTY)).toBe(true);
    // Rule 1: the entry that just arrived is never invalidated by its own arrival.
    expect(invalidated(qc, NINETY)).toBe(false);
  });

  it("never invalidates the entry that just arrived, only the others", () => {
    const qc = client();
    watchCashSignalFamily(qc);
    qc.setQueryData(THIRTY, signal("100.00", "2026-05-01T00:00:00Z"));
    qc.setQueryData(NINETY, signal("250.00", "2026-05-02T09:00:00Z"));
    expect(invalidated(qc, NINETY)).toBe(false);
    expect(invalidated(qc, THIRTY)).toBe(true);
  });

  it("matching responses cause no invalidation", () => {
    const qc = client();
    watchCashSignalFamily(qc);
    const spy = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData(THIRTY, signal("100.00", "2026-05-01T00:00:00Z"));
    qc.setQueryData(NINETY, signal("100.00", "2026-05-01T00:00:00Z"));
    expect(spy).not.toHaveBeenCalled();
    expect(invalidated(qc, THIRTY)).toBe(false);
    expect(invalidated(qc, NINETY)).toBe(false);
  });

  it("only ever compares within the cash-signal family, never an unrelated key", () => {
    const qc = client();
    watchCashSignalFamily(qc);
    qc.setQueryData(UNRELATED, { events: [] });
    qc.setQueryData(NINETY, signal("250.00", "2026-05-02T09:00:00Z"));
    expect(invalidated(qc, UNRELATED)).toBe(false);
  });

  it("no refetch loop: once the stale entry comes back in agreement, nothing invalidates again", () => {
    const qc = client();
    watchCashSignalFamily(qc);
    qc.setQueryData(THIRTY, signal("100.00", "2026-05-01T00:00:00Z"));
    qc.setQueryData(NINETY, signal("100.00", "2026-05-01T00:00:00Z"));

    const spy = vi.spyOn(qc, "invalidateQueries");

    // The bank syncs; the 90-day tab sees it first and invalidates the 30-day entry.
    qc.setQueryData(NINETY, signal("250.00", "2026-05-02T09:00:00Z"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(invalidated(qc, THIRTY)).toBe(true);

    // The (now-invalid) 30-day entry refetches — its own real-world trigger,
    // simulated here the same way a real fetch's success arrives — and comes
    // back with the SAME figures the 90-day tab already has.
    qc.setQueryData(THIRTY, signal("250.00", "2026-05-02T09:00:00Z"));

    // They agree now, so this arrival invalidates nothing else — no ping-pong
    // back onto the 90-day entry, and no repeat call for the 30-day entry.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(invalidated(qc, NINETY)).toBe(false);
    expect(invalidated(qc, THIRTY)).toBe(false); // its own fresh success clears the flag
  });

  it("a family with no other cached entries yet does nothing", () => {
    const qc = client();
    watchCashSignalFamily(qc);
    const spy = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData(NINETY, signal("250.00", "2026-05-02T09:00:00Z"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("an error response (no bankToday/snapshotAt) triggers no invalidation", () => {
    const qc = client();
    watchCashSignalFamily(qc);
    qc.setQueryData(THIRTY, signal("100.00", "2026-05-01T00:00:00Z"));
    const spy = vi.spyOn(qc, "invalidateQueries");
    // A malformed/unrelated payload landing under the family key (shouldn't
    // happen in practice, but the guard must not throw or misfire).
    qc.setQueryData(NINETY, { unexpected: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it("unsubscribing stops the rule", () => {
    const qc = client();
    const unwatch = watchCashSignalFamily(qc);
    qc.setQueryData(THIRTY, signal("100.00", "2026-05-01T00:00:00Z"));
    unwatch();
    qc.setQueryData(NINETY, signal("250.00", "2026-05-02T09:00:00Z"));
    expect(invalidated(qc, THIRTY)).toBe(false);
  });
});

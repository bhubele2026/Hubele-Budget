import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({ spine: { data: undefined as unknown, state: "loading", refetch: () => {} } }));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => h.spine }));

import { useBankBalanceView } from "./useBankBalanceView";

const BANK = {
  balance: "2156.55", asOfDate: "2026-10-02T19:00:00.000Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null,
  snapshot: { balance: "3458.98", at: "2026-10-02T19:00:00.000Z", source: "plaid" },
  sinceSnapshot: { net: "-1302.43", count: 20, through: "2026-10-09" },
  account: { rowId: "row-chk", externalId: "ext-chk", name: "Total Checking", mask: "5526", subtype: "checking", via: "pointer" },
};

beforeEach(() => {
  h.spine = { data: undefined, state: "loading", refetch: () => {} };
});

describe("useBankBalanceView — the spine's bank, no request of its own", () => {
  it("is null (with the spine's state) until the spine answers", () => {
    const { result } = renderHook(() => useBankBalanceView());
    expect(result.current.view).toBeNull();
    expect(result.current.state).toBe("loading");
  });

  it("reads the balance, the snapshot, what rolled since and the account from the spine", () => {
    h.spine = { data: { bank: BANK }, state: "loaded", refetch: () => {} };
    const { result } = renderHook(() => useBankBalanceView());
    expect(result.current.state).toBe("loaded");
    expect(result.current.view).toMatchObject({
      balance: "2156.55",
      snapshot: { balance: "3458.98", day: "2026-10-02" },
      since: { count: 20, net: "-1302.43" },
      account: { rowId: "row-chk", externalId: "ext-chk" },
    });
  });

  it("keeps the same view while the spine's bank is the same object", () => {
    h.spine = { data: { bank: BANK }, state: "loaded", refetch: () => {} };
    const { result, rerender } = renderHook(() => useBankBalanceView());
    const first = result.current.view;
    rerender();
    expect(result.current.view).toBe(first);
  });

  it("a failed refresh keeps the last good view and says so", () => {
    h.spine = { data: { bank: BANK }, state: "refresh-failed", refetch: () => {} };
    const { result } = renderHook(() => useBankBalanceView());
    expect(result.current.state).toBe("refresh-failed");
    expect(result.current.view!.balance).toBe("2156.55");
  });
});

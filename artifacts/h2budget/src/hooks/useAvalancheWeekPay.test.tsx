import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { AvalancheWeekPayResult } from "@workspace/api-client-react";

// ⭐ (AVAL-W) "We paid it" / Undo, the ONE hook the home page's box and the Debt
// page's panel share: it calls the generated mutations, writes the fresh plan
// it was handed, and marks stale what a logged debt payment marks stale (the
// debts, the avalanche extra, the forecast family). The app-wide rule (spine,
// cash signal, weekly plan) runs from App.tsx's mutationCache on top.

type MutOpts = { mutation?: { onSuccess?: (r: AvalancheWeekPayResult) => void; onError?: (e: unknown) => void } };
const h = vi.hoisted(() => ({
  payCalls: [] as unknown[],
  undoCalls: [] as unknown[],
  payOpts: null as MutOpts | null,
  undoOpts: null as MutOpts | null,
}));
vi.mock("@workspace/api-client-react/features", () => ({
  getGetAvalancheWeeklyQueryKey: () => ["/api/avalanche/weekly"],
  usePayAvalancheWeek: (opts: MutOpts) => {
    h.payOpts = opts;
    return { mutate: (v: unknown) => h.payCalls.push(v), isPending: false };
  },
  useUndoAvalancheWeekPay: (opts: MutOpts) => {
    h.undoOpts = opts;
    return { mutate: (v: unknown) => h.undoCalls.push(v), isPending: false };
  },
}));

import { useAvalancheWeekPay } from "./useAvalancheWeekPay";

const WEEKLY = ["/api/avalanche/weekly"];
const DEBTS = ["/api/debts"];
const EXTRA = ["/api/avalanche/extra"];
const FORECAST = ["/api/forecast", { days: 90 }];
const SIGNAL = ["/api/forecast/cash-signal", { horizonDays: 90 }];
const UNRELATED = ["/api/settings"];

function setup() {
  const qc = new QueryClient();
  for (const k of [WEEKLY, DEBTS, EXTRA, FORECAST, SIGNAL, UNRELATED]) qc.setQueryData(k, { seeded: true });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useAvalancheWeekPay(), { wrapper });
  return { qc, hook };
}
const stale = (qc: QueryClient, k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated ?? false;

const result = { payment: { id: "rec-1" }, plan: { cadence: "weekly", weeks: [], lastPaid: { id: "rec-1" } } } as unknown as AvalancheWeekPayResult;

beforeEach(() => {
  h.payCalls = [];
  h.undoCalls = [];
  h.payOpts = null;
  h.undoOpts = null;
});
afterEach(cleanup);

describe("useAvalancheWeekPay", () => {
  it("pay sends the day; undo sends the record", () => {
    const { hook } = setup();
    act(() => hook.result.current.pay("2026-11-13"));
    expect(h.payCalls).toEqual([{ data: { date: "2026-11-13" } }]);
    act(() => hook.result.current.undo("rec-1"));
    expect(h.undoCalls).toEqual([{ id: "rec-1" }]);
  });

  it("a success writes the fresh plan and marks the debts, the extra and the forecast family stale — nothing else", () => {
    const { qc } = setup();
    act(() => h.payOpts!.mutation!.onSuccess!(result));
    expect(qc.getQueryData(WEEKLY)).toEqual(result.plan);
    expect(stale(qc, DEBTS)).toBe(true);
    expect(stale(qc, EXTRA)).toBe(true);
    expect(stale(qc, FORECAST)).toBe(true);
    expect(stale(qc, SIGNAL)).toBe(true);
    expect(stale(qc, UNRELATED)).toBe(false);
  });

  it("the undo's success does the same", () => {
    const { qc } = setup();
    act(() => h.undoOpts!.mutation!.onSuccess!(result));
    expect(qc.getQueryData(WEEKLY)).toEqual(result.plan);
    expect(stale(qc, DEBTS)).toBe(true);
  });

  it("a refusal shows the server's words and re-reads the plan", () => {
    const { qc, hook } = setup();
    act(() => h.payOpts!.mutation!.onError!({ status: 409, data: { error: "This week is already answered. Nothing was changed.", code: "already_answered" } }));
    expect(hook.result.current.error).toBe("This week is already answered. Nothing was changed.");
    expect(stale(qc, WEEKLY)).toBe(true);
    expect(stale(qc, DEBTS)).toBe(false);
    act(() => h.payOpts!.mutation!.onError!(new TypeError("Failed to fetch")));
    expect(hook.result.current.error).toBe("That did not go through. Try again.");
    act(() => hook.result.current.pay("2026-11-13"));
    expect(hook.result.current.error).toBeNull();
  });
});

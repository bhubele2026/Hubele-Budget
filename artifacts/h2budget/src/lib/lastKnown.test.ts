import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getGetSpineQueryKey } from "@workspace/api-client-react";
import { getGetAvalancheWeeklyQueryKey } from "@workspace/api-client-react/features";

const SPINE = getGetSpineQueryKey();
const WEEKLY = getGetAvalancheWeeklyQueryKey();
const fresh = async () => {
  vi.resetModules();
  return { lk: await import("./lastKnown"), save: await import("./lastKnownSave") };
};

afterEach(() => localStorage.clear());

describe("Home's last numbers on this device", () => {
  it("keeps only FRESH answers, for the signed-in person, and paints them on the next open as old as they are", async () => {
    const { lk, save } = await fresh();
    const qc = new QueryClient();
    const stop = save.persistLastKnown(qc, "user_a");
    qc.setQueryData(SPINE, { bank: { balance: "10.00" } }, { updatedAt: 1000 });
    expect(localStorage.getItem(lk.LAST_KNOWN_KEY)).toBeNull(); // setQueryData is not a fetch
    await qc.fetchQuery({ queryKey: SPINE, queryFn: async () => ({ bank: { balance: "12.00" } }) });
    await qc.fetchQuery({ queryKey: WEEKLY, queryFn: async () => ({ weeks: [1] }) });
    stop();
    const kept = JSON.parse(localStorage.getItem(lk.LAST_KNOWN_KEY)!);
    expect(kept.u).toBe("user_a");
    expect(kept.s).toEqual({ bank: { balance: "12.00" } });
    expect(kept.w).toEqual({ weeks: [1] });

    const next = await fresh();
    const qc2 = new QueryClient();
    next.lk.seedLastKnown(qc2, SPINE);
    expect(qc2.getQueryData(SPINE)).toEqual({ bank: { balance: "12.00" } });
    expect(qc2.getQueryState(SPINE)!.dataUpdatedAt).toBe(kept.t); // old: asked again at once
    expect(next.lk.lastKnown()!.u).toBe("user_a");
    // The painted copy is never written back as if it were fresh.
    const before = localStorage.getItem(next.lk.LAST_KNOWN_KEY);
    const stop2 = next.save.persistLastKnown(qc2, "user_a");
    stop2();
    expect(localStorage.getItem(next.lk.LAST_KNOWN_KEY)).toBe(before);
  });

  it("is dropped on request (sign-out, another person), and unreadable storage opens as before", async () => {
    const { lk } = await fresh();
    localStorage.setItem(lk.LAST_KNOWN_KEY, "{not json");
    const qc = new QueryClient();
    lk.seedLastKnown(qc, SPINE);
    expect(qc.getQueryData(SPINE)).toBeUndefined();
    localStorage.setItem(lk.LAST_KNOWN_KEY, JSON.stringify({ u: "user_a", t: 5, s: { x: 1 } }));
    lk.seedLastKnown(qc, SPINE);
    lk.dropLastKnown();
    expect(localStorage.getItem(lk.LAST_KNOWN_KEY)).toBeNull();
    expect(lk.lastKnown()).toBeNull();
  });
});

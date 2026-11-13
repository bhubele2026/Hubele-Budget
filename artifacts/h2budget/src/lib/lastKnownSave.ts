import type { QueryClient } from "@tanstack/react-query";
import { getGetSpineQueryKey } from "@workspace/api-client-react";
import { getGetAvalancheWeeklyQueryKey } from "@workspace/api-client-react/features";
import { LAST_KNOWN_KEY, lastKnown } from "./lastKnown";

/**
 * (PERF) Keep Home's last FRESH spine and "Pay this week" for `userId` on this device (lazy; see lastKnown.ts).
 * A copy painted from the device is never written back as if it were fresh. Returns the unsubscribe.
 */
export function persistLastKnown(qc: QueryClient, userId: string): () => void {
  const spineKey = getGetSpineQueryKey();
  const weeklyKey = getGetAvalancheWeeklyQueryKey();
  const write = () => {
    const s = qc.getQueryState(spineKey);
    const lk = lastKnown();
    if (s?.status !== "success" || s.data == null || (lk && s.dataUpdatedAt === lk.t)) return;
    const w = qc.getQueryState(weeklyKey);
    const freshW = w?.status === "success" && w.data != null && !(lk && w.dataUpdatedAt === lk.wt);
    const v = {
      u: userId,
      t: s.dataUpdatedAt,
      s: s.data,
      ...(freshW ? { w: w!.data, wt: w!.dataUpdatedAt } : lk?.u === userId && lk.w ? { w: lk.w, wt: lk.wt } : {}),
    };
    try {
      localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify(v));
    } catch {
      /* full or blocked: the next open simply waits for the server */
    }
  };
  write();
  return qc.getQueryCache().subscribe((e) => {
    // A fetch's answer only: setQueryData (a painted copy, an optimistic edit) is "manual".
    if (e.type !== "updated" || e.action.type !== "success" || (e.action as { manual?: boolean }).manual) return;
    const k = e.query.queryKey[0];
    if (k === spineKey[0] || k === weeklyKey[0]) write();
  });
}

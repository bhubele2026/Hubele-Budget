import { useEffect, useRef, useSyncExternalStore } from "react";
import { dayOf } from "@/lib/accountFreshness";

/**
 * ⭐ (T1) NO OLDER BANK READING EVER SHOWS AS CURRENT.
 *
 * Every response that carries the checking balance names the bank reading it
 * rolls forward from (`dataAsOf.snapshotAt`, docs/contracts/checking-balance.md).
 * The query cache records the NEWEST reading any response has carried (a
 * high-water mark, `recordDataAsOf`, hooked in App.tsx's QueryCache). A cached
 * answer built on an older reading — the 5-minute forecast bundle after a Sync
 * re-read the bank, say — is then:
 *   - labelled, never shown as current: "Earlier reading (Oct 14) — updating…";
 *   - asked again once (`useOlderSnapshot`), so it heals itself.
 * No reading (null) is "unknown" and never guarded. A placeholder (another key's
 * answer kept while this one loads) is never judged: `scoped()` owns that.
 * Pure words and a tiny store; nothing here touches money.
 */
type DataAsOfLike = { snapshotAt?: string | null } | null | undefined;

let markMs: number | null = null;
let markIso: string | null = null;
const listeners = new Set<() => void>();

/** The `dataAsOf.snapshotAt` a payload carries, or null. */
export function snapshotAtOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const d = (payload as { dataAsOf?: DataAsOfLike }).dataAsOf;
  const at = d && typeof d === "object" ? d.snapshotAt : null;
  return typeof at === "string" && at ? at : null;
}

/** Raise the high-water mark from a successful response (any query; most carry no `dataAsOf`). */
export function recordDataAsOf(payload: unknown): void {
  const at = snapshotAtOf(payload);
  if (!at) return;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms) || (markMs != null && ms <= markMs)) return;
  markMs = ms;
  markIso = at;
  listeners.forEach((l) => l());
}

/** Forget the mark (another user signed in: the cache was cleared). */
export function resetDataAsOf(): void {
  if (markMs == null) return;
  markMs = null;
  markIso = null;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getMark = () => markIso;

/** The newest reading seen so far (ISO), or null. */
export function useDataAsOfMark(): string | null {
  return useSyncExternalStore(subscribe, getMark, getMark);
}

export type SnapshotState = "current" | "older" | "unknown";

/** Is an answer's reading the newest seen? Strictly older is "older"; no reading is "unknown". */
export function snapshotState(snapshotAt: string | null | undefined, mark: string | null): SnapshotState {
  if (!snapshotAt) return "unknown";
  const a = Date.parse(snapshotAt);
  if (!Number.isFinite(a)) return "unknown";
  if (!mark) return "current";
  const m = Date.parse(mark);
  return Number.isFinite(m) && a < m ? "older" : "current";
}

/** "Earlier reading (Oct 14) — updating…" */
export function olderWords(snapshotAt: string | null | undefined): string {
  const d = dayOf(snapshotAt ?? null);
  return `Earlier reading${d ? ` (${d})` : ""} — updating…`;
}

export interface OlderSnapshot {
  older: boolean;
  /** The reading the answer on screen is built on. */
  shownAt: string | null;
  /** "Earlier reading (Oct 14) — updating…" when older; null otherwise. */
  words: string | null;
}

/**
 * Judge a query's answer against the newest reading seen. When it is older,
 * ask again ONCE for that answer (a second older answer for the same reading
 * does not loop). A placeholder is not this key's answer: never judged.
 */
export function useOlderSnapshot(q: {
  data: unknown;
  isPlaceholderData?: boolean;
  refetch?: () => unknown;
}): OlderSnapshot {
  const mark = useDataAsOfMark();
  const shownAt = q.isPlaceholderData ? null : snapshotAtOf(q.data);
  const older = !q.isPlaceholderData && snapshotState(shownAt, mark) === "older";
  const asked = useRef<string | null>(null);
  const refetch = q.refetch;
  useEffect(() => {
    if (!older || !shownAt || !refetch) return;
    const key = `${shownAt}|${mark ?? ""}`;
    if (asked.current === key) return;
    asked.current = key;
    void refetch();
  }, [older, shownAt, mark, refetch]);
  return { older, shownAt, words: older ? olderWords(shownAt) : null };
}

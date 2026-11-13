import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * ⭐ (PERF) HOME'S LAST NUMBERS, ON THIS DEVICE, FOR THE PERSON WHO SAW THEM.
 * The last good spine (and "Pay this week") is kept in this browser under one versioned key, with the signed-in
 * user's id. On the next open it is painted at once — said to be updating — and replaced when the fresh answer
 * lands. Server figures only, never zeros; dropped on sign-out and when Clerk names someone else (App.tsx).
 * The writing lives in a lazy chunk (lastKnownSave.ts).
 */
export const LAST_KNOWN_KEY = "h2:last:v1";
export type LastKnown = { u: string; t: number; s: unknown; w?: unknown; wt?: number };

let seeded: LastKnown | null = null;

/** Paint the kept spine under its query key (as old as it is, so it is asked again at once). */
export function seedLastKnown(qc: QueryClient, key: QueryKey): void {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KNOWN_KEY) ?? "null") as LastKnown | null;
    if (v && typeof v.u === "string" && v.s && v.t > 0) {
      seeded = v;
      qc.setQueryData(key, v.s, { updatedAt: v.t });
    }
  } catch {
    /* storage blocked or unreadable: open as before */
  }
}

/** What this open painted from the device (null when nothing). */
export const lastKnown = (): LastKnown | null => seeded;

export function dropLastKnown(): void {
  seeded = null;
  try {
    localStorage.removeItem(LAST_KNOWN_KEY);
  } catch {
    /* nothing kept */
  }
}

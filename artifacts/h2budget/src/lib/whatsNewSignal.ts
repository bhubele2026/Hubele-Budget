import { useSyncExternalStore } from "react";

/**
 * ⭐ (WN) THE WHAT'S NEW SIGNAL — the only What's new code on the open path.
 *
 * The notes, the sheet and the host that greets are a lazy chunk
 * (`components/whats-new/WhatsNewHost`); the account menu and the dashboard
 * header only need two things from it, so they read this tiny store instead:
 *
 *   - how many notes this person has not read: null = unknown (not asked yet,
 *     or the ask failed) — no "New" chip then, never a guess;
 *   - "open What's new" — a press before the host has loaded is kept and
 *     replayed when it registers, and tells the mount to load it now.
 *
 * No imports but React's store hook.
 */

let unread: number | null = null;
let openPending = false;
let openHandler: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Notes this person has not read; null = unknown. */
export function useWhatsNewUnread(): number | null {
  return useSyncExternalStore(subscribe, () => unread, () => null);
}

/** True while an open was asked for before the host could take it. */
export function useWhatsNewOpenPending(): boolean {
  return useSyncExternalStore(subscribe, () => openPending, () => false);
}

/** The host says how many are unread (null when it cannot say). */
export function setWhatsNewUnread(n: number | null): void {
  if (unread === n) return;
  unread = n;
  emit();
}

/** "What's new" was pressed: open the history (or the must-read sheet). */
export function requestWhatsNewOpen(): void {
  if (openHandler) {
    openHandler();
    return;
  }
  if (openPending) return;
  openPending = true;
  emit();
}

/** The host takes open requests; one made before it loaded is replayed now. */
export function onWhatsNewOpen(fn: () => void): () => void {
  openHandler = fn;
  if (openPending) {
    openPending = false;
    emit();
    fn();
  }
  return () => {
    if (openHandler === fn) openHandler = null;
  };
}

export function _resetWhatsNewSignalForTests(): void {
  unread = null;
  openPending = false;
  openHandler = null;
  emit();
}

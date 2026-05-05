// Coalesces Plaid webhook-triggered syncs so a burst of
// SYNC_UPDATES_AVAILABLE events for the same item only causes one
// `syncPlaidItem` call. Plaid commonly fires this webhook several times in
// quick succession (one per transaction batch); without dedupe we'd waste
// API quota and risk overlapping cursor advances against the same item.
//
// Behaviour per item:
//   - First webhook arms a short debounce timer.
//   - Webhooks that arrive while the timer is armed are dropped (coalesced).
//   - Webhooks that arrive while a sync is already in-flight set a "rerun
//     after" flag so the trailing-edge data isn't lost.
//
// The webhook handler should call `scheduleSyncForItem` and return 200
// immediately; the actual sync runs asynchronously in the background.

import { syncPlaidItem } from "./plaidSync";

const FALLBACK_DEBOUNCE_MS = 7000;

function getDefaultDebounceMs(): number {
  const raw = process.env.PLAID_SYNC_DEBOUNCE_MS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return FALLBACK_DEBOUNCE_MS;
}

type Runner = (userId: string, itemId: string) => Promise<unknown>;

type ItemState = {
  timer: NodeJS.Timeout | null;
  fire: (() => void) | null;
  inflight: Promise<void> | null;
  rerunUserId: string | null;
};

const states = new Map<string, ItemState>();

function getState(itemId: string): ItemState {
  let s = states.get(itemId);
  if (!s) {
    s = { timer: null, fire: null, inflight: null, rerunUserId: null };
    states.set(itemId, s);
  }
  return s;
}

const defaultRunner: Runner = (u, i) => syncPlaidItem(u, i);

export function scheduleSyncForItem(
  userId: string,
  itemId: string,
  opts: { debounceMs?: number; runner?: Runner } = {},
): void {
  const debounceMs = opts.debounceMs ?? getDefaultDebounceMs();
  const runner = opts.runner ?? defaultRunner;
  const s = getState(itemId);

  if (s.inflight) {
    // A sync is mid-flight. Don't start a parallel one (cursor race) — but
    // record that more data arrived so we run again once it finishes.
    s.rerunUserId = userId;
    return;
  }
  if (s.timer) {
    // Already debounced within the window — coalesce this webhook in.
    return;
  }

  const fire = (): void => {
    s.timer = null;
    s.fire = null;
    s.inflight = (async () => {
      try {
        await runner(userId, itemId);
      } catch {
        // syncPlaidItem already logs failures via its own pino logger; we
        // swallow here so a background rejection doesn't crash the process.
      } finally {
        s.inflight = null;
        const next = s.rerunUserId;
        s.rerunUserId = null;
        if (next) {
          scheduleSyncForItem(next, itemId, { debounceMs, runner });
        }
      }
    })();
  };

  s.fire = fire;
  s.timer = setTimeout(fire, debounceMs);
  // Don't keep the event loop alive solely for a debounced sync.
  s.timer.unref?.();
}

// Test helper — fires any pending timers immediately and waits for all
// in-flight (and any cascading rerun) syncs to settle.
export async function _flushPlaidSyncSchedulerForTests(): Promise<void> {
  for (let pass = 0; pass < 10; pass++) {
    let didWork = false;
    for (const s of states.values()) {
      if (s.timer && s.fire) {
        clearTimeout(s.timer);
        const f = s.fire;
        s.timer = null;
        s.fire = null;
        f();
        didWork = true;
      }
    }
    const inflights = Array.from(states.values())
      .map((s) => s.inflight)
      .filter((p): p is Promise<void> => !!p);
    if (inflights.length > 0) {
      await Promise.allSettled(inflights);
      didWork = true;
    }
    if (!didWork) break;
  }
}

export function _resetPlaidSyncSchedulerForTests(): void {
  for (const s of states.values()) {
    if (s.timer) clearTimeout(s.timer);
  }
  states.clear();
}

// (#671) Post-completion grace window in scheduleSyncForItem.
//
// Plaid commonly fires SYNC_UPDATES_AVAILABLE moments after a
// /transactions/refresh-driven sync wraps (the bank had a couple of
// pending charges that ingested just behind the refresh). The default
// debounce (7s) makes that trailing batch wait a full window before it
// runs, so a user staring at the UI sees pending charges trickle in
// over many seconds. When a webhook lands inside the grace window
// after a just-completed sync, the scheduler uses a much shorter
// debounce so the trailing-edge rows land quickly.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  scheduleSyncForItem,
  _resetPlaidSyncSchedulerForTests,
} from "../lib/plaidSyncScheduler";

beforeEach(() => {
  _resetPlaidSyncSchedulerForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetPlaidSyncSchedulerForTests();
});

describe("(#671) scheduleSyncForItem post-completion grace window", () => {
  it("uses the short grace debounce when a webhook arrives shortly after a previous sync completed", async () => {
    process.env.PLAID_SYNC_DEBOUNCE_MS = "7000";
    process.env.PLAID_SYNC_GRACE_DEBOUNCE_MS = "1500";
    process.env.PLAID_SYNC_GRACE_WINDOW_MS = "30000";

    const runner = vi.fn(async () => {});

    // Webhook 1 — first one for this item, uses the full 7s debounce.
    scheduleSyncForItem("u1", "item-grace", { runner });
    await vi.advanceTimersByTimeAsync(7000);
    expect(runner).toHaveBeenCalledTimes(1);

    // Trailing webhook arrives 100ms after the first sync wrapped —
    // inside the grace window → 1500ms debounce.
    await vi.advanceTimersByTimeAsync(100);
    scheduleSyncForItem("u1", "item-grace", { runner });

    // 1499ms in: must NOT have fired yet (debounce is 1500).
    await vi.advanceTimersByTimeAsync(1499);
    expect(runner).toHaveBeenCalledTimes(1);

    // One more ms → grace debounce elapses → rerun fires.
    await vi.advanceTimersByTimeAsync(2);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default debounce when a webhook arrives long after the previous sync completed", async () => {
    process.env.PLAID_SYNC_DEBOUNCE_MS = "7000";
    process.env.PLAID_SYNC_GRACE_DEBOUNCE_MS = "1500";
    process.env.PLAID_SYNC_GRACE_WINDOW_MS = "30000";

    const runner = vi.fn(async () => {});

    scheduleSyncForItem("u1", "item-stale", { runner });
    await vi.advanceTimersByTimeAsync(7000);
    expect(runner).toHaveBeenCalledTimes(1);

    // Wait well past the grace window before the second webhook.
    await vi.advanceTimersByTimeAsync(60_000);
    scheduleSyncForItem("u1", "item-stale", { runner });

    // Only 1500ms later: grace did NOT apply → still pending.
    await vi.advanceTimersByTimeAsync(1500);
    expect(runner).toHaveBeenCalledTimes(1);

    // Past the full default debounce → fires.
    await vi.advanceTimersByTimeAsync(6000);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

// (P2) The database pool: a query waits at most 10 s for a connection, and a
// queue for connections is reported — at most once per interval, and never
// when nobody waits.

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { POOL_CONNECTION_TIMEOUT_MS, POOL_MAX, pool, watchPoolWaiting, type PoolPressure } from "@workspace/db";

class FakePool extends EventEmitter {
  waitingCount = 0;
  totalCount = POOL_MAX;
  idleCount = 0;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the database pool", () => {
  it("waits at most POOL_CONNECTION_TIMEOUT_MS (10 s) for a connection, with 8 connections", () => {
    const options = (pool as unknown as { options: { connectionTimeoutMillis?: number; max?: number } }).options;
    expect(POOL_CONNECTION_TIMEOUT_MS).toBe(10_000);
    expect(options.connectionTimeoutMillis).toBe(POOL_CONNECTION_TIMEOUT_MS);
    expect(options.max).toBe(8);
  });

  it("reports waiting queries, rate-limited, and never when nobody waits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const fake = new FakePool();
    const seen: PoolPressure[] = [];
    const stop = watchPoolWaiting((p) => seen.push(p), 30_000, fake as never);

    fake.emit("acquire");
    expect(seen).toEqual([]);

    fake.waitingCount = 5;
    fake.emit("acquire");
    fake.emit("acquire");
    expect(seen).toEqual([{ waiting: 5, total: POOL_MAX, idle: 0, max: POOL_MAX }]);

    vi.advanceTimersByTime(30_000);
    fake.waitingCount = 2;
    fake.emit("acquire");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.waiting).toBe(2);

    stop();
    vi.advanceTimersByTime(60_000);
    fake.emit("acquire");
    expect(seen).toHaveLength(2);
    expect(fake.listenerCount("acquire")).toBe(0);
  });
});

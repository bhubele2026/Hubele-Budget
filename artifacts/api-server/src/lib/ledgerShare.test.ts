// (P2) In-flight sharing, the write generation, the write fence and the
// test-only deep freeze — the mechanics, with builds the test controls.
// The ledger itself is proven in __tests__/ledgerSharing.integration.test.ts.

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  bumpLedgerGeneration,
  deepFreeze,
  ledgerShareStats,
  ledgerSharesInFlight,
  ledgerSharingEnabled,
  ledgerWriteGeneration,
  shareInFlight,
} from "./ledgerShare";
import { cashSignalShareKey } from "./cashSignal";
import { ledgerWriteFence } from "../middlewares/ledgerWriteFence";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const KEY = (n: string) => `ledger-share-test|${n}`;

afterEach(() => {
  delete process.env.LEDGER_SHARING;
});

describe("shareInFlight", () => {
  it("concurrent callers with one key share one build; nothing is kept once it settles", async () => {
    const d = deferred<{ v: number }>();
    let builds = 0;
    const build = () => {
      builds += 1;
      return d.promise;
    };
    const before = ledgerSharesInFlight();
    const a = shareInFlight(KEY("one"), build);
    const b = shareInFlight(KEY("one"), build);
    const c = shareInFlight(KEY("one"), build);
    expect(builds).toBe(1);
    expect(a).toBe(b);
    expect(ledgerSharesInFlight()).toBe(before + 1);
    d.resolve({ v: 1 });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
    expect(ledgerSharesInFlight()).toBe(before);
    // A call after it settled builds again: no result cache.
    const again = shareInFlight(KEY("one"), async () => {
      builds += 1;
      return { v: 2 };
    });
    expect((await again).v).toBe(2);
    expect(builds).toBe(2);
  });

  it("different keys never share", async () => {
    let builds = 0;
    const build = async () => {
      builds += 1;
      return builds;
    };
    await Promise.all([shareInFlight(KEY("x"), build), shareInFlight(KEY("y"), build)]);
    expect(builds).toBe(2);
  });

  it("a failed build rejects every waiter, is never kept, and the next call rebuilds", async () => {
    const d = deferred<string>();
    let builds = 0;
    const waiters = [0, 1, 2].map(() =>
      shareInFlight(KEY("fail"), () => {
        builds += 1;
        return d.promise;
      }),
    );
    const boom = new Error("boom");
    d.reject(boom);
    for (const w of waiters) await expect(w).rejects.toBe(boom);
    expect(builds).toBe(1);
    const next = await shareInFlight(KEY("fail"), async () => {
      builds += 1;
      return "ok";
    });
    expect(next).toBe("ok");
    expect(builds).toBe(2);
  });

  it("⭐ a write between two calls: the second never joins the build from before the write", async () => {
    const first = deferred<string>();
    let builds = 0;
    const a = shareInFlight(KEY("gen"), () => {
      builds += 1;
      return first.promise;
    });
    const genBefore = ledgerWriteGeneration();
    bumpLedgerGeneration();
    expect(ledgerWriteGeneration()).toBe(genBefore + 1);
    const b = shareInFlight(KEY("gen"), async () => {
      builds += 1;
      return "after the write";
    });
    expect(builds).toBe(2);
    first.resolve("before the write");
    expect(await a).toBe("before the write");
    expect(await b).toBe("after the write");
  });

  it("counts started and joined builds", async () => {
    const { started, joined } = ledgerShareStats;
    const d = deferred<number>();
    const p = Promise.all([shareInFlight(KEY("count"), () => d.promise), shareInFlight(KEY("count"), () => d.promise)]);
    d.resolve(1);
    await p;
    expect(ledgerShareStats.started - started).toBe(1);
    expect(ledgerShareStats.joined - joined).toBe(1);
  });
});

describe("the kill switch", () => {
  it("LEDGER_SHARING=off turns sharing off; anything else leaves it on", () => {
    expect(ledgerSharingEnabled()).toBe(true);
    process.env.LEDGER_SHARING = "off";
    expect(ledgerSharingEnabled()).toBe(false);
    process.env.LEDGER_SHARING = " OFF ";
    expect(ledgerSharingEnabled()).toBe(false);
    process.env.LEDGER_SHARING = "on";
    expect(ledgerSharingEnabled()).toBe(true);
  });
});

describe("cashSignalShareKey — every input that changes the result", () => {
  const base = cashSignalShareKey("hh-1", "owner-1", { horizonDays: 90 }, "2026-10-14");
  it("differs on the household, the owner, the horizon, fromDate and today", () => {
    expect(cashSignalShareKey("hh-2", "owner-1", { horizonDays: 90 }, "2026-10-14")).not.toBe(base);
    expect(cashSignalShareKey("hh-1", "owner-2", { horizonDays: 90 }, "2026-10-14")).not.toBe(base);
    expect(cashSignalShareKey("hh-1", "owner-1", { horizonDays: 30 }, "2026-10-14")).not.toBe(base);
    expect(cashSignalShareKey("hh-1", "owner-1", {}, "2026-10-14")).not.toBe(base);
    expect(cashSignalShareKey("hh-1", "owner-1", { horizonDays: 90, fromDate: "2026-10-01" }, "2026-10-14")).not.toBe(base);
    expect(cashSignalShareKey("hh-1", "owner-1", { horizonDays: 90 }, "2026-10-15")).not.toBe(base);
  });
  it("(F6 round 3) differs with the expired-hold rule's kill switch", () => {
    vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
    try {
      expect(cashSignalShareKey("hh-1", "owner-1", { horizonDays: 90 }, "2026-10-14")).not.toBe(base);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(cashSignalShareKey("hh-1", "owner-1", { horizonDays: 90 }, "2026-10-14")).toBe(base);
  });
  it("is the same for the same inputs (an absent fromDate is absent)", () => {
    expect(cashSignalShareKey("hh-1", "owner-1", { horizonDays: 90, fromDate: undefined }, "2026-10-14")).toBe(base);
  });
  it("cannot be forged by a separator inside an id", () => {
    expect(cashSignalShareKey('a","b', "c", {}, "2026-10-14")).not.toBe(cashSignalShareKey("a", 'b","c', {}, "2026-10-14"));
  });
});

describe("ledgerWriteFence", () => {
  const run = (method: string) => {
    const res = new EventEmitter();
    const start = ledgerWriteGeneration();
    let nexted = false;
    ledgerWriteFence({ method } as never, res as never, () => {
      nexted = true;
    });
    return { res, start, nexted };
  };
  it("a read leaves the generation alone", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      const { res, start, nexted } = run(m);
      expect(nexted).toBe(true);
      res.emit("finish");
      expect(ledgerWriteGeneration()).toBe(start);
    }
  });
  it("⭐ a write moves it when it starts and again when it finishes (once, whichever event comes)", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { res, start, nexted } = run(m);
      expect(nexted).toBe(true);
      expect(ledgerWriteGeneration()).toBe(start + 1);
      res.emit("finish");
      expect(ledgerWriteGeneration()).toBe(start + 2);
      res.emit("close");
      expect(ledgerWriteGeneration()).toBe(start + 2);
    }
  });
});

describe("deepFreeze (tests only)", () => {
  it("freezes objects and arrays all the way down, and makes Map, Set and Date mutators throw", () => {
    const value = deepFreeze({
      items: [{ amount: 1 }],
      byKey: new Map([["k", { cents: 5 }]]),
      ids: new Set(["a"]),
      at: new Date("2026-10-14T00:00:00Z"),
    });
    expect(() => {
      (value.items as Array<{ amount: number }>).push({ amount: 2 });
    }).toThrow(TypeError);
    expect(() => {
      (value.items[0] as { amount: number }).amount = 3;
    }).toThrow(TypeError);
    expect(() => value.byKey.set("x", { cents: 1 })).toThrow(TypeError);
    expect(() => value.byKey.delete("k")).toThrow(TypeError);
    expect(() => {
      (value.byKey.get("k") as { cents: number }).cents = 9;
    }).toThrow(TypeError);
    expect(() => value.ids.add("b")).toThrow(TypeError);
    expect(() => value.at.setDate(1)).toThrow(TypeError);
    // Reads still work.
    expect(value.byKey.get("k")!.cents).toBe(5);
    expect(value.ids.has("a")).toBe(true);
    expect(value.at.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(JSON.stringify(value.items)).toBe('[{"amount":1}]');
  });
});

// (PERF-0) The per-request timing store: counts stay with their own request,
// the pool wrapper changes nothing it wraps, and the header carries only
// durations, counts and fixed names.
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  addSpan,
  currentTiming,
  instrumentPool,
  newRequestTiming,
  noteShareJoined,
  requestTiming,
  runWithTiming,
  serverTimingValue,
  startLedgerBuild,
  timed,
  timedAuth,
  type RequestTiming,
} from "./requestTiming";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ConnectCb = (err: Error | null, client?: object, done?: () => void) => void;
interface FakePool {
  connect(cb?: ConnectCb): Promise<object> | undefined;
  query(text: string, ...rest: unknown[]): Promise<unknown> | undefined;
}

/** A pool shaped like pg's: `query` checks a client out through `this.connect(cb)`, one connection at a time. */
function fakePool(queryMs: number): FakePool {
  let busy = false;
  const waiting: Array<() => void> = [];
  const release = () => {
    busy = false;
    const next = waiting.shift();
    if (next) next();
  };
  const pool: FakePool = {
    connect(this: FakePool, cb?: ConnectCb) {
      const hand = (resolve: (c: object) => void) => {
        const go = () => {
          busy = true;
          resolve({});
        };
        if (busy) waiting.push(go);
        else {
          busy = true;
          setTimeout(go, 0);
        }
      };
      if (cb) {
        hand((c) => cb(null, c, release));
        return undefined;
      }
      return new Promise<object>((res) => hand(res));
    },
    query(this: FakePool, text: string, ...rest: unknown[]) {
      const cb = typeof rest[rest.length - 1] === "function" ? (rest[rest.length - 1] as (e: Error | null, r?: unknown) => void) : null;
      const run = (done: (e: Error | null, r?: unknown) => void) => {
        this.connect((_e, _c, rel) => {
          setTimeout(() => {
            rel!();
            if (text === "fail") done(new Error("boom"));
            else done(null, { rows: [text] });
          }, queryMs);
        });
      };
      if (cb) {
        run(cb);
        return undefined;
      }
      return new Promise((res, rej) => run((e, r) => (e ? rej(e) : res(r))));
    },
  };
  return pool;
}

describe("requestTiming store", () => {
  it("counts each request's own queries, waits and builds, with two requests interleaved", async () => {
    const pool = fakePool(15);
    instrumentPool(pool);
    instrumentPool(pool); // idempotent
    const a = newRequestTiming();
    const b = newRequestTiming();
    const runA = runWithTiming(a, async () => {
      const done = startLedgerBuild(false);
      await Promise.all([pool.query("a1"), pool.query("a2"), pool.query("a3")]);
      done();
      noteShareJoined();
    });
    const runB = runWithTiming(b, async () => {
      const base = startLedgerBuild(true);
      await pool.query("b1");
      base();
    });
    await Promise.all([runA, runB]);
    expect(a.queries).toBe(3);
    expect(b.queries).toBe(1);
    expect(a.poolWaits).toBe(3);
    expect(b.poolWaits).toBe(1);
    expect(a.ledgerBuilds).toBe(1);
    expect(a.baseBuilds).toBe(0);
    expect(b.baseBuilds).toBe(1);
    expect(b.ledgerBuilds).toBe(0);
    expect(a.shareJoined).toBe(1);
    expect(b.shareJoined).toBe(0);
    // One connection: three queries at once queue for it, so the pool wait is real and is NOT counted as query time.
    expect(a.poolWaitMs).toBeGreaterThan(10);
    expect(a.dbMs).toBeGreaterThanOrEqual(3 * 12);
    expect(a.dbMs).toBeLessThan(3 * 15 + a.poolWaitMs);
    expect(b.ledgerMs).toBe(0);
    expect(b.baseMs).toBeGreaterThan(10);
  });

  it("leaves results, errors and callbacks of the wrapped pool unchanged, and counts nothing outside a request", async () => {
    const pool = fakePool(1);
    instrumentPool(pool);
    await expect(pool.query("x")).resolves.toEqual({ rows: ["x"] });
    await expect(pool.query("fail")).rejects.toThrow("boom");
    const s = newRequestTiming();
    await runWithTiming(s, async () => {
      await new Promise<void>((resolve) =>
        pool.query("cb", (e: Error | null, r?: unknown) => {
          expect(e).toBeNull();
          expect(r).toEqual({ rows: ["cb"] });
          resolve();
        }),
      );
      await expect(pool.query("fail")).rejects.toThrow("boom");
      const c = await (pool.connect() as Promise<object>);
      expect(c).toEqual({});
    });
    expect(s.queries).toBe(2);
    expect(s.poolWaits).toBe(3);
    expect(currentTiming()).toBeUndefined();
  });

  it("times named spans and returns the very promise it was given", async () => {
    const s = newRequestTiming();
    await runWithTiming(s, async () => {
      const p = sleep(12).then(() => 7);
      expect(timed("sp.x", p)).toBe(p);
      expect(await p).toBe(7);
      const bad = Promise.reject(new Error("no"));
      await expect(timed("sp.bad", bad)).rejects.toThrow("no");
      addSpan("sp.x", 1);
    });
    await sleep(0);
    expect(s.spans.get("sp.x")!).toBeGreaterThan(10);
    expect(s.spans.has("sp.bad")).toBe(true);
    // Outside a request: nothing to time, same promise back.
    const q = Promise.resolve(1);
    expect(timed("nope", q)).toBe(q);
  });

  it("writes a Server-Timing value of durations, counts and fixed names only", () => {
    const s: RequestTiming = {
      ...newRequestTiming(),
      start: 0,
      queries: 41,
      dbMs: 120.04,
      poolWaits: 41,
      poolWaitMs: 8.26,
      ledgerBuilds: 2,
      ledgerMs: 900.5,
      baseBuilds: 1,
      baseMs: 610,
      shareJoined: 1,
      authMs: 2.25,
    };
    s.spans.set("sp.cash", 950);
    s.spans.set("bad name!", 1);
    const v = serverTimingValue(s, 1234.56);
    expect(v).toBe(
      'total;dur=1234.6, db;dur=120;desc="41 queries", poolwait;dur=8.3;desc="41 waits", ' +
        'ledger;dur=900.5;desc="2 builds", base400;dur=610;desc="1 build", share;desc="1 joined", auth;dur=2.3, ' +
        "sp.cash;dur=950, bad_name_;dur=1",
    );
    // Every entry: a token, then only dur= numbers and desc= "<count> <word>".
    for (const part of v.split(", ")) {
      expect(part).toMatch(/^[A-Za-z0-9._-]+(;dur=\d+(\.\d)?)?(;desc="\d+ [a-z]+")?$/);
    }
  });
});

/** A response just big enough for the middleware: writeHead, setHeader, events. */
function fakeRes() {
  const em = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    headersSent: boolean;
    statusCode: number;
    setHeader: (k: string, v: string) => void;
    writeHead: (...a: unknown[]) => unknown;
  };
  em.headers = {};
  em.headersSent = false;
  em.statusCode = 200;
  em.setHeader = (k, v) => {
    em.headers[k.toLowerCase()] = v;
  };
  em.writeHead = function () {
    em.headersSent = true;
    return em;
  };
  return em;
}

describe("requestTiming middleware", () => {
  it("opens a store for the request, stamps the header as headers go out, and logs one debug line", async () => {
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { isLevelEnabled: () => true, debug: (obj: object, msg: string) => lines.push({ obj: obj as Record<string, unknown>, msg }) };
    const mw = requestTiming({ log });
    const res = fakeRes();
    const req = { method: "GET", originalUrl: "/api/spine?x=1", url: "/spine?x=1" };
    let seen: RequestTiming | undefined;
    await new Promise<void>((resolve) =>
      mw(req as never, res as never, () => {
        seen = currentTiming();
        // An auth middleware that calls next counts its time.
        timedAuth((_q, _r, next) => {
          setTimeout(() => next(), 5);
        })(req as never, res as never, () => resolve());
      }),
    );
    expect(seen).toBeDefined();
    expect(seen!.authMs).toBeGreaterThan(3);
    res.writeHead(200);
    expect(res.headers["server-timing"]).toMatch(/^total;dur=[\d.]+, db;dur=0;desc="0 queries", .*auth;dur=[\d.]+$/);
    res.emit("finish");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe("request timing");
    expect(lines[0]!.obj).toMatchObject({ timing: { method: "GET", path: "/api/spine", status: 200, queries: 0 } });
  });

  it("logs nothing when debug is off", () => {
    let n = 0;
    const mw = requestTiming({ log: { isLevelEnabled: () => false, debug: () => void (n += 1) } });
    const res = fakeRes();
    mw({ method: "GET", url: "/x" } as never, res as never, () => {});
    res.emit("finish");
    expect(n).toBe(0);
  });
});

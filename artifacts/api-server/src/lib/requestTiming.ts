// ⭐ (PERF-0) WHERE ONE REQUEST'S TIME WENT — measured, always on, cheap.
//
// Every /api request runs inside a small per-request store (AsyncLocalStorage)
// that adds up, for that request only:
//   - db       — time inside `pool.query` once a connection was in hand, and
//                how many queries ran (summed: queries fired together overlap,
//                so the sum can exceed the request's wall time);
//   - poolwait — time spent waiting for the pool to hand out a connection;
//   - ledger   — forecast-ledger builds this request started, and their time
//                (a 90-day build that awaits the weekly avalanche's 400-day base
//                includes the base's time);
//   - base400  — the 400-day base builds among them, and their time;
//   - share    — builds this request JOINED instead of starting
//                (`lib/ledgerShare.ts`; the build counts for its starter);
//   - auth     — time in Clerk's middleware and `requireAuth`;
//   - named spans (`timed()`), e.g. each branch of the spine.
// The response carries it as a `Server-Timing` header (same origin, so the
// browser's resource timing can read it), and one debug log line repeats it.
//
// ⚠️ NO SECRETS AND NO AMOUNTS: only durations, counts and fixed names go in.
// Nothing here reads a figure, and no figure reads anything here.
//
// Attribution: work counts for the request whose async context started it. A
// query issued with no store (a background job) is not counted anywhere. A
// query inside `db.transaction` runs on a checked-out client and is not counted
// (its connect wait is).

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface RequestTiming {
  start: number;
  queries: number;
  dbMs: number;
  poolWaits: number;
  poolWaitMs: number;
  ledgerBuilds: number;
  ledgerMs: number;
  baseBuilds: number;
  baseMs: number;
  shareJoined: number;
  authMs: number;
  /** Named spans in first-seen order (name → summed ms). */
  spans: Map<string, number>;
}

const als = new AsyncLocalStorage<RequestTiming>();

export function newRequestTiming(): RequestTiming {
  return {
    start: performance.now(),
    queries: 0,
    dbMs: 0,
    poolWaits: 0,
    poolWaitMs: 0,
    ledgerBuilds: 0,
    ledgerMs: 0,
    baseBuilds: 0,
    baseMs: 0,
    shareJoined: 0,
    authMs: 0,
    spans: new Map(),
  };
}

/** The current request's store, or undefined outside a request. */
export function currentTiming(): RequestTiming | undefined {
  return als.getStore();
}

/** Run `fn` with `store` as the current request's timing (tests and the middleware). */
export function runWithTiming<T>(store: RequestTiming, fn: () => T): T {
  return als.run(store, fn);
}

/** Add `ms` to a named span of the current request (no-op outside one). */
export function addSpan(name: string, ms: number): void {
  const s = als.getStore();
  if (!s) return;
  s.spans.set(name, (s.spans.get(name) ?? 0) + ms);
}

/**
 * Time a promise as a named span of the current request. The promise itself is
 * returned unchanged in behaviour (same value, same rejection).
 */
export function timed<T>(name: string, p: Promise<T>): Promise<T> {
  const s = als.getStore();
  if (!s) return p;
  const t0 = performance.now();
  const done = () => {
    s.spans.set(name, (s.spans.get(name) ?? 0) + (performance.now() - t0));
  };
  p.then(done, done);
  return p;
}

/** A forecast ledger build started in this request: call the returned function when it settles. */
export function startLedgerBuild(base: boolean): () => void {
  const s = als.getStore();
  if (!s) return () => {};
  const t0 = performance.now();
  if (base) s.baseBuilds += 1;
  else s.ledgerBuilds += 1;
  return () => {
    const ms = performance.now() - t0;
    if (base) s.baseMs += ms;
    else s.ledgerMs += ms;
  };
}

/** This request awaited a build another request started (`shareInFlight`). */
export function noteShareJoined(): void {
  const s = als.getStore();
  if (s) s.shareJoined += 1;
}

/** Add time spent authenticating (Clerk middleware, requireAuth). */
export function addAuthMs(ms: number): void {
  const s = als.getStore();
  if (s) s.authMs += ms;
}

// ── THE POOL ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type QueryRec = { wait: number };
/** Set synchronously while `pool.query` runs its own `connect`, so that wait is known to the query. */
let pendingQuery: QueryRec | null = null;

interface PoolLike {
  query: (...args: unknown[]) => unknown;
  connect: (...args: unknown[]) => unknown;
}
const INSTRUMENTED = Symbol.for("h2.requestTiming.pool");

/**
 * Wrap `pool.query` and `pool.connect` (once per pool) so each request's store
 * learns its query count, query time and connection wait. Outside a request the
 * originals run untouched. Behaviour is unchanged: same arguments, same results,
 * same errors.
 */
export function instrumentPool(pool: object): void {
  const p = pool as PoolLike & { [INSTRUMENTED]?: boolean };
  if (p[INSTRUMENTED]) return;
  p[INSTRUMENTED] = true;
  const origQuery = p.query;
  const origConnect = p.connect;

  p.connect = function (this: unknown, ...args: unknown[]) {
    const s = als.getStore();
    if (!s) return origConnect.apply(this, args);
    const rec = pendingQuery;
    const t0 = performance.now();
    const done = () => {
      const w = performance.now() - t0;
      s.poolWaits += 1;
      s.poolWaitMs += w;
      if (rec) rec.wait = w;
    };
    const cb = args[0];
    if (typeof cb === "function") {
      args[0] = function (this: unknown, ...cbArgs: unknown[]) {
        done();
        return (cb as (...a: unknown[]) => unknown).apply(this, cbArgs);
      };
      return origConnect.apply(this, args);
    }
    const out = origConnect.apply(this, args);
    if (out && typeof (out as Promise<unknown>).then === "function") (out as Promise<unknown>).then(done, done);
    return out;
  };

  p.query = function (this: unknown, ...args: unknown[]) {
    const s = als.getStore();
    if (!s) return origQuery.apply(this, args);
    s.queries += 1;
    const rec: QueryRec = { wait: 0 };
    const t0 = performance.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      s.dbMs += Math.max(0, performance.now() - t0 - rec.wait);
    };
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = function (this: unknown, ...cbArgs: unknown[]) {
        finish();
        return (last as (...a: unknown[]) => unknown).apply(this, cbArgs);
      };
    }
    const prev = pendingQuery;
    pendingQuery = rec;
    let out: unknown;
    try {
      out = origQuery.apply(this, args);
    } finally {
      pendingQuery = prev;
    }
    if (typeof last !== "function" && out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).then(finish, finish);
    }
    return out;
  };
}

// ── THE HEADER ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ms = (n: number) => (Math.round(n * 10) / 10).toString();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A metric name for the header: a token (letters, digits, `.`, `-`, `_`). */
const token = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");

/** The `Server-Timing` value for a store (durations in ms, one decimal). */
export function serverTimingValue(s: RequestTiming, now = performance.now()): string {
  const parts = [
    `total;dur=${ms(now - s.start)}`,
    `db;dur=${ms(s.dbMs)};desc="${plural(s.queries, "query", "queries")}"`,
    `poolwait;dur=${ms(s.poolWaitMs)};desc="${plural(s.poolWaits, "wait", "waits")}"`,
    `ledger;dur=${ms(s.ledgerMs)};desc="${plural(s.ledgerBuilds, "build", "builds")}"`,
    `base400;dur=${ms(s.baseMs)};desc="${plural(s.baseBuilds, "build", "builds")}"`,
    `share;desc="${s.shareJoined} joined"`,
    `auth;dur=${ms(s.authMs)}`,
  ];
  for (const [name, d] of s.spans) parts.push(`${token(name)};dur=${ms(d)}`);
  return parts.join(", ");
}

/** The same figures as a plain object, for the log line. */
export function timingFields(s: RequestTiming, now = performance.now()) {
  return {
    totalMs: Math.round(now - s.start),
    queries: s.queries,
    dbMs: Math.round(s.dbMs),
    poolWaits: s.poolWaits,
    poolWaitMs: Math.round(s.poolWaitMs),
    ledgerBuilds: s.ledgerBuilds,
    ledgerMs: Math.round(s.ledgerMs),
    baseBuilds: s.baseBuilds,
    baseMs: Math.round(s.baseMs),
    shareJoined: s.shareJoined,
    authMs: Math.round(s.authMs),
    ...(s.spans.size ? { spans: Object.fromEntries([...s.spans].map(([k, v]) => [k, Math.round(v)])) } : {}),
  };
}

interface DebugLogger {
  isLevelEnabled?: (level: string) => boolean;
  debug: (obj: object, msg: string) => void;
}

/**
 * The middleware: opens the request's store, sets `Server-Timing` as the
 * headers go out, and logs one debug line when the response finishes. Mount it
 * after the body parsers (a parser's stream callbacks would leave the store
 * behind) and before authentication.
 */
export function requestTiming(opts: { log?: DebugLogger } = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const store = newRequestTiming();
    const origWriteHead = res.writeHead;
    let stamped = false;
    res.writeHead = function (this: Response, ...args: unknown[]) {
      if (!stamped) {
        stamped = true;
        if (!this.headersSent) {
          try {
            this.setHeader("Server-Timing", serverTimingValue(store));
          } catch {
            /* headers already on their way: nothing to add */
          }
        }
      }
      return (origWriteHead as (...a: unknown[]) => Response).apply(this, args);
    } as typeof res.writeHead;
    res.once("finish", () => {
      const log = (req as { log?: DebugLogger }).log ?? opts.log;
      if (!log) return;
      if (log.isLevelEnabled && !log.isLevelEnabled("debug")) return;
      log.debug(
        { timing: { method: req.method, path: (req.originalUrl ?? req.url ?? "").split("?")[0], status: res.statusCode, ...timingFields(store) } },
        "request timing",
      );
    });
    als.run(store, () => next());
  };
}

/** Wrap a middleware so its time counts as `auth` for the request. */
export function timedAuth(mw: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const s = als.getStore();
    if (!s) return mw(req, res, next);
    const t0 = performance.now();
    let noted = false;
    const note = () => {
      if (noted) return;
      noted = true;
      s.authMs += performance.now() - t0;
    };
    // A middleware that answers itself (a refusal) never calls next.
    res.once("finish", note);
    return mw(req, res, (err?: unknown) => {
      note();
      next(err as never);
    });
  };
}

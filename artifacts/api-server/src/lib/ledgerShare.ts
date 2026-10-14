// ⭐ (P2) BUILD THE FORECAST LEDGER ONCE PER MOMENT AND SHARE IT.
//
// One dashboard load used to build the identical 90-day ledger four times at
// once — the spine, `/money/position`, `/forecast/cash-signal` and
// `/amex/summary` each called `computeCashSignalDetailed` with the same inputs —
// and `/amex` three or four times (one summary per band tile). Each build is
// ~40–50 queries through a pool of 8.
//
// This module lets concurrent callers with the SAME inputs await the SAME
// build. It is not a cache:
//   - an entry lives only while its build is running; it is deleted the moment
//     the build settles (success or failure), so the next call builds again;
//   - a rejection is never kept: every waiter of a failed build sees the
//     failure, and the next call starts a fresh build;
//   - nothing is ever served from a build that finished before the call.
//
// THE KEY is every input that can change the result (see `cashSignalShareKey`
// in cashSignal.ts): household, owner, horizon, fromDate and the household's
// today — plus the WRITE GENERATION below.
//
// ⭐ THE WRITE GENERATION — why a read that starts after a write never joins a
// build that started before it. The database is the build's other input. A
// request that writes (any non-GET request under /api, `ledgerWriteFence`)
// bumps the generation when it starts and again when it finishes, and the
// generation is part of the key. So "Mark matched → the page refetches the
// spine" always builds on the new answer, even while an older spine build is
// still running for another tab. Background jobs do not bump it: their writes
// have no caller waiting on them, so a read concurrent with one may see the
// moment just before it — as it would have without sharing.
//
// ⚠️ CALLERS MUST NOT MUTATE A SHARED RESULT. Every consumer was read for it
// (docs/reviews/2026-10-14-p2-share.md). The API tests run with
// `LEDGER_SHARING_FREEZE=1` (vitest.config.ts): every result is deep-frozen, so
// a consumer that writes to it throws in the suite.
//
// Kill switch: `LEDGER_SHARING=off` builds every call on its own, as before.

/** False when `LEDGER_SHARING=off` (read per call, so it can be flipped without a restart in tests). */
export function ledgerSharingEnabled(): boolean {
  return (process.env.LEDGER_SHARING ?? "").trim().toLowerCase() !== "off";
}

let generation = 0;

/** A write started or finished: builds already running are no longer joined. */
export function bumpLedgerGeneration(): void {
  generation += 1;
}

/** The current write generation (part of every share key). */
export function ledgerWriteGeneration(): number {
  return generation;
}

const inFlight = new Map<string, Promise<unknown>>();

/** Counters for tests and the timing harness. No figure reads them. */
export const ledgerShareStats = { started: 0, joined: 0 };

/** Builds running right now (tests: zero once everything settled). */
export function ledgerSharesInFlight(): number {
  return inFlight.size;
}

/**
 * Await the build already running under `key` (in this write generation), or
 * start `build` and let later callers with the same key await it. The entry is
 * removed when the build settles, whatever the outcome.
 */
export function shareInFlight<T>(key: string, build: () => Promise<T>): Promise<T> {
  const fullKey = `${generation}\u0001${key}`;
  const running = inFlight.get(fullKey);
  if (running) {
    ledgerShareStats.joined += 1;
    return running as Promise<T>;
  }
  ledgerShareStats.started += 1;
  const promise = build();
  inFlight.set(fullKey, promise);
  const settle = (): void => {
    if (inFlight.get(fullKey) === promise) inFlight.delete(fullKey);
  };
  // Both arms handled: this bookkeeping chain never surfaces an unhandled
  // rejection. Every waiter gets `promise` itself, and handles its own.
  promise.then(settle, settle);
  return promise;
}

/** True when results are deep-frozen (the API test suite sets it). */
export function ledgerFreezeEnabled(): boolean {
  return process.env.LEDGER_SHARING_FREEZE === "1";
}

const refuse = (what: string) => (): never => {
  throw new TypeError(`A shared forecast ledger result is read-only (${what})`);
};

/**
 * Deep-freeze a shared result so a consumer that writes to it throws. Objects
 * and arrays are frozen; a Map, Set or Date has its mutators replaced by ones
 * that throw (`Object.freeze` alone does not stop `Map.set` or `setDate`).
 * Test-only: called when `LEDGER_SHARING_FREEZE=1`.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  const obj = value as object;
  seen.add(obj);
  if (obj instanceof Map) {
    for (const [k, v] of obj) {
      deepFreeze(k, seen);
      deepFreeze(v, seen);
    }
    for (const m of ["set", "delete", "clear"]) Object.defineProperty(obj, m, { value: refuse(`Map.${m}`) });
  } else if (obj instanceof Set) {
    for (const v of obj) deepFreeze(v, seen);
    for (const m of ["add", "delete", "clear"]) Object.defineProperty(obj, m, { value: refuse(`Set.${m}`) });
  } else if (obj instanceof Date) {
    // Every setter on the prototype chain (a test's mocked Date subclasses the real one).
    for (let proto = Object.getPrototypeOf(obj); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const m of Object.getOwnPropertyNames(proto)) {
        if (m.startsWith("set") && !Object.prototype.hasOwnProperty.call(obj, m)) {
          Object.defineProperty(obj, m, { value: refuse(`Date.${m}`) });
        }
      }
    }
  } else {
    for (const k of Reflect.ownKeys(obj)) deepFreeze((obj as Record<PropertyKey, unknown>)[k], seen);
  }
  return Object.freeze(value);
}

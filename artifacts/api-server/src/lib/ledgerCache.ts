// ⭐ (PERF) THE FORECAST LEDGER'S RESULT CACHE — kept only while the household's data has not moved.
//
// Production runs this service on half a CPU, and one forecast ledger build is
// most of a page's server time. Every page asks for the same few ledgers (the
// 90-day cash signal, the weekly avalanche plan and its 400-day base), so a
// computed one is kept for a while and served again — but ONLY while the
// household's DATA REVISION is the one it was built at.
//
// THE REVISION (lib/db/migrations/0251_household_data_revisions.sql) is a
// number per household that database triggers move on every write to every
// table these builds read, whatever wrote it: a route, the Plaid sync, a job, a
// script. The rules, each tested (ledgerCache.integration.test.ts):
//   - a result is served only at the exact revision it was built at;
//   - the revision is read BEFORE the build reads anything, so a result stored
//     under revision N reflects at least N;
//   - a build is stored only if the revision is still N when it finishes (a
//     write during the build leaves nothing behind);
//   - the key carries the household AND the owner and every other input the
//     build reads (the caller's key: horizon, fromDate, the household's today,
//     the expired-hold rule) plus the hook model switch;
//   - at most MAX_ENTRIES results, none older than MAX_AGE_MS (12 h); storing a newer revision's answer drops the
//     household's older-revision entries;
//   - no triggers in the database (a `drizzle-kit push` dev/test database, or
//     triggers dropped) → no cache: every call builds, as before;
//   - `LEDGER_CACHE=off` → no cache.
// The in-flight sharing (`ledgerShare.ts`) still runs underneath, keyed by the
// revision too, and its write generation still fences HTTP writes.
//
// ⚠️ A cached result is shared by every request that reads it: never mutate it
// (the API suite deep-freezes every shared result, `LEDGER_SHARING_FREEZE=1`).

import { pool } from "@workspace/db";
import { hookObligationsModelOn } from "./everydayHooks";
import { addSpan, noteCacheRead, requestMemo } from "./requestTiming";
import { deepFreeze } from "./ledgerShare";

export const LEDGER_CACHE_MAX_ENTRIES = 64;
/**
 * (PERF) How long an entry may be served while its revision still matches. Correctness is the revision triggers and
 * the key (household, owner, inputs, household day, switches); the age only bounds what a missed trigger could cost.
 * Long, so the first open of a morning finds last evening's (or the re-warm's) answers.
 */
export const LEDGER_CACHE_MAX_AGE_MS = 12 * 3600_000;
/** How long the "are the triggers there?" answer is trusted. */
const TRIGGER_CHECK_MS = 60_000;

/**
 * The tables every cached build reads (forecast ledger, cash signal, weekly
 * plan). The cache runs only when each has its revision triggers;
 * `householdDataRevision.integration.test.ts` fails if a build reads a table
 * outside this list.
 */
export const LEDGER_READ_TABLES = [
  "transactions",
  "forecast_resolutions",
  "forecast_settings",
  "recurring_items",
  "debts",
  "avalanche_settings",
  "allowance_plans",
  "budget_categories",
  "settings",
  "plaid_accounts",
  "plaid_items",
  // Reachable from the builds' modules (bank register, splits, the categorizer's reads), conservatively.
  "transaction_splits",
  "mapping_rules",
  "merchant_aliases",
  "merchant_memory",
  "category_decisions",
  "goals",
  // Who owns the household (the money context reads owner_user_id).
  "households",
] as const;

/** False when `LEDGER_CACHE=off` (read per call). */
export function ledgerCacheEnabled(): boolean {
  return (process.env.LEDGER_CACHE ?? "").trim().toLowerCase() !== "off";
}

let triggersCheckedAt = Number.NEGATIVE_INFINITY;
let triggersCheck: Promise<boolean> | null = null;

async function checkTriggers(): Promise<boolean> {
  try {
    // Each table needs its commit-time (deferred) row trigger, enabled, on the bump function.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT c.relname)::text AS n
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'h2_data_rev_bump' AND t.tgname = 'h2_data_rev_row' AND t.tgenabled <> 'D'
          AND t.tgdeferrable AND t.tginitdeferred
          AND c.relname = ANY($1::text[])
          AND c.relnamespace = to_regnamespace(current_schema())`,
      [LEDGER_READ_TABLES as unknown as string[]],
    );
    return Number(rows[0]?.n ?? 0) === LEDGER_READ_TABLES.length;
  } catch {
    return false;
  }
}

/** True when every table the builds read carries its revision triggers (checked at most once a minute). */
export function revisionTriggersReady(): Promise<boolean> {
  const now = Date.now();
  if (!triggersCheck || now - triggersCheckedAt > TRIGGER_CHECK_MS) {
    triggersCheckedAt = now;
    triggersCheck = checkTriggers();
  }
  return triggersCheck;
}

/** The household's data revision right now (0 before its first write). */
export async function readHouseholdRevision(householdId: string): Promise<number> {
  const { rows } = await pool.query<{ rev: string }>(
    "SELECT rev::text AS rev FROM household_data_revisions WHERE household_id = $1",
    [householdId],
  );
  return Number(rows[0]?.rev ?? 0);
}

/** The revision as this request first read it (GET requests; see `requestMemo`). */
export function householdRevision(householdId: string): Promise<number> {
  return requestMemo(`rev:${householdId}`, () => readHouseholdRevision(householdId));
}

type Entry = { value: unknown; at: number; householdId: string; rev: number };
const entries = new Map<string, Entry>();

/** Counters for tests and the timing harness. No figure reads them. */
export const ledgerCacheStats = { hits: 0, misses: 0, stored: 0, discarded: 0 };

/** Tests only: forget every entry and the trigger check. */
export function _resetLedgerCacheForTests(): void {
  entries.clear();
  triggersCheck = null;
  triggersCheckedAt = Number.NEGATIVE_INFINITY;
  Object.assign(ledgerCacheStats, { hits: 0, misses: 0, stored: 0, discarded: 0 });
}

/** Entries held right now (tests). */
export function ledgerCacheSize(): number {
  return entries.size;
}

/**
 * Serve `kind`/`key` for this household from the cache at the current revision,
 * or `build(rev)` it (rev null = no cache in force) and keep it if the revision
 * did not move meanwhile. `key` must carry every input of the build except the
 * database; it must name the household and the owner.
 */
export async function cachedLedgerRead<T>(
  kind: string,
  householdId: string,
  key: string,
  build: (rev: number | null) => Promise<T>,
): Promise<T> {
  if (!ledgerCacheEnabled() || !(await revisionTriggersReady())) return build(null);
  let rev: number;
  try {
    rev = await householdRevision(householdId);
  } catch {
    return build(null); // no revision to key on: build as if there were no cache
  }
  const full = JSON.stringify([kind, householdId, key, hookObligationsModelOn(), rev]);
  const hit = entries.get(full);
  if (hit) {
    entries.delete(full);
    if (Date.now() - hit.at <= LEDGER_CACHE_MAX_AGE_MS) {
      entries.set(full, hit); // most recently used last
      ledgerCacheStats.hits += 1;
      noteCacheRead(true);
      return hit.value as T;
    }
  }
  ledgerCacheStats.misses += 1;
  noteCacheRead(false);
  const value = await build(rev);
  // Kept only if nothing was written while it was built (a fresh read, never the request's memo).
  const after = await readHouseholdRevision(householdId).catch(() => NaN);
  if (after === rev) {
    // ⭐ Frozen once, as it is kept: every later request shares this object, so a consumer that wrote to it would
    // change the next request's answer. (The API suite freezes every shared result as well.)
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      const f0 = performance.now();
      deepFreeze(value);
      addSpan("cache.freeze", performance.now() - f0);
    }
    // An older revision's answers for this household can never be served again (revisions only rise): let them go.
    for (const [k, e] of entries) if (e.householdId === householdId && e.rev < rev) entries.delete(k);
    entries.set(full, { value, at: Date.now(), householdId, rev });
    ledgerCacheStats.stored += 1;
    while (entries.size > LEDGER_CACHE_MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  } else {
    ledgerCacheStats.discarded += 1;
  }
  return value;
}

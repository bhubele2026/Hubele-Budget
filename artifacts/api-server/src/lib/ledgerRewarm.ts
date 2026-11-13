// ⭐ (PERF) THE LEDGER CACHE RE-WARMED IN THE BACKGROUND — so the first open after a change finds its answers ready.
//
// The ledger cache (lib/ledgerCache.ts) answers a reload in milliseconds, but the first open after ANY change (a
// bank webhook in the night, a Sync, a job, the household's day turning over at midnight, a deploy) used to pay for
// one full build — seconds on production's half CPU. This module builds those answers in the background instead:
//
//   - WHEN: a household's data revision moved and then stayed put for QUIET_MS (a burst of writes is one re-warm);
//     the household's day changed (shortly after midnight, America/Chicago); and once after boot for the recently
//     active households. One household at a time; at most one pass queued per household.
//   - NEVER IN THE WAY: it starts only while no API request is being served, and between its steps it gives up the
//     moment one arrives (it is retried at the next quiet moment). Its queries run at most QUERY_LIMIT at a time on
//     the shared pool, and not at all held back once a live request is in flight (it may be waiting on this build).
//   - EXACT: it calls the very functions GET /spine calls, with the same arguments (`warmSpineReads`), so the keys are
//     the same; every rule of the cache holds (an answer is kept only if the revision did not move while it was built).
//   - `LEDGER_REWARM=off` turns it off. Nothing here computes or changes a figure.

import { pool } from "@workspace/db";
import { householdTodayISO } from "./householdClock";
import { logger } from "./logger";
import { ledgerCacheEnabled, readHouseholdRevision, revisionTriggersReady } from "./ledgerCache";
import { liveRequestsInFlight, newRequestTiming, runWithTiming } from "./requestTiming";

/** Off with `LEDGER_REWARM=off` (or when the cache itself is off). */
export function ledgerRewarmEnabled(): boolean {
  return (process.env.LEDGER_REWARM ?? "").trim().toLowerCase() !== "off" && ledgerCacheEnabled();
}

export const REWARM_POLL_MS = 5_000;
export const REWARM_QUIET_MS = 3_000;
/** Background queries at once (of the pool's 8). */
export const REWARM_QUERY_LIMIT = 2;
/** Boot: the households whose data moved in this many days. */
const ACTIVE_DAYS = 30;
const ACTIVE_MAX = 5;

type Pending = { rev: number; seenAt: number };
type Household = { householdId: string; ownerUserId: string };

const lastRev = new Map<string, number>();
const pending = new Map<string, Pending>();
let lastDay = "";
let running = false;

/** Counters for tests and logs. */
export const rewarmStats = { warmed: 0, aborted: 0, failed: 0, skippedBusy: 0 };

export function _resetRewarmForTests(): void {
  lastRev.clear();
  pending.clear();
  lastDay = "";
  running = false;
  Object.assign(rewarmStats, { warmed: 0, aborted: 0, failed: 0, skippedBusy: 0 });
}

async function ownerOf(householdId: string): Promise<string | null> {
  const { rows } = await pool.query<{ owner_user_id: string }>("SELECT owner_user_id FROM households WHERE id = $1", [householdId]);
  return rows[0]?.owner_user_id ?? null;
}

/** The households whose data moved recently (boot and the day's turn), newest first. */
export async function activeHouseholds(): Promise<Household[]> {
  const { rows } = await pool.query<{ household_id: string; owner_user_id: string }>(
    `SELECT r.household_id, h.owner_user_id
       FROM household_data_revisions r JOIN households h ON h.id = r.household_id
      WHERE r.updated_at > now() - make_interval(days => $1)
      ORDER BY r.updated_at DESC LIMIT $2`,
    [ACTIVE_DAYS, ACTIVE_MAX],
  );
  return rows.map((r) => ({ householdId: r.household_id, ownerUserId: r.owner_user_id }));
}

/**
 * Build what Home reads for this household, as GET /spine asks it, in the background. Gives up between steps when a
 * live request arrives. Returns "warmed", "aborted" (a request arrived) or "busy" (one was already in flight).
 */
export async function warmHousehold(householdId: string, ownerUserId: string): Promise<"warmed" | "aborted" | "busy"> {
  if (liveRequestsInFlight() > 0) {
    rewarmStats.skippedBusy += 1;
    return "busy";
  }
  const { warmSpineReads } = await import("../routes/spine");
  const store = { ...newRequestTiming(), method: "WARM", queryLimit: REWARM_QUERY_LIMIT };
  const t0 = performance.now();
  try {
    await runWithTiming(store, () => warmSpineReads(householdId, ownerUserId, () => liveRequestsInFlight() > 0));
  } catch (err) {
    if ((err as { code?: string }).code === "H2_REWARM_ABORTED") {
      rewarmStats.aborted += 1;
      return "aborted";
    }
    throw err;
  }
  rewarmStats.warmed += 1;
  logger.debug({ rewarm: { householdId, ms: Math.round(performance.now() - t0), queries: store.queries } }, "ledger re-warmed");
  return "warmed";
}

/** Queue a household for a re-warm (its revision as last seen). */
export function queueRewarm(householdId: string, rev: number, now = Date.now()): void {
  pending.set(householdId, { rev, seenAt: now });
}

/**
 * One turn of the loop (the timer calls it; tests call it directly): note moved revisions and a new household day,
 * then re-warm at most ONE household whose revision has been quiet for `quietMs` — when nothing is being served.
 */
export async function rewarmTick(opts: { now?: number; quietMs?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  const quietMs = opts.quietMs ?? REWARM_QUIET_MS;
  if (!ledgerRewarmEnabled() || running || !(await revisionTriggersReady())) return;
  running = true;
  try {
    // 1. Revisions that moved since the last look (any writer: routes, webhooks, jobs, scripts).
    const { rows } = await pool.query<{ household_id: string; rev: string }>(
      "SELECT household_id, rev::text AS rev FROM household_data_revisions WHERE updated_at > now() - interval '1 day'",
    );
    for (const r of rows) {
      const rev = Number(r.rev);
      const seen = lastRev.get(r.household_id);
      if (seen === undefined) lastRev.set(r.household_id, rev);
      else if (rev !== seen) {
        lastRev.set(r.household_id, rev);
        queueRewarm(r.household_id, rev, now); // a newer bump restarts the quiet wait
      }
    }
    // 2. The household's day turned over (just after midnight in America/Chicago): every active household's keys are new.
    const day = householdTodayISO();
    if (lastDay && day !== lastDay) {
      for (const h of await activeHouseholds()) queueRewarm(h.householdId, await readHouseholdRevision(h.householdId), now - quietMs);
    }
    lastDay = day;
    // 3. One quiet household, if nothing is being served.
    for (const [householdId, p] of pending) {
      if (now - p.seenAt < quietMs) continue;
      if (liveRequestsInFlight() > 0) return;
      const owner = await ownerOf(householdId);
      if (!owner) {
        pending.delete(householdId);
        continue;
      }
      try {
        const out = await warmHousehold(householdId, owner);
        if (out === "warmed") pending.delete(householdId);
      } catch (err) {
        rewarmStats.failed += 1;
        pending.delete(householdId);
        logger.warn({ err, householdId }, "ledger re-warm failed (the next open builds as before)");
      }
      return;
    }
  } finally {
    running = false;
  }
}

/** Boot: queue the recently active households, so the first open after a deploy or restart finds its answers. */
export async function queueBootRewarm(): Promise<number> {
  const hs = await activeHouseholds();
  for (const h of hs) queueRewarm(h.householdId, await readHouseholdRevision(h.householdId), 0);
  lastDay = householdTodayISO();
  return hs.length;
}

/** Start the loop (server boot). Returns a stop function. Never throws; logs and keeps serving. */
export function startLedgerRewarm(opts: { pollMs?: number; bootDelayMs?: number } = {}): () => void {
  if (!ledgerRewarmEnabled()) return () => {};
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const loop = async () => {
    if (stopped) return;
    try {
      await rewarmTick();
    } catch (err) {
      logger.warn({ err }, "ledger re-warm tick failed");
    }
    if (!stopped) {
      timer = setTimeout(loop, opts.pollMs ?? REWARM_POLL_MS);
      timer.unref?.();
    }
  };
  timer = setTimeout(async () => {
    try {
      if (await revisionTriggersReady()) await queueBootRewarm();
    } catch (err) {
      logger.warn({ err }, "ledger boot re-warm could not list households");
    }
    void loop();
  }, opts.bootDelayMs ?? 2_000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

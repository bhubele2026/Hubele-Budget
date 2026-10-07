import { PgBoss } from "pg-boss";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { DLQ_SUFFIX } from "./queues";

// (AI-0) The job runner: pg-boss on the app's own Postgres, in its own schema
// (PGBOSS_SCHEMA, default "pgboss") with its own two-connection pool.
//
// JOBS_MODE=on|off. Unset: off under vitest or with no DATABASE_URL, on
// otherwise (so on in production). Off means nothing starts and emit()
// records instead of sending — tests call handlers directly.
//
// startJobs() runs AFTER the server listens and never blocks serving: a
// failure is logged and shown on /api/healthz (jobs.started=false).

export type JobsMode = "on" | "off";

export function getJobsMode(): JobsMode {
  const explicit = process.env.JOBS_MODE?.trim().toLowerCase();
  if (explicit === "on" || explicit === "off") return explicit;
  if (process.env.VITEST || !process.env.DATABASE_URL) return "off";
  return "on";
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** The pg-boss schema; a plain lower-case identifier (it is interpolated into ops SQL). */
export function getPgBossSchema(): string {
  const s = (process.env.PGBOSS_SCHEMA ?? "pgboss").trim();
  if (!SCHEMA_RE.test(s)) {
    throw new Error(`PGBOSS_SCHEMA must match ${SCHEMA_RE} (got "${s}")`);
  }
  return s;
}

interface JobsState {
  boss: PgBoss | null;
  started: boolean;
  startError: string | null;
  startedAt: Date | null;
}

const state: JobsState = { boss: null, started: false, startError: null, startedAt: null };

export function getBoss(): PgBoss | null {
  return state.started ? state.boss : null;
}

export function markJobsFailed(err: unknown): void {
  state.started = false;
  state.startError = err instanceof Error ? err.message : String(err);
}

export async function startJobs(
  register?: (boss: PgBoss) => Promise<void>,
): Promise<{ started: boolean }> {
  if (getJobsMode() === "off") {
    logger.info("Jobs are off (JOBS_MODE=off, test run, or no DATABASE_URL)");
    return { started: false };
  }
  if (state.started || state.boss) return { started: state.started };
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to start jobs");

  const boss = new PgBoss({
    connectionString,
    schema: getPgBossSchema(),
    max: 2,
    application_name: "h2budget-jobs",
    // No OpenTelemetry SDK is registered; skip the no-op spans entirely.
    openTelemetry: { enabled: false },
  });
  // An EventEmitter 'error' with no listener would crash the process.
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  boss.on("warning", (w) => logger.warn({ warning: w }, "pg-boss warning"));
  state.boss = boss;
  try {
    await boss.start();
    const reg = register ?? (await import("./register")).registerJobs;
    await reg(boss);
    state.started = true;
    state.startError = null;
    state.startedAt = new Date();
    logger.info({ schema: getPgBossSchema() }, "Jobs started");
    return { started: true };
  } catch (err) {
    markJobsFailed(err);
    state.boss = null;
    await boss.stop({ graceful: false, close: true, timeout: 1000 }).catch(() => {});
    throw err;
  }
}

export async function stopJobs(
  opts: { graceful?: boolean; timeout?: number } = { graceful: true, timeout: 20_000 },
): Promise<void> {
  const boss = state.boss;
  state.boss = null;
  state.started = false;
  if (!boss) return;
  await boss.stop({ graceful: opts.graceful ?? true, timeout: opts.timeout ?? 20_000, close: true });
  logger.info("Jobs stopped");
}

export interface JobsHealth {
  mode: JobsMode;
  started: boolean;
  /** Jobs that failed for good in the last 24 h; null when it could not be read. */
  failedLast24h: number | null;
  /** Jobs waiting in dead-letter queues; null when it could not be read. */
  dlq: number | null;
}

const HEALTH_CACHE_MS = 30_000;
const HEALTH_QUERY_TIMEOUT_MS = 2_000;
let healthCache: { at: number; failedLast24h: number | null; dlq: number | null } | null = null;

export function _resetJobsHealthCacheForTests(): void {
  healthCache = null;
}

async function readCounts(): Promise<{ failedLast24h: number | null; dlq: number | null }> {
  const schema = getPgBossSchema();
  const exists = await pool.query<{ t: string | null }>("select to_regclass($1) as t", [`${schema}.job`]);
  if (!exists.rows[0]?.t) return { failedLast24h: 0, dlq: 0 };
  const r = await pool.query<{ failed: string; dlq: string }>(
    `select
       count(*) filter (where state = 'failed' and completed_on > now() - interval '24 hours') as failed,
       count(*) filter (where right(name, ${DLQ_SUFFIX.length}) = '${DLQ_SUFFIX}' and state in ('created', 'retry')) as dlq
     from "${schema}".job`,
  );
  return { failedLast24h: Number(r.rows[0]?.failed ?? 0), dlq: Number(r.rows[0]?.dlq ?? 0) };
}

/** Counts for /api/healthz. Never throws, never waits more than ~2 s, cached 30 s. */
export async function getJobsHealth(nowMs: number = Date.now()): Promise<JobsHealth> {
  const mode = getJobsMode();
  const base = { mode, started: state.started };
  if (healthCache && nowMs - healthCache.at < HEALTH_CACHE_MS) {
    return { ...base, failedLast24h: healthCache.failedLast24h, dlq: healthCache.dlq };
  }
  let counts: { failedLast24h: number | null; dlq: number | null } = { failedLast24h: null, dlq: null };
  try {
    let timer: NodeJS.Timeout | undefined;
    counts = await Promise.race([
      readCounts(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("jobs health query timed out")), HEALTH_QUERY_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (err) {
    logger.warn({ err }, "jobs health counts unavailable");
  }
  healthCache = { at: nowMs, ...counts };
  return { ...base, ...counts };
}

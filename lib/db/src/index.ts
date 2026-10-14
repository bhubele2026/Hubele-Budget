import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// (data-integrity guard) Never let an automated test run write to a
// production database. Historically, tests executed against the live app +
// prod DB polluted it with tens of thousands of throwaway households/users.
// If we're clearly under a test runner and DATABASE_URL doesn't look like a
// local/dedicated-test database, refuse to connect. Escape hatch:
// ALLOW_TEST_DB=1 (for the rare intentional case).
const underTestRunner =
  process.env.NODE_ENV === "test" ||
  !!process.env.VITEST ||
  !!process.env.VITEST_WORKER_ID;
const dbUrl = process.env.DATABASE_URL;
const looksLikeTestDb =
  /localhost|127\.0\.0\.1|::1|_test\b|[-_]test(\?|$)|h2budget_test/i.test(dbUrl);
if (underTestRunner && !looksLikeTestDb && process.env.ALLOW_TEST_DB !== "1") {
  throw new Error(
    "Refusing to connect a TEST run to a non-test database (this looks like " +
      "production). Point DATABASE_URL at a local or *_test database, or set " +
      "ALLOW_TEST_DB=1 to override. This guard exists because tests once " +
      "polluted the production database with tens of thousands of phantom rows.",
  );
}

// Bounded pool sized for the Render basic-256mb Postgres: the heavier
// handlers fan out dozens of queries, and pg's default max (10) plus
// no keep-alive left connections churning under concurrent tabs.
/** The pool's connection cap. */
export const POOL_MAX = 8;
/**
 * (P2) How long a query waits for a free connection before it fails. pg's
 * default is to wait forever: a request queued behind a stuck one hung with
 * no error and no log. 10 s is far above any page's slowest read.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: POOL_MAX,
  keepAlive: true,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
});
export const db = drizzle(pool, { schema });

/** (P2) What `watchPoolWaiting` reports. */
export interface PoolPressure {
  /** Queries waiting for a connection. */
  waiting: number;
  /** Connections open (busy + idle). */
  total: number;
  idle: number;
  max: number;
}

/**
 * ⭐ (P2) A cheap signal that the pool is the bottleneck: each time a connection
 * is handed out while other queries still wait for one, `report` is called —
 * at most once per `everyMs`. Nothing is measured when nobody waits. Returns a
 * function that stops watching.
 */
export function watchPoolWaiting(
  report: (pressure: PoolPressure) => void,
  everyMs = 30_000,
  target: Pick<pg.Pool, "on" | "off" | "waitingCount" | "totalCount" | "idleCount"> = pool,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const check = (): void => {
    const waiting = target.waitingCount;
    if (waiting <= 0) return;
    const now = Date.now();
    if (now - last < everyMs) return;
    last = now;
    report({ waiting, total: target.totalCount, idle: target.idleCount, max: POOL_MAX });
  };
  target.on("acquire", check);
  return () => {
    target.off("acquire", check);
  };
}

export * from "./schema";
export * from "./mappingRuleUpsert";

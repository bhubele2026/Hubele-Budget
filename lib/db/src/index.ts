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
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  keepAlive: true,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./mappingRuleUpsert";

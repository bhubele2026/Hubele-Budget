import { runMigrations } from "@workspace/db/migrate";
import { pool } from "@workspace/db";
import app from "./app";
import { migrateOnBootEnabled, startServer } from "./boot";
import { findMigrationsDir } from "./lib/migrationsDir";
import { logger } from "./lib/logger";
import { getPlaidEnv } from "./lib/plaid";
import { markJobsFailed, startJobs, stopJobs } from "./jobs/boss";

// Plaid configuration validation:
//   * In production (NODE_ENV=production) all three of PLAID_CLIENT_ID,
//     PLAID_SECRET, and PLAID_ENV are REQUIRED, and PLAID_ENV must be
//     "production". This is the production cutover guard — we never want
//     a deployed instance to silently serve sandbox data.
//   * In development we only enforce consistency: if the user has set
//     any Plaid var they must set all three (and PLAID_ENV must be a
//     valid value). With nothing set, the server still starts so people
//     can run the app without Plaid for local dev.
const isProd = process.env.NODE_ENV === "production";
const anyPlaid =
  process.env.PLAID_CLIENT_ID || process.env.PLAID_SECRET || process.env.PLAID_ENV;

if (isProd) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET || !process.env.PLAID_ENV) {
    throw new Error(
      "Plaid is not configured for production. PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV are all required when NODE_ENV=production.",
    );
  }
  const env = getPlaidEnv();
  if (env !== "production") {
    throw new Error(
      `Refusing to start: NODE_ENV=production but PLAID_ENV="${env}". Set PLAID_ENV=production for the deployed app.`,
    );
  }
  logger.info({ plaidEnv: env }, "Plaid configured");
  validatePlaidRedirectUri();
} else if (anyPlaid) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    throw new Error(
      "Plaid is partially configured. PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV must all be set together.",
    );
  }
  // Throws if PLAID_ENV is missing or invalid.
  const env = getPlaidEnv();
  logger.info({ plaidEnv: env }, "Plaid configured");
  validatePlaidRedirectUri();
}

/**
 * Plaid requires the URL we send in `linkTokenCreate({ redirect_uri })`
 * to match an entry on the Plaid dashboard's "Allowed redirect URIs"
 * list *exactly*. The H2 Family Budget app's OAuth return route is
 * `/plaid-oauth` (see artifacts/h2budget/src/App.tsx) — if
 * `PLAID_REDIRECT_URI` is set to anything else (e.g. `…/transactions`),
 * non-OAuth banks still work but every OAuth bank silently fails to
 * return to the app. Surface the misconfiguration loudly at boot so it
 * cannot sit silently in production.
 */
function validatePlaidRedirectUri(): void {
  const raw = process.env.PLAID_REDIRECT_URI?.trim();
  if (!raw) return;
  let path = "";
  try {
    path = new URL(raw).pathname.replace(/\/+$/, "");
  } catch {
    logger.warn(
      { plaidRedirectUri: raw },
      "PLAID_REDIRECT_URI is set but not a valid URL — OAuth bank linking will fail",
    );
    return;
  }
  if (path !== "/plaid-oauth") {
    logger.warn(
      { plaidRedirectUri: raw, expectedPath: "/plaid-oauth" },
      "PLAID_REDIRECT_URI does not point at the app's /plaid-oauth route — OAuth banks will silently fail to return to the app. Set this to https://<host>/plaid-oauth and add the same URL to the Plaid dashboard's Allowed redirect URIs.",
    );
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// (PR-0) Pending SQL migrations run BEFORE listen; a failure exits 1 so the
// deploy fails and the old build keeps serving. See boot.ts.
let server: ReturnType<typeof app.listen> | undefined;
await startServer({
  migrateOnBoot: migrateOnBootEnabled(),
  migrate: () =>
    runMigrations({
      databaseUrl: process.env.DATABASE_URL!,
      dir: findMigrationsDir(import.meta.url),
      log: (msg) => logger.info(`[migrate] ${msg}`),
    }),
  listen: () => {
    server = app.listen(port, onListening);
  },
  exit: (code) => process.exit(code),
  log: {
    info: (msg) => logger.info(msg),
    error: (msg, err) => logger.error({ err }, msg),
  },
});

function onListening(err?: Error): void {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Boot does NOTHING but listen, then start the job runner. Every one-shot
  // repair sweep that used to run here (accountSnapshots repair, card-payment
  // reclassify, pending-notes backfill, revolving-Amex auto-link) and every
  // Plaid boot scan (malformed-token flag, malformed-token sibling cleanup,
  // orphan plaid_items cleanup) has been removed: they had been running on
  // every deploy for months against a converged database, so they cost
  // startup latency and PG contention while doing no work. The repairs that
  // still matter run where the data actually changes — `linkRevolvingAmexDebts`
  // on every manual Plaid sync (see lib/plaidLiabilities.ts) and the
  // malformed-token check inside the owner-triggered sync path (see
  // routes/plaid.ts POST /plaid/sync).
  //
  // The automatic Plaid sync crons (hourly cursor sync, */10 forced refresh,
  // daily consent refresh) are gone entirely rather than sitting dead behind a
  // kill-switch: they were hard-disabled in code after Plaid billed the
  // household ~$500 for background pulls. Banks sync ONLY when the owner
  // clicks Sync (POST /plaid/sync, untouched). No job registered in
  // jobs/register.ts may call Plaid.
  //
  // (AI-0) Jobs run on pg-boss (jobs/), started AFTER listen. A failure to
  // start never stops the server serving: it is logged and /api/healthz shows
  // jobs.started=false. The daily plaid_sync_attempts prune (03:47 UTC) moved
  // from node-cron to the `maintenance.prune-sync-attempts` schedule.
  startJobs().catch((jobsErr) => {
    markJobsFailed(jobsErr);
    logger.error({ err: jobsErr }, "Jobs failed to start — serving without them");
  });
}

// Graceful shutdown (Render sends SIGTERM, then SIGKILL ~30 s later): stop
// taking requests, let running jobs finish (up to 20 s), then close the pool.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    if (!server) {
      clearTimeout(timer);
      resolve();
      return;
    }
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections?.();
  });
  try {
    await stopJobs({ graceful: true, timeout: 20_000 });
  } catch (stopErr) {
    logger.error({ err: stopErr }, "Jobs did not stop cleanly");
  }
  try {
    await pool.end();
  } catch (poolErr) {
    logger.error({ err: poolErr }, "Database pool did not close cleanly");
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

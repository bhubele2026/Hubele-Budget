import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import { prunePlaidSyncAttempts } from "./lib/plaidSyncAttempts";
import { getPlaidEnv } from "./lib/plaid";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Boot does NOTHING but listen. Every one-shot repair sweep that used
  // to run here (accountSnapshots repair, card-payment reclassify,
  // pending-notes backfill, revolving-Amex auto-link) and every Plaid
  // boot scan (malformed-token flag, malformed-token sibling cleanup,
  // orphan plaid_items cleanup) has been removed: they had been running
  // on every deploy for months against a converged database, so they
  // cost startup latency and PG contention while doing no work. The
  // repairs that still matter run where the data actually changes —
  // `linkRevolvingAmexDebts` on every manual Plaid sync (see
  // lib/plaidLiabilities.ts) and the malformed-token check inside the
  // owner-triggered sync path (see routes/plaid.ts POST /plaid/sync).
  //
  // The automatic Plaid sync crons (hourly cursor sync, */10 forced
  // refresh, daily consent refresh) are gone entirely rather than
  // sitting dead behind a kill-switch: they were hard-disabled in code
  // after Plaid billed the household ~$500 for background pulls. Banks
  // sync ONLY when the owner clicks Sync (POST /plaid/sync, untouched).
  // Restoring background syncing means writing a Render Cron Job, not
  // flipping a flag here.

  if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
    // (#279) Daily prune of the plaid_sync_attempts audit log so the
    // table stays bounded as users accumulate syncs over months. This
    // is the ONLY scheduled job left in the process — it makes no Plaid
    // API calls and is therefore free. Runs at 03:47 UTC.
    cron.schedule(
      "47 3 * * *",
      () => {
        prunePlaidSyncAttempts()
          .then((deleted) => {
            logger.info(
              { deleted },
              "Daily plaid_sync_attempts prune complete",
            );
          })
          .catch((err) => {
            logger.error(
              { err },
              "Daily plaid_sync_attempts prune failed",
            );
          });
      },
      { timezone: "UTC" },
    );
    logger.info("Plaid daily sync-attempts prune scheduled");
  } else {
    logger.warn(
      "Plaid credentials missing — the daily sync-attempts prune is disabled",
    );
  }
});

import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import {
  refreshConsentExpirationForAllItems,
  syncAllForAllUsers,
} from "./lib/plaidSync";
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
} else if (anyPlaid) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    throw new Error(
      "Plaid is partially configured. PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV must all be set together.",
    );
  }
  // Throws if PLAID_ENV is missing or invalid.
  const env = getPlaidEnv();
  logger.info({ plaidEnv: env }, "Plaid configured");
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

  if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
    cron.schedule("0 * * * *", () => {
      syncAllForAllUsers().catch((err) => {
        logger.error({ err }, "Hourly Plaid sync failed");
      });
    });
    logger.info("Plaid hourly sync scheduled");

    // (#253) Daily consent_expiration_time refresh. The on-sync path only
    // refreshes the cutoff when sync hits PENDING_EXPIRATION /
    // PENDING_DISCONNECT, so a healthy item silently approaching its
    // cutoff (or one whose date Plaid rolled forward after a partial
    // re-consent) can drift. Walking every active item once a day keeps
    // the dated banner copy ("Chase will disconnect on May 21") honest
    // even when the user never opens the app and sync never errors.
    // Runs at 03:17 UTC to avoid colliding with the top-of-hour sync.
    // The explicit `timezone: "UTC"` is important — node-cron defaults to
    // the host's local timezone, which would shift the actual run time
    // depending on where the container is provisioned and silently
    // contradict the 03:17 UTC documented above.
    cron.schedule(
      "17 3 * * *",
      () => {
        refreshConsentExpirationForAllItems()
          .then((summary) => {
            logger.info(
              summary,
              "Daily Plaid consent_expiration_time refresh complete",
            );
          })
          .catch((err) => {
            logger.error(
              { err },
              "Daily Plaid consent_expiration_time refresh failed",
            );
          });
      },
      { timezone: "UTC" },
    );
    logger.info("Plaid daily consent refresh scheduled");
  } else {
    logger.warn("Plaid credentials missing — scheduled sync disabled");
  }
});

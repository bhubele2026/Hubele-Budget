import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import { syncAllForAllUsers } from "./lib/plaidSync";

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
  } else {
    logger.warn("Plaid credentials missing — scheduled sync disabled");
  }
});

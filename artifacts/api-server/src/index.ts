import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import {
  flagMalformedAccessTokens,
  refreshConsentExpirationForAllItems,
  syncAllForAllUsers,
} from "./lib/plaidSync";
import { sendExpirationRemindersForAllUsers } from "./lib/plaidExpirationReminder";
import { maybeAlertOnMalformedTokenSpike } from "./lib/plaidMalformedTokenAlert";
import { backfillMalformedTokenSiblings } from "./lib/plaidMalformedSiblingCleanup";
import { prunePlaidSyncAttempts } from "./lib/plaidSyncAttempts";
import { getPlaidEnv } from "./lib/plaid";
import { runStartupAccountSnapshotsRepair } from "./lib/startupAccountSnapshotsRepair";
import { runStartupAvalancheHealRevert } from "./lib/startupAvalancheHealRevert";
import { runStartupGroceriesRename } from "./lib/startupGroceriesRename";

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
 * cannot sit silently in production. See replit.md → "Plaid OAuth
 * redirect URI" for the canonical setup instructions.
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

  // (#434) One-shot startup pass: walk every user with a non-empty
  // `forecast_settings.accountSnapshots` map and run the dedupe routine
  // so users whose auto-dedupe gate was already stamped before #429
  // (which added the orphan-snapshot prune/salvage) get healed without
  // having to click anything. Idempotent — a clean account is a no-op.
  // Best-effort, fire-and-forget: never blocks boot, never crashes it.
  runStartupAccountSnapshotsRepair()
    .then((summary) => {
      logger.info(
        summary,
        "Startup accountSnapshots repair sweep complete",
      );
    })
    .catch((err) => {
      logger.error({ err }, "Startup accountSnapshots repair sweep failed");
    });

  // One-shot revert: undo the bad `healAvalancheDuplication` auto-migration
  // that ran during the ed23a30..revert window. Restores extra_source='manual'
  // for any user it incorrectly flipped to 'budget_line' so the slider on
  // /avalanche reappears and the Avalanche group on /budget refills.
  runStartupAvalancheHealRevert()
    .then((summary) => {
      logger.info(summary, "Startup avalanche-heal revert complete");
    })
    .catch((err) => {
      logger.error({ err }, "Startup avalanche-heal revert failed");
    });

  // One-shot per-user fix: confirmed in chat that the user's "Weekly Spend"
  // $450/wk bill is actually their groceries + dining budget, not a
  // generic catch-all. Rename it and link it to the Groceries category.
  runStartupGroceriesRename()
    .then((result) => {
      logger.info(result, "Startup groceries rename complete");
    })
    .catch((err) => {
      logger.error({ err }, "Startup groceries rename failed");
    });

  if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
    // (#366) One-shot backfill: flag any pre-existing rows whose stored
    // access_token doesn't match the canonical `access-<env>-<opaque>`
    // shape. Catches legacy rows from earlier env-mismatch incidents
    // and ensures users see the Reconnect CTA on the next page load
    // instead of waiting for the next hourly sync. Best-effort — never
    // crashes boot.
    flagMalformedAccessTokens()
      .then(({ scanned, flagged }) => {
        logger.info(
          { scanned, flagged },
          "Plaid malformed access_token boot scan complete",
        );
      })
      .catch((err) => {
        logger.error({ err }, "Plaid malformed access_token boot scan failed");
      });

    // (#406) One-shot backfill: clean up duplicate "broken Chase"-style
    // rows that pre-date the (#401) inline cleanup in the exchange
    // handler. For each plaid_items row whose stored access_token fails
    // the malformed-token guard AND has a healthy sibling for the same
    // user + same institution, run the same local cleanup the exchange
    // handler now does so existing users no longer have to re-link a
    // third time to clear the stale row from Settings + the dashboard
    // reauth banner. Idempotent — once the duplicates are gone the
    // sweep is a no-op on subsequent boots. Best-effort: never crashes
    // boot, never throws upstream.
    backfillMalformedTokenSiblings()
      .then((summary) => {
        logger.info(
          summary,
          "Plaid malformed-token sibling backfill complete",
        );
      })
      .catch((err) => {
        logger.error(
          { err },
          "Plaid malformed-token sibling backfill failed",
        );
      });

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

    // (#369) Daily malformed access_token sweep. The boot-time scan
    // (`flagMalformedAccessTokens` above) only runs on server restart,
    // and the per-call guards in sync / liabilities / consent refresh
    // only fire when those code paths actually execute. Walking every
    // `plaid_items` row once a day catches a poison token (env mismatch,
    // truncated row, manual DB edit) within 24h instead of "whenever
    // the next sync happens to touch this item" — which surfaces the
    // Reconnect CTA before the user notices a stale balance and lets
    // support spot a sudden jump in flagged items via the daily count
    // log line. Runs at 03:02 UTC, ahead of the 03:17 consent refresh
    // so a freshly flagged item is already in the needs-reconnect state
    // by the time the consent sweep walks it (and short-circuits its
    // own Plaid call). Best-effort — never crashes the cron tick.
    cron.schedule(
      "2 3 * * *",
      () => {
        flagMalformedAccessTokens()
          .then(async (summary) => {
            logger.info(
              { scanned: summary.scanned, flagged: summary.flagged },
              "Daily Plaid malformed access_token sweep complete",
            );
            // (#371) Spike alert: if today's count crosses the operator
            // threshold (default 3 — well above the steady-state "one
            // user mangled their own row" floor), email the operator
            // with the count and a sample of affected institutions so
            // a config-level breakage (env-var swap, bad migration)
            // gets caught the same morning instead of via user
            // complaints. Best-effort — never crashes the cron tick.
            try {
              const alert = await maybeAlertOnMalformedTokenSpike(summary);
              if (alert.channel !== "skipped") {
                logger.info(
                  {
                    channel: alert.channel,
                    recipient: alert.recipient,
                    flagged: summary.flagged,
                  },
                  "Plaid malformed-token spike alert dispatched",
                );
              }
            } catch (err) {
              logger.warn(
                { err },
                "Plaid malformed-token spike alert threw unexpectedly",
              );
            }
          })
          .catch((err) => {
            logger.error(
              { err },
              "Daily Plaid malformed access_token sweep failed",
            );
          });
      },
      { timezone: "UTC" },
    );
    logger.info("Plaid daily malformed access_token sweep scheduled");

    // (#262) Daily disconnect reminder sweep. Walks every active Plaid
    // item across every user, finds those whose consent_expiration_time
    // falls inside the alert window (3 days by default), and emails the
    // owner a "reconnect before <date>" nudge. The in-app expiring-soon
    // alert (#257) only catches users who happen to open the dashboard,
    // so this email closes the gap for users who don't visit for two
    // weeks. De-dup is keyed on (item_id, cutoff) so the same user is
    // never spammed twice for the same cutoff, and a successful
    // re-consent (which rolls the cutoff months out of the window)
    // automatically silences future reminders.
    //
    // Runs at 03:32 UTC — 15 minutes after the consent refresh at 03:17
    // — so the reminder always sees the freshest cutoff Plaid reports.
    cron.schedule(
      "32 3 * * *",
      () => {
        sendExpirationRemindersForAllUsers()
          .then((summary) => {
            logger.info(
              {
                scanned: summary.scanned,
                sent: summary.sent,
                skipped: summary.skipped,
                failed: summary.failed,
              },
              "Daily Plaid disconnect reminder sweep complete",
            );
          })
          .catch((err) => {
            logger.error(
              { err },
              "Daily Plaid disconnect reminder sweep failed",
            );
          });
      },
      { timezone: "UTC" },
    );
    logger.info("Plaid daily disconnect reminder scheduled");

    // (#279) Daily prune of the plaid_sync_attempts audit log so the
    // table stays bounded as users accumulate hourly syncs over months.
    // Runs at 03:47 UTC, well clear of the other daily Plaid jobs so a
    // slow prune doesn't stack on top of them.
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
    logger.warn("Plaid credentials missing — scheduled sync disabled");
  }
});

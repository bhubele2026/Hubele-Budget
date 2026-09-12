import { db } from "@workspace/db";
import {
  refreshAmexAnchor,
  recordAmexAnchorRefreshFailure,
  type AmexAnchorRefreshResult,
} from "./amexAnchor";
import { recordPlaidSyncAttempt } from "./plaidSyncAttempts";
import { logger } from "./logger";

type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AmexAnchorRefreshOutcome =
  | { ok: true; result: AmexAnchorRefreshResult }
  | { ok: false; error: string };

/** The error's message, plus Postgres's own reason when Drizzle wrapped it. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeText = cause instanceof Error && cause.message ? cause.message : null;
  if (causeText && !err.message.includes(causeText)) {
    return `${err.message} — ${causeText}`;
  }
  return err.message || String(err);
}

/**
 * ⭐ The one way the sync and the workbook import refresh the Amex estimate.
 *
 * It used to be `try { … } catch {}` in the sync and bare in the import. The
 * refresh threw on every Plaid Amex household (`ANY(${array})`), the empty catch
 * hid it, and nobody could tell. Now a failure:
 *   - is RECORDED on `settings.preferences.amexAnchor` (`refreshError`,
 *     `refreshFailedAt`) and, from a sync, as a `plaid_sync_attempts` row of kind
 *     `amex_anchor` (Settings → Recent activity), and logged;
 *   - never fails the sync or the import: the refresh runs in its own savepoint,
 *     so a failed statement does not poison a caller's transaction;
 *   - changes no balance — the refresh never writes one.
 *
 * Only failures are written as attempt rows. A success clears the pref's error;
 * an attempt row per Amex sync would halve that item's Recent activity history.
 */
export async function refreshAmexAnchorRecorded(opts: {
  ownerUserId: string;
  exec?: Exec;
  /** Set from a Plaid sync: writes the failure as an attempt row on this item. */
  attempt?: { actorUserId: string; plaidItemId: string };
  context: "plaid-sync" | "plaid-sync-backfill" | "workbook-import";
}): Promise<AmexAnchorRefreshOutcome> {
  const exec = opts.exec ?? db;
  try {
    const result = await exec.transaction((sp) =>
      refreshAmexAnchor(opts.ownerUserId, sp),
    );
    return { ok: true, result };
  } catch (err) {
    const message = errorText(err);
    logger.error(
      { err, ownerUserId: opts.ownerUserId, context: opts.context },
      "Amex estimate refresh failed — recorded; no balance changed",
    );
    try {
      await exec.transaction((sp) =>
        recordAmexAnchorRefreshFailure(opts.ownerUserId, message, sp),
      );
    } catch (recordErr) {
      logger.error(
        { err: recordErr, ownerUserId: opts.ownerUserId, context: opts.context },
        "Could not record the Amex estimate refresh failure on settings",
      );
    }
    if (opts.attempt) {
      await recordPlaidSyncAttempt({
        userId: opts.attempt.actorUserId,
        plaidItemId: opts.attempt.plaidItemId,
        kind: "amex_anchor",
        success: false,
        errorMessage: message.slice(0, 500),
      });
    }
    return { ok: false, error: message };
  }
}

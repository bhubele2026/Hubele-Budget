import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  db,
  plaidItemsTable,
  plaidSyncAttemptsTable,
} from "@workspace/db";
import { logger } from "./logger";

// (#279) Per-item retention cap — the daily prune job keeps at most
// this many rows per Plaid item (newest first). 50 comfortably covers
// the "show last ~20" UI plus a couple of days of hourly history a
// support engineer might want to inspect, without letting the table
// grow unbounded.
export const PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM = 50;

// (#279) Hard cap on the number of rows the GET endpoint returns. The
// task spec calls for "the last ~20 attempts" — keep it small so the
// expander stays responsive even on a flaky bank.
export const PLAID_SYNC_ATTEMPT_LIST_LIMIT = 20;

// (PR-E review) The same failure repeated inside this window updates the row.
export const REPEAT_FAILURE_WINDOW_MS = 60 * 60 * 1000;

export type PlaidSyncAttemptKind =
  | "transactions"
  | "balance"
  | "liabilities"
  // (#733) Audit row written by the vanished-pending sweep (#732)
  // whenever it actually deletes one or more dropped pre-auths.
  // Always written with success=true and a populated cleanupDetails
  // blob; never produced for empty sweeps.
  | "pending_cleanup"
  // (PR-E) A failed Amex estimate refresh (lib/amexAnchorRefresh.ts). Only
  // failures are written; a later success clears the estimate's error on
  // settings.preferences.amexAnchor instead.
  | "amex_anchor";

// (#733) Shape of `cleanupDetails` rows persisted on a
// kind="pending_cleanup" attempt. Mirrors the JSONB blob the schema
// comment documents; kept here so the writer + reader stay in sync.
export type PlaidPendingCleanupItem = {
  description: string | null;
  amount: string;
  occurredOn: string;
  plaidTransactionId: string;
};
export type PlaidPendingCleanupDetails = {
  accountName: string | null;
  plaidAccountId: string;
  count: number;
  totalAmount: string;
  minOccurredOn: string;
  maxOccurredOn: string;
  items: PlaidPendingCleanupItem[];
};

/**
 * (#279) Append a single attempt row. Best-effort: if the insert
 * itself throws (e.g. transient DB blip) we log and swallow so the
 * caller's actual sync flow is never broken by audit-log bookkeeping.
 */
export async function recordPlaidSyncAttempt(opts: {
  userId: string;
  plaidItemId: string;
  kind: PlaidSyncAttemptKind;
  success: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  // (#357) Enriched per-attempt failure metadata, mirrors the structured
  // fields extractPlaidError() returns. All optional — for success rows
  // and pre-#357 callers these stay null.
  plaidDisplayMessage?: string | null;
  requestId?: string | null;
  httpStatus?: number | null;
  errorKind?: string | null;
  // (#733) Per-deletion detail blob — only set for kind="pending_cleanup"
  // rows. See PlaidPendingCleanupDetails for the shape.
  cleanupDetails?: PlaidPendingCleanupDetails | null;
}): Promise<void> {
  try {
    // (PR-E review) A failure identical to the item's newest attempt of the same
    // kind, within the hour, moves that row's timestamp instead of adding one.
    // A failing streak (every GET /debts retries) used to write a row per try
    // and, past PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM, prune away the newest
    // `transactions` / `balance` attempts that bank freshness reads.
    if (!opts.success) {
      const [newest] = await db
        .select({
          id: plaidSyncAttemptsTable.id,
          success: plaidSyncAttemptsTable.success,
          errorCode: plaidSyncAttemptsTable.errorCode,
          errorMessage: plaidSyncAttemptsTable.errorMessage,
          attemptedAt: plaidSyncAttemptsTable.attemptedAt,
        })
        .from(plaidSyncAttemptsTable)
        .where(
          and(
            eq(plaidSyncAttemptsTable.plaidItemId, opts.plaidItemId),
            eq(plaidSyncAttemptsTable.kind, opts.kind),
          ),
        )
        .orderBy(desc(plaidSyncAttemptsTable.attemptedAt))
        .limit(1);
      if (
        newest &&
        !newest.success &&
        (newest.errorCode ?? null) === (opts.errorCode ?? null) &&
        (newest.errorMessage ?? null) === (opts.errorMessage ?? null) &&
        Date.now() - newest.attemptedAt.getTime() < REPEAT_FAILURE_WINDOW_MS
      ) {
        await db
          .update(plaidSyncAttemptsTable)
          .set({
            // The database clock, like the column default: one clock orders the rows.
            attemptedAt: sql`now()`,
            // (PR-E review) Keep what collapsing would lose: how many times it
            // failed and when the streak began. The jsonb column carries the
            // pending-cleanup blob for that kind and is otherwise unused, so no
            // DDL. The expressions read the row's values from before this update.
            cleanupDetails: sql`jsonb_build_object('failureStreak', jsonb_build_object(
              'count', coalesce((${plaidSyncAttemptsTable.cleanupDetails} -> 'failureStreak' ->> 'count')::int, 1) + 1,
              'firstFailedAt', coalesce(
                ${plaidSyncAttemptsTable.cleanupDetails} -> 'failureStreak' ->> 'firstFailedAt',
                to_char(${plaidSyncAttemptsTable.attemptedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              )
            ))`,
            plaidDisplayMessage: opts.plaidDisplayMessage ?? null,
            requestId: opts.requestId ?? null,
            httpStatus: opts.httpStatus ?? null,
            errorKind: opts.errorKind ?? null,
          })
          .where(eq(plaidSyncAttemptsTable.id, newest.id));
        return;
      }
    }
    await db.insert(plaidSyncAttemptsTable).values({
      userId: opts.userId,
      plaidItemId: opts.plaidItemId,
      kind: opts.kind,
      success: opts.success,
      errorCode: opts.errorCode ?? null,
      errorMessage: opts.errorMessage ?? null,
      plaidDisplayMessage: opts.plaidDisplayMessage ?? null,
      requestId: opts.requestId ?? null,
      httpStatus: opts.httpStatus ?? null,
      errorKind: opts.errorKind ?? null,
      cleanupDetails: opts.cleanupDetails ?? null,
    });
  } catch (err) {
    logger.warn(
      {
        err,
        userId: opts.userId,
        plaidItemId: opts.plaidItemId,
        kind: opts.kind,
      },
      "Failed to record plaid sync attempt — continuing",
    );
  }
}

/**
 * (#279) Prune attempt rows so each item keeps at most
 * `PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM` of the most recent attempts.
 * Uses a single SQL DELETE driven by ROW_NUMBER() so the trim is O(1)
 * round-trips per item regardless of how many rows exist.
 *
 * Returns the number of rows deleted (best-effort — this is purely
 * informational for the cron's daily summary log).
 */
export async function prunePlaidSyncAttempts(): Promise<number> {
  const result = await db.execute(sql`
    delete from ${plaidSyncAttemptsTable}
    where id in (
      select id from (
        select id, row_number() over (
          partition by ${plaidSyncAttemptsTable.plaidItemId}
          order by ${plaidSyncAttemptsTable.attemptedAt} desc, id desc
        ) as rn
        from ${plaidSyncAttemptsTable}
      ) ranked
      where rn > ${PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM}
    )
  `);
  // node-postgres reports the affected row count on `rowCount`. The
  // drizzle wrapper passes that through unchanged.
  const rc = (result as unknown as { rowCount?: number | null }).rowCount;
  return typeof rc === "number" ? rc : 0;
}

/**
 * (#279) Fetch the most recent attempts for a single item, newest
 * first. The caller must already have verified the item belongs to the
 * caller's HOUSEHOLD. (PR-E review) Scoped by item, not by who wrote the
 * row: a sync a household member ran — including a failed Amex estimate
 * refresh — is shown to the owner too.
 */
export async function listRecentSyncAttempts(
  plaidItemId: string,
  limit: number = PLAID_SYNC_ATTEMPT_LIST_LIMIT,
): Promise<
  Array<{
    id: string;
    attemptedAt: string;
    kind: string;
    success: boolean;
    errorCode: string | null;
    errorMessage: string | null;
    plaidDisplayMessage: string | null;
    requestId: string | null;
    httpStatus: number | null;
    errorKind: string | null;
    cleanupDetails: PlaidPendingCleanupDetails | null;
  }>
> {
  const rows = await db
    .select()
    .from(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.plaidItemId, plaidItemId))
    .orderBy(sql`${plaidSyncAttemptsTable.attemptedAt} desc`)
    .limit(limit);
  return rows.map((r) => {
    const streak =
      r.kind !== "pending_cleanup" && !r.success
        ? ((r.cleanupDetails as { failureStreak?: { count?: number; firstFailedAt?: string } } | null)
            ?.failureStreak ?? null)
        : null;
    return shapeAttempt(r, streak);
  });
}

function shapeAttempt(
  r: typeof plaidSyncAttemptsTable.$inferSelect,
  streak: { count?: number; firstFailedAt?: string } | null,
) {
  return {
    // (PR-E review) A failure streak collapsed into one row keeps its size and
    // start: 1 and this row's time when it never repeated. Null on successes.
    failureCount: r.success ? null : (streak?.count ?? 1),
    firstFailedAt: r.success
      ? null
      : (streak?.firstFailedAt ?? r.attemptedAt.toISOString()),
    id: r.id,
    attemptedAt: r.attemptedAt.toISOString(),
    kind: r.kind,
    success: r.success,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    // (#357) Enriched per-attempt fields surfaced to Settings → Recent
    // activity so a historical failure row carries the same plain-English
    // reason + Reconnect CTA the live toast does.
    plaidDisplayMessage: r.plaidDisplayMessage,
    requestId: r.requestId,
    httpStatus: r.httpStatus,
    errorKind: r.errorKind,
    // (#733) Vanished-pending sweep audit blob. Null for every kind
    // other than "pending_cleanup".
    cleanupDetails:
      r.kind === "pending_cleanup"
        ? ((r.cleanupDetails as PlaidPendingCleanupDetails | null) ?? null)
        : null,
  };
}

// Silence unused-import warnings if the helpers above happen to not
// use one of these in a future refactor.
void plaidItemsTable;
void lt;

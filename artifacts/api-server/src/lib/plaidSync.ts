import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  householdsTable,
  plaidItemsTable,
  plaidAccountsTable,
  transactionsTable,
  forecastSettingsTable,
  forecastResolutionsTable,
  recurringItemsTable,
} from "@workspace/db";
import {
  plaid,
  institutionSlug,
  isValidPlaidAccessToken,
  isAccessTokenForCurrentEnv,
  isSyntheticPlaidItem,
  MALFORMED_PLAID_TOKEN_MESSAGE,
  ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
  type PlaidTxn,
} from "./plaid";
import { loadUserRules, categorize } from "./autoCategorize";
import { expandItem, parseISO, addDays, fmtISO } from "./cashSignal";
import {
  dedupeTransactionsForAccount,
  dedupeTransactionsAcrossAccountsForUser,
} from "./dedupeTransactions";
import { refreshAmexAnchor } from "./amexAnchor";
import { logger } from "./logger";
import {
  recordPlaidSyncAttempt,
  type PlaidPendingCleanupDetails,
  type PlaidPendingCleanupItem,
} from "./plaidSyncAttempts";
import { PLAID_REAUTH_ERROR_CODES } from "./plaidReauthCodes";

/**
 * (#760, Phase A) Master kill-switch for the post-sync auto-match block
 * that pairs newly-inserted checking transactions with planned recurring
 * items and inserts `forecast_resolutions` rows with `status='matched'`
 * on the user's behalf. Set to `false` so the workflow overhaul (manual
 * Send-to-Review gate, lingering past-due plans, weekly Debrief) can land
 * on top of an "every match is an explicit user click" baseline. The
 * underlying matching logic is preserved verbatim behind this gate — a
 * later phase may reintroduce it as an explicit user-toggled "AI auto-
 * match" feature, at which point this becomes a per-household setting.
 * Client-side suggestion engines (forecastMatch.ts: pickConfidentBank-
 * Matches / suggestPlanMatchesForBank / rankPlansForBank) are intentionally
 * unaffected — they only render "Match to…" options, never write.
 */
const AUTO_MATCH_ENABLED = false;

/**
 * (#357) Categorical classification of a Plaid failure used by the frontend
 * to decide which CTA to surface (Reconnect vs. retry vs. wait). Computed
 * server-side so the toast/banner copy stays in sync across web and mobile
 * clients without each having to maintain its own code-to-kind table.
 *
 *   * `reauth`           — needs Plaid Link in update mode (login expired,
 *                          consent expiring/disconnecting).
 *   * `rate_limit`       — Plaid throttled us; user just needs to wait.
 *   * `institution_down` — Plaid couldn't reach the bank (transient
 *                          institution-side outage).
 *   * `transient`        — PRODUCT_NOT_READY / 5xx — retry shortly.
 *   * `unknown`          — anything else (no actionable CTA).
 */
export type PlaidErrorKind =
  | "reauth"
  | "rate_limit"
  | "institution_down"
  | "transient"
  | "unknown";

export function derivePlaidErrorKind(
  code: string | null,
  status: number | null,
): PlaidErrorKind {
  if (code && PLAID_REAUTH_ERROR_CODES.has(code)) return "reauth";
  if (code && code.startsWith("RATE_LIMIT")) return "rate_limit";
  if (
    code === "INSTITUTION_DOWN" ||
    code === "INSTITUTION_NOT_RESPONDING" ||
    code === "INSTITUTION_NOT_AVAILABLE" ||
    code === "INSTITUTION_NO_LONGER_SUPPORTED"
  ) {
    return "institution_down";
  }
  if (
    code === "PRODUCT_NOT_READY" ||
    code === "INTERNAL_SERVER_ERROR" ||
    code === "PLANNED_MAINTENANCE" ||
    (typeof status === "number" && status >= 500)
  ) {
    return "transient";
  }
  return "unknown";
}

export type RuleAttribution = {
  ruleId: string;
  pattern: string;
  count: number;
};

export type SyncResult = {
  itemId: string;
  // (#357) Row id (`plaid_items.id`) of this item — the value the
  // /plaid/link-token/update endpoint expects when the client wants to
  // open Plaid Link in update mode for the failing bank. The external
  // `itemId` above is Plaid's identifier and is NOT what update-mode
  // routes accept, so we surface both.
  plaidItemRowId: string;
  institutionName: string | null;
  added: number;
  modified: number;
  removed: number;
  autoCategorized: number;
  // (#357) Structured error fields parallel to `error`. Populated only on
  // failure so the client can render an actionable toast/banner without
  // leaking raw axios strings ("Request failed with status code 400")
  // and without the frontend having to re-derive what to do.
  //   * plaidErrorCode    — Plaid's structured `error_code`
  //   * plaidErrorMessage — Plaid's `error_message`
  //   * plaidDisplayMessage — Plaid's `display_message` (user-friendly)
  //   * requestId          — Plaid's `request_id` (for support triage)
  //   * httpStatus         — HTTP status returned by Plaid
  //   * kind               — categorical bucket: reauth | rate_limit |
  //                          institution_down | transient | unknown
  plaidErrorCode?: string | null;
  plaidErrorMessage?: string | null;
  plaidDisplayMessage?: string | null;
  requestId?: string | null;
  httpStatus?: number | null;
  kind?: PlaidErrorKind | null;
  // Per-rule attribution breakdown for *newly added* rows that landed in a
  // category via the user's mapping_rules (i.e. one entry per winning rule,
  // sorted by count descending). Used by the frontend to surface a summary
  // toast like "Auto-categorized 12 new transactions: 5 via 'STARBUCKS', 4
  // via 'AMAZON', …" with a "View" link to the Mapping Rules page so users
  // notice when a stale rule is mis-routing a chunk of their feed.
  // Modified rows are intentionally excluded — Plaid surfaces them when
  // metadata changes upstream, not when their categorization first fired.
  ruleAttributions: RuleAttribution[];
  error: string | null;
  // True when Plaid responded with PRODUCT_NOT_READY (a freshly linked item
  // whose historical batch is still being staged). Treated as a transient,
  // non-destructive state by the frontend.
  stillPreparing?: boolean;
  // (#403) Date range (YYYY-MM-DD) covering the rows actually inserted
  // by this sync — `min` is the oldest occurredOn, `max` the newest.
  // Null when nothing was inserted (zero added). Surfaced in the
  // post-link "Ready — N added" panel so users can see at a glance
  // whether their *current* month landed or whether only historical
  // rows came back, and so the panel can show a "still importing
  // recent activity" hint when the max date isn't current-month.
  importedDateRange?: { min: string; max: string } | null;
  // (#402) Most recent occurredOn (YYYY-MM-DD) across rows touched by this
  // sync — i.e. the max over `added ∪ modified`. Lets the post-link
  // progress panel deep-link "View imported transactions" straight to the
  // month that actually contains the freshly-imported rows for the
  // just-linked item, instead of having the client fall back to a global
  // "most recent transaction" lookup that can point at an unrelated
  // newer charge from a different bank. Null when this run touched no
  // rows (or on the failure / still-preparing branches).
  lastOccurredOn?: string | null;
  // (#662) Number of `added` rows that were silently dropped by the
  // first-sync import-cutoff gate (`firstSyncCompletedAt is null` AND
  // `t.date <= importCutoffDate`). Surfaced so the UI can distinguish
  // "0 added — genuinely caught up" from "0 added — N rows filtered
  // by the gate", and so log-based observability catches future
  // regressions where pending or otherwise-live rows get filtered.
  // Pending rows are no longer gated (#662), so this counts only
  // posted backfill below the cutoff on accounts that haven't
  // completed their first sync yet. Always present (0 when nothing
  // was skipped); kept optional in the type for compatibility with
  // synthesized failure results that never reach the sync loop.
  skippedPreCutoff?: number;
  // (#665) True when this sync attempted a `/transactions/refresh`
  // call before the cursor sync to force Plaid to re-fetch from the
  // institution. Set on user-triggered syncs (manual Sync button,
  // post-relink first sync, admin cursor reset, LOGIN_REPAIRED
  // webhook) so newly-authorized pending charges land in one click
  // instead of waiting hours for Plaid's scheduled poll. Best-effort:
  // a refresh that throws (PRODUCT_NOT_READY, rate limit, etc.) still
  // sets this true since the attempt was made — the cursor sync that
  // followed proceeded with whatever Plaid had cached.
  refreshAttempted?: boolean;
  // (#723) Set when this sync's `/transactions/refresh` call was
  // skipped or rejected because the Plaid client isn't authorized for
  // the `transactions_refresh` add-on (INVALID_PRODUCT, or the
  // `refreshProductDisabledAt` short-circuit kicked in). The UI uses
  // this to swap the misleading "your bank is still preparing the
  // initial batch" toast for the honest "real-time refresh isn't
  // enabled on your Plaid plan — Plaid's ~6 h scheduled poll is the
  // only source of new pending data" copy. `null`/absent means the
  // refresh path either ran cleanly or wasn't attempted on this sync.
  refreshDisabledReason?: string | null;
  // (#723) Prior `lastSyncedAt` (ISO-8601) — the timestamp of the
  // sync run that wrote the data the user is currently looking at,
  // not the timestamp of this run. Lets the honest refresh-disabled
  // toast anchor staleness ("Data is current as of 4h ago") so the
  // user can see at a glance why clicking Sync again won't surface
  // anything new yet. Null on the first-ever sync for an item.
  lastSyncedAt?: string | null;
  // (#720) Which Plaid path delivered the rows this sync produced.
  //   * "cursor"       — /transactions/sync returned the rows (normal path)
  //   * "gap-backfill" — cursor came back empty/stale and the
  //                      /transactions/get gap-backfill fallback landed
  //                      one or more new rows. Toast surfaces this so
  //                      the user can see *why* a previously-stuck
  //                      Sync now caught up.
  deliveryMode?: "cursor" | "gap-backfill";
  // (#728) Top-N descriptions of rows this sync actually added (from
  // Plaid's `added` array, capped at 5). The post-sync toast names a
  // few rows so the user can recognize what landed — far more useful
  // than the bare "Added N" count, which trained users to ignore the
  // toast. Empty when the sync added nothing (cursor was caught up).
  addedDescriptions?: string[];
};

type PlaidErrorBody = {
  error_code?: string;
  error_message?: string;
  error_type?: string;
  display_message?: string;
  request_id?: string;
};

export type ExtractedPlaidError = {
  code: string | null;
  message: string;
  displayMessage: string | null;
  requestId: string | null;
  httpStatus: number | null;
  kind: PlaidErrorKind;
};

/**
 * Pull Plaid's structured error_code / error_message out of an axios-shaped
 * error. The Plaid SDK throws axios errors whose `response.data` carries the
 * structured details we want to surface to users — falling back to the raw
 * `e.message` (e.g. "Request failed with status code 400") strips that info.
 *
 * (#357) Also returns Plaid's `display_message`, `request_id`, the HTTP
 * status, and a derived `kind` so the per-item error the frontend
 * renders includes everything support needs to triage without forcing
 * each call site to dig into axios shapes themselves.
 */
export function extractPlaidError(e: unknown): ExtractedPlaidError {
  const ax = e as {
    response?: { status?: number; data?: PlaidErrorBody };
  };
  const body = ax?.response?.data;
  const code = body?.error_code ?? null;
  const plaidMsg = body?.error_message;
  const displayMessage = body?.display_message ?? null;
  const requestId = body?.request_id ?? null;
  const status =
    typeof ax?.response?.status === "number" ? ax.response.status : null;
  const kind = derivePlaidErrorKind(code, status);

  let message: string;
  if (plaidMsg) {
    message = plaidMsg;
  } else if (status !== null) {
    // When Plaid returned an HTTP error but no structured body fields
    // (or only an error_code, no error_message), synthesize a friendly
    // message instead of leaking the bare axios "Request failed with
    // status code 400" string into user-visible sync error chips.
    message = code
      ? `Plaid returned ${status}: ${code}`
      : `Plaid returned ${status}: unknown error`;
  } else {
    // (#357) No HTTP response at all (network reset, DNS, axios pre-flight
    // failure, non-Error throw). ALWAYS use a generic reachability message
    // here — never leak the raw underlying string into a user-visible
    // chip / toast. The original error is still available in structured
    // logs via plaidLogContext() for support triage.
    message = "Couldn't reach Plaid — please try again.";
  }

  return { code, message, displayMessage, requestId, httpStatus: status, kind };
}

/**
 * Build a structured log context for a failed Plaid API call. Captures
 * the HTTP status, Plaid `request_id`, `error_code`, and the endpoint
 * name so we can root-cause Plaid 4xx/5xx incidents from server logs
 * alone without a second round trip to Plaid support.
 */
export function plaidLogContext(
  e: unknown,
  endpoint: string,
): Record<string, unknown> {
  const ax = e as {
    response?: {
      status?: number;
      data?: {
        request_id?: string;
        error_code?: string;
        error_message?: string;
        error_type?: string;
      };
    };
  };
  return {
    plaidEndpoint: endpoint,
    plaidStatus: ax?.response?.status,
    plaidRequestId: ax?.response?.data?.request_id,
    plaidErrorCode: ax?.response?.data?.error_code,
    plaidErrorType: ax?.response?.data?.error_type,
    plaidErrorMessage: ax?.response?.data?.error_message,
  };
}

/**
 * (#366) Persist the synthetic "needs reconnect" state for an item whose
 * stored access token failed `isValidPlaidAccessToken`. Re-uses
 * `ITEM_LOGIN_REQUIRED` so the existing reauth banner / Settings chip /
 * Reconnect button (all gated on `PLAID_REAUTH_ERROR_CODES`) light up
 * exactly the same way they would if Plaid itself had returned the code.
 *
 * Returns the persisted columns so callers can fold them into the
 * SyncResult without re-querying the row.
 */
export async function markItemMalformedToken(
  itemRowId: string,
  overrides: { code?: string; message?: string } = {},
): Promise<{ lastSyncError: string; lastSyncErrorCode: string }> {
  const lastSyncError = overrides.message ?? MALFORMED_PLAID_TOKEN_MESSAGE;
  const lastSyncErrorCode = overrides.code ?? "ITEM_LOGIN_REQUIRED";
  await db
    .update(plaidItemsTable)
    .set({ lastSyncError, lastSyncErrorCode })
    .where(eq(plaidItemsTable.id, itemRowId));
  return { lastSyncError, lastSyncErrorCode };
}

/**
 * (#366) Build the SyncResult that {sync,refresh}-style callers return
 * when the guard short-circuits. Same shape as the Plaid-error catch
 * branch so downstream consumers (web toast, mobile, recordPlaidSyncAttempt
 * audit) can render it without a special case.
 */
export function synthesizeMalformedTokenSyncResult(
  item: {
    id: string;
    itemId: string;
    institutionName: string | null;
  },
  overrides: { code?: string; message?: string } = {},
): SyncResult {
  const message = overrides.message ?? MALFORMED_PLAID_TOKEN_MESSAGE;
  const code = overrides.code ?? "ITEM_LOGIN_REQUIRED";
  return {
    itemId: item.itemId,
    plaidItemRowId: item.id,
    institutionName: item.institutionName,
    added: 0,
    modified: 0,
    removed: 0,
    autoCategorized: 0,
    ruleAttributions: [],
    error: message,
    plaidErrorCode: code,
    plaidErrorMessage: message,
    plaidDisplayMessage: message,
    requestId: null,
    httpStatus: null,
    kind: "reauth",
  };
}

function plaidAmountToSigned(t: PlaidTxn): string {
  // Plaid: positive = money out (debit). We use negative = spend.
  const n = Number(t.amount ?? 0);
  return (-n).toFixed(2);
}

/**
 * (#623) `userId` is the ACTOR (signed-in user, used for audit columns
 * on inserts and `recordPlaidSyncAttempt`). Data scope is derived from
 * the item itself: `householdId = item.householdId` for shared tables,
 * `ownerUserId` (looked up from `households`) for settings tables that
 * remain singletons-by-owner. The lookup intentionally does NOT scope
 * by actor — a household member must be able to sync items linked by
 * any other member of the same household.
 */
/**
 * (#732) Reconcile locally-stored pending Plaid rows for a single
 * account against the set of pending `plaid_transaction_id`s Plaid
 * actually surfaced in this sync's response. Any local pending row
 * whose id is NOT in `currentPendingIds` and whose `occurred_on` falls
 * inside the scoped window is treated as a vanished pre-authorization
 * (e.g. Metro's pre-delivery hold) and deleted.
 *
 * Why this exists:
 *   * Plaid's cursor `removed` event is not reliably emitted when an
 *     authorization drops without ever posting under its own
 *     transaction_id — the merchant just re-bills with a fresh id at
 *     delivery time and the original hold silently disappears.
 *   * Our /transactions/get gap-backfill path is insert/update only —
 *     nothing in it has ever deleted rows that stopped appearing.
 *
 * Without this sweep, the orphaned pending stays on the ledger forever,
 * inflating spend totals and the Amex anchor balance.
 *
 * Scope rules:
 *   * Only `pending=true` rows tied to a Plaid account are eligible
 *     (manual entries and posted Plaid rows are never touched).
 *   * Bounded by `windowStart` (and optionally `windowEnd`) so a
 *     pending we never asked Plaid about doesn't get swept.
 *   * If Plaid returned no pendings AND no explicit `windowStart` is
 *     supplied (cursor path with an empty pending delta), the floor is
 *     computed from the oldest local pending — that's exactly the
 *     "everything Plaid silently dropped" case.
 *
 * Before deleting transactions, we drop any `forecast_resolutions`
 * rows that pointed at the doomed ids so we don't leave dangling
 * matched-resolution rows behind.
 */
async function reconcileVanishedPendings(opts: {
  householdId: string;
  userId: string;
  itemRowId: string;
  plaidAccountId: string;
  currentPendingIds: Set<string>;
  windowStart: string | null;
  windowEnd: string | null;
}): Promise<number> {
  const {
    householdId,
    userId,
    itemRowId,
    plaidAccountId,
    currentPendingIds,
    windowEnd,
  } = opts;
  let windowStart = opts.windowStart;
  if (windowStart == null) {
    const [oldest] = await db
      .select({ occurredOn: transactionsTable.occurredOn })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          eq(transactionsTable.plaidAccountId, plaidAccountId),
          eq(transactionsTable.pending, true),
        ),
      )
      .orderBy(sql`${transactionsTable.occurredOn} asc`)
      .limit(1);
    windowStart = oldest?.occurredOn ?? null;
  }
  if (windowStart == null) return 0;
  const conditions = [
    eq(transactionsTable.householdId, householdId),
    eq(transactionsTable.plaidAccountId, plaidAccountId),
    eq(transactionsTable.pending, true),
    sql`${transactionsTable.plaidTransactionId} is not null`,
    sql`${transactionsTable.occurredOn} >= ${windowStart}`,
    // Never sweep a pending row the user has already worked (categorized /
    // bucketed / reviewed / manually overridden) — mirror the orphan-prune
    // guard. A vanished pre-auth the user cared about stays put rather than
    // taking their manual work with it.
    sql`${transactionsTable.categoryId} is null`,
    eq(transactionsTable.weeklyAllowance, false),
    eq(transactionsTable.monthlyAllowance, false),
    eq(transactionsTable.unplannedAllowance, false),
    eq(transactionsTable.reviewed, false),
    eq(transactionsTable.isTransferUserOverridden, false),
    eq(transactionsTable.occurredOnUserOverridden, false),
  ];
  if (windowEnd) {
    conditions.push(sql`${transactionsTable.occurredOn} <= ${windowEnd}`);
  }
  if (currentPendingIds.size > 0) {
    conditions.push(
      sql`${transactionsTable.plaidTransactionId} not in (${sql.join(
        Array.from(currentPendingIds).map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  const doomed = await db
    .select({
      id: transactionsTable.id,
      plaidTransactionId: transactionsTable.plaidTransactionId,
      description: transactionsTable.description,
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
    })
    .from(transactionsTable)
    .where(and(...conditions));
  if (doomed.length === 0) return 0;
  const doomedIds = doomed.map((d) => d.id);
  await db
    .delete(forecastResolutionsTable)
    .where(inArray(forecastResolutionsTable.matchedTxnId, doomedIds));
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.id, doomedIds));
  for (const d of doomed) {
    logger.info(
      {
        householdId,
        itemRowId,
        plaidAccountId,
        plaidTransactionId: d.plaidTransactionId,
        occurredOn: d.occurredOn,
        amount: d.amount,
      },
      "[plaid-sync] (#732) vanished pending swept — Plaid no longer reports this pending row",
    );
  }
  // (#733) Audit row in Settings → Recent activity so users who
  // notice a pre-auth disappear from their ledger have a breadcrumb
  // explaining why. Best-effort: writing this row must never block
  // or roll back the deletions that already succeeded above.
  try {
    const [acct] = await db
      .select({ name: plaidAccountsTable.name })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.accountId, plaidAccountId))
      .limit(1);
    const items: PlaidPendingCleanupItem[] = doomed.map((d) => ({
      description: d.description ?? null,
      amount: String(d.amount ?? "0"),
      occurredOn: d.occurredOn,
      plaidTransactionId: d.plaidTransactionId ?? "",
    }));
    // Sum the (negative-for-credit-card-charges) numeric strings as
    // dollars-and-cents so the summary line shows the magnitude of
    // dropped pre-auths without losing precision to FP rounding.
    let totalCents = 0;
    for (const it of items) {
      const cents = Math.round(parseFloat(it.amount) * 100);
      if (Number.isFinite(cents)) totalCents += cents;
    }
    const totalAmount = (totalCents / 100).toFixed(2);
    const dates = items.map((i) => i.occurredOn).sort();
    const cleanupDetails: PlaidPendingCleanupDetails = {
      accountName: acct?.name ?? null,
      plaidAccountId,
      count: items.length,
      totalAmount,
      minOccurredOn: dates[0]!,
      maxOccurredOn: dates[dates.length - 1]!,
      items,
    };
    const accountLabel = acct?.name ?? "this account";
    const dateRange =
      cleanupDetails.minOccurredOn === cleanupDetails.maxOccurredOn
        ? cleanupDetails.minOccurredOn
        : `${cleanupDetails.minOccurredOn} – ${cleanupDetails.maxOccurredOn}`;
    const noun =
      items.length === 1 ? "dropped pending charge" : "dropped pending charges";
    // Pre-auths on credit cards arrive as negative amounts; show the
    // magnitude in the summary line so the user reads it as "we
    // tidied $42.18 of charges" rather than the surprising "-$42.18".
    const totalDisplay = Math.abs(totalCents / 100).toFixed(2);
    const summary = `Cleared ${items.length} ${noun} from ${accountLabel} — totaling $${totalDisplay} (${dateRange}).`;
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "pending_cleanup",
      success: true,
      errorMessage: summary,
      cleanupDetails,
    });
  } catch (auditErr) {
    logger.warn(
      { err: auditErr, householdId, itemRowId, plaidAccountId },
      "[plaid-sync] (#733) failed to record vanished-pending cleanup audit row (deletions still applied)",
    );
  }
  return doomed.length;
}

export async function syncPlaidItem(
  userId: string,
  itemRowId: string,
  opts: {
    forceRefresh?: boolean;
    syncOrigin?: "manual" | "webhook" | "cron" | "internal";
  } = {},
): Promise<SyncResult> {
  // (#665) `forceRefresh` triggers a `/transactions/refresh` call below
  // (right before the cursor sync loop) so Plaid re-fetches from the
  // institution before we read. Manual user-driven sync paths should
  // pass true; webhook/cron paths should leave it false to avoid
  // billing the premium endpoint on every coalesced sync.
  const forceRefresh = opts.forceRefresh === true;
  // (#720) `syncOrigin` is the *real* user-initiated gate for the
  // stale-cursor gap-backfill below. We can't reuse forceRefresh for
  // that gate because the webhook `ITEM/LOGIN_REPAIRED` handler also
  // passes forceRefresh:true (it wants the post-relink first sync to
  // walk fresh data), and we must NOT have that webhook path
  // additionally fall through to /transactions/get on an empty delta.
  // Default to "webhook" so callers that haven't been audited stay on
  // the conservative side and never accidentally trip the fallback.
  const syncOrigin: "manual" | "webhook" | "cron" | "internal" =
    opts.syncOrigin ?? "webhook";
  // (#671) Function-scoped so the failure-path delivery-metrics log
  // in the wrapping catch can still reference whether the refresh
  // fired and how many cursor walks burned before we threw.
  let refreshSucceeded = false;
  let pollAttemptsUsed = 0;
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.id, itemRowId));
  // (#408) Capture pre-call health so a sync that successfully heals an
  // error→healthy transition can chase it with a one-shot
  // /transactions/get gap-backfill against the window that elapsed
  // while the item was broken — the cursor sync alone won't surface
  // anything Plaid advanced past during the outage.
  const wasUnhealthy = !!item?.lastSyncErrorCode;
  if (!item) {
    return {
      itemId: itemRowId,
      plaidItemRowId: itemRowId,
      institutionName: null,
      added: 0,
      modified: 0,
      removed: 0,
      autoCategorized: 0,
      ruleAttributions: [],
      error: "Item not found",
    };
  }
  // (#623) Every transaction / resolution insert below the household
  // refactor must carry household_id. Derived once from the item the
  // sync is operating on so member-driven syncs land in the owner's
  // household, not the actor's self-isolated one. Settings tables
  // (forecast_settings, avalanche_settings) remain singletons keyed by
  // the household owner, so we also resolve `ownerUserId` here.
  const householdId = item.householdId!;
  const [householdRow] = await db
    .select({ ownerUserId: householdsTable.ownerUserId })
    .from(householdsTable)
    .where(eq(householdsTable.id, householdId));
  const ownerUserId = householdRow?.ownerUserId ?? userId;

  // (#623 follow-up) Self-heal misattributed rows from the original
  // bug. Before this fix, transaction inserts stamped `user_id` with
  // the *actor* (whoever's session triggered the sync) instead of the
  // household owner. When a non-owner member opened the app and a
  // background sync fired under their session, every new Plaid row
  // for this item landed under the member's user_id. The owner's
  // user_id-scoped ledger view then rendered them invisible — Plaid
  // had the data, the DB had the data, but the user couldn't see it.
  // Repoint any rows on this item's accounts that are still attributed
  // to a non-owner so the back-history shows up on the next page load.
  // Idempotent — no-op once everything already points at the owner.
  await db.execute(sql`
    UPDATE transactions
       SET user_id = ${ownerUserId}
     WHERE household_id = ${householdId}
       AND user_id <> ${ownerUserId}
       AND plaid_account_id IN (
         SELECT account_id FROM plaid_accounts
          WHERE item_id = ${itemRowId}::uuid
       )
  `);

  // (#398) Synthetic seed rows (April-2026 Chase placeholder) are not
  // real Plaid connections — they exist only to anchor the bank
  // snapshot tile before the user completes OAuth. Silently no-op
  // before the malformed-token guard fires so we never write a bogus
  // ITEM_LOGIN_REQUIRED chip / sync_attempt row against them. Returns
  // a benign zero-row SyncResult; callers treat it the same as "no
  // changes since last sync".
  if (isSyntheticPlaidItem(item)) {
    return {
      itemId: item.itemId,
      plaidItemRowId: item.id,
      institutionName: item.institutionName,
      added: 0,
      modified: 0,
      removed: 0,
      autoCategorized: 0,
      ruleAttributions: [],
      error: null,
    };
  }
  // (#366) Centralized malformed-access-token guard. A bad value in
  // `plaid_items.access_token` (legacy env-mismatch row, truncated
  // string, etc.) would otherwise cascade into an opaque Plaid 400 on
  // every product call and surface as a noisy "Request failed with
  // status code 400" chip the user can't action. Short-circuit instead:
  // mark the item as needing reconnect (synthesizing ITEM_LOGIN_REQUIRED
  // so the existing reauth banner / Reconnect button light up), audit
  // the attempt, and return a synthetic SyncResult — never call Plaid.
  if (!isValidPlaidAccessToken(item.accessToken)) {
    await markItemMalformedToken(itemRowId);
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "transactions",
      success: false,
      errorCode: "ITEM_LOGIN_REQUIRED",
      errorMessage: MALFORMED_PLAID_TOKEN_MESSAGE,
      plaidDisplayMessage: MALFORMED_PLAID_TOKEN_MESSAGE,
      requestId: null,
      httpStatus: null,
      errorKind: "reauth",
    });
    logger.warn(
      {
        userId,
        itemRowId,
        plaidItemIdExternal: item.itemId,
        institutionName: item.institutionName,
      },
      "[plaid-sync] short-circuit: stored access_token failed isValidPlaidAccessToken — flagged as needs-reconnect, no Plaid call made",
    );
    return synthesizeMalformedTokenSyncResult(item);
  }
  // (#654) Env-mismatch guard. The format check above only validates the
  // `access-<env>-<opaque>` shape. A well-formed sandbox-prefixed token
  // on a production server passes the format guard, reaches Plaid, and
  // is rejected with INVALID_ACCESS_TOKEN ("provided access token is for
  // the wrong Plaid environment") on every single call — exactly the
  // state the user's two real Chase items are stuck in today. Short-
  // circuit just like the malformed branch but with a friendlier
  // message and the actual code Plaid would have returned, so existing
  // rows already stamped INVALID_ACCESS_TOKEN and new ones light up the
  // same Reconnect CTA without leaking infra-level "wrong environment"
  // copy at the user.
  if (!isAccessTokenForCurrentEnv(item.accessToken)) {
    await markItemMalformedToken(itemRowId, {
      code: "INVALID_ACCESS_TOKEN",
      message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
    });
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "transactions",
      success: false,
      errorCode: "INVALID_ACCESS_TOKEN",
      errorMessage: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
      plaidDisplayMessage: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
      requestId: null,
      httpStatus: null,
      errorKind: "reauth",
    });
    logger.warn(
      {
        userId,
        itemRowId,
        plaidItemIdExternal: item.itemId,
        institutionName: item.institutionName,
      },
      "[plaid-sync] short-circuit: stored access_token env does not match PLAID_ENV — flagged as needs-reconnect, no Plaid call made",
    );
    return synthesizeMalformedTokenSyncResult(item, {
      code: "INVALID_ACCESS_TOKEN",
      message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
    });
  }

  const slug = item.institutionSlug || institutionSlug(item.institutionName);
  const source = `plaid:${slug}`;
  const rules = await loadUserRules(householdId);

  // Identify the user's chosen "checking" Plaid account (if any) so we can
  // auto-flag its transactions for the cash forecast and try to auto-match
  // them against planned recurring items.
  const [forecastSettings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  let checkingPlaidAccountId: string | null = null;
  // (#45) Track whether the bank-snapshot account actually belongs to the
  // item we're syncing right now. Without this, a user with multiple
  // linked institutions would have *every* item's hourly sync try to
  // refresh the (Chase-owned) bank balance using each item's access
  // token — Plaid would throw INVALID_ACCOUNT_ID on every non-owning
  // item and we'd write a bogus "Balance refresh failed" chip on those
  // items. Only the item that actually owns the checking account should
  // attempt the refresh.
  let bankSnapshotBelongsToThisItem = false;
  if (forecastSettings?.bankSnapshotAccountId) {
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, forecastSettings.bankSnapshotAccountId));
    checkingPlaidAccountId = acct?.accountId ?? null;
    bankSnapshotBelongsToThisItem = acct?.itemId === itemRowId;
  }

  // Build a map from Plaid's external account_id to the user's debt.id, so any
  // transactions hitting a debt-linked Plaid account are auto-tagged with
  // debtId. This is the "Plaid-imported payments" case the dashboard's
  // paid-off totals previously missed.
  const linkedDebts = await db
    .select({
      debtId: debtsTable.id,
      plaidAccountRowId: debtsTable.plaidAccountId,
    })
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const linkedAcctRowIds = linkedDebts
    .map((d) => d.plaidAccountRowId)
    .filter((v): v is string => !!v);
  const debtAccountRows = linkedAcctRowIds.length
    ? await db
        .select({
          rowId: plaidAccountsTable.id,
          externalId: plaidAccountsTable.accountId,
        })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.householdId, householdId))
    : [];
  const externalByRowId = new Map(
    debtAccountRows.map((r) => [r.rowId, r.externalId]),
  );
  const debtIdByPlaidAccount = new Map<string, string>();
  for (const d of linkedDebts) {
    if (!d.plaidAccountRowId) continue;
    const ext = externalByRowId.get(d.plaidAccountRowId);
    if (ext) debtIdByPlaidAccount.set(ext, d.debtId);
  }

  // (#361) Load every Plaid account belonging to this item so we can
  // gate the very-first /transactions/sync's `added` rows on a per-
  // account `import_cutoff_date`. Until each account's
  // `first_sync_completed_at` is stamped (at the end of this method),
  // rows whose `date` is on/before the cutoff are skipped (or merged
  // with a manual row within ±7 days) so the user doesn't end up with
  // duplicate Plaid rows shadowing the manual / imported history they
  // already have. Built once per sync — even thousands of `added` rows
  // only need a Map lookup per row.
  const itemAccounts = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.itemId, itemRowId),
        eq(plaidAccountsTable.householdId, householdId),
      ),
    );
  const acctByExternalId = new Map(
    itemAccounts.map((a) => [a.accountId, a] as const),
  );
  // Map plaid account row id → linked debt ids (debts whose
  // `plaidAccountId` points at this Plaid account row). Used as the
  // merge-scope for credit-card accounts so the ±7-day merge only
  // adopts manual rows attributed to the same debt.
  const debtIdsByAcctRowId = new Map<string, string[]>();
  for (const d of linkedDebts) {
    if (!d.plaidAccountRowId) continue;
    const arr = debtIdsByAcctRowId.get(d.plaidAccountRowId) ?? [];
    arr.push(d.debtId);
    debtIdsByAcctRowId.set(d.plaidAccountRowId, arr);
  }

  let cursor = item.cursor ?? undefined;
  let added: PlaidTxn[] = [];
  let modified: PlaidTxn[] = [];
  let removed: { transaction_id: string }[] = [];
  let hasMore = true;
  let autoCategorized = 0;
  // Per-rule attribution counter — only credited for rows in the `added`
  // array (Plaid's "first time we've seen this txn") so the summary toast
  // doesn't double-count when Plaid replays a `modified` event for an
  // already-categorized historical row. The map's insertion order also
  // gives us a stable tiebreaker when multiple rules tie on count.
  const attributionCounts = new Map<
    string,
    { ruleId: string; pattern: string; count: number }
  >();

  try {
    // (#665) Force Plaid to re-fetch from the institution before we
    // walk the cursor. /transactions/sync only returns what Plaid
    // already has cached from its scheduled poll; for Chase that
    // poll routinely lags pending data by 6+ hours, which is exactly
    // what was leaving the user's freshly-authorized Venmo/mortgage/
    // payroll pending charges stranded on the bank side. Best-effort
    // — if Plaid throws (PRODUCT_NOT_READY on a freshly linked item,
    // RATE_LIMIT, INVALID_PRODUCT for items without /transactions
    // refresh available, etc.) we log and fall through; the cursor
    // sync below proceeds with whatever cached data Plaid has. Only
    // engaged when the caller passed `forceRefresh: true` so the
    // webhook coalescer / nightly cron don't spam the premium
    // endpoint and trip rate limits.
    // (#720) Skip the refresh call entirely when we already know this
    // item's institution doesn't have the `transactions_refresh` add-on
    // enabled on the Plaid Dashboard (returns INVALID_PRODUCT every
    // time, costs 100–300ms per click, fills the log with noise, and
    // never produces a single new row). Re-attempt once a week so the
    // app naturally recovers if the user enables the add-on later.
    // (#727) Split the cooldown by intent. The 7-day window is right
    // for background callers (webhook coalescer, nightly cron) — they
    // aren't a human asking for fresh data and we don't want them to
    // spam INVALID_PRODUCT. But a human-clicked Sync deserves a much
    // shorter retry window: without it, the #725 self-heal can never
    // fire (the stamp blocks the very call it depends on to clear
    // itself), and a user whose Plaid client just got the add-on
    // re-enabled is stuck waiting up to a week before Sync starts
    // pulling live data. 1 hour still rate-limits spam clicks while
    // letting the very next deliberate Sync trigger the live refresh
    // and, on success, auto-clear the stamp.
    const REFRESH_DISABLED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
    const USER_REFRESH_DISABLED_RETRY_MS = 60 * 60 * 1000;
    const refreshDisabledCooldownMs = forceRefresh
      ? USER_REFRESH_DISABLED_RETRY_MS
      : REFRESH_DISABLED_RETRY_MS;
    const refreshDisabledRecently =
      !!item.refreshProductDisabledAt &&
      Date.now() - new Date(item.refreshProductDisabledAt).getTime() <
        refreshDisabledCooldownMs;
    // (#727) When a user-clicked Sync is about to retry through a
    // stamp that the cron path would still skip, log it so we have
    // observability that the self-heal path actually fired in prod.
    if (
      forceRefresh &&
      !refreshDisabledRecently &&
      item.refreshProductDisabledAt
    ) {
      logger.info(
        {
          userId,
          itemRowId,
          plaidItemIdExternal: item.itemId,
          institutionName: item.institutionName,
          refreshProductDisabledAt: item.refreshProductDisabledAt,
          cooldownMs: refreshDisabledCooldownMs,
        },
        "[plaid-sync] user-initiated Sync retrying /transactions/refresh past prior INVALID_PRODUCT stamp — self-heal will clear it on success",
      );
    }
    // (#723) Captured for the SyncResult return so the UI can swap the
    // misleading "your bank is still preparing the initial batch" toast
    // for honest copy when the Plaid client lacks the
    // `transactions_refresh` add-on. Set by either the once-a-week
    // short-circuit below or the INVALID_PRODUCT catch on the live
    // refresh call.
    let refreshDisabledReason: string | null = null;
    if (forceRefresh && refreshDisabledRecently) {
      refreshDisabledReason =
        "transactions_refresh add-on not enabled on this Plaid client";
    }
    // (#728) Circuit-breaker: when Plaid returned TRANSACTIONS_LIMIT
    // (HTTP 429) on a recent /transactions/refresh, we stamped
    // `refresh_rate_limited_until = now()+1h` on the item. Until that
    // stamp passes, every subsequent Sync click short-circuits the
    // refresh call entirely — otherwise we'd burn the per-item quota
    // on a doomed retry and the next legitimate refresh (e.g. after
    // the cooldown clears) gets pushed even further out. Cleared on
    // the next successful refresh (self-heal). Honors the same
    // `forceRefresh` gate so background callers never accidentally
    // bypass the breaker.
    const rateLimitedUntilMs = item.refreshRateLimitedUntil
      ? new Date(item.refreshRateLimitedUntil).getTime()
      : null;
    const refreshRateLimitedNow =
      rateLimitedUntilMs != null && rateLimitedUntilMs > Date.now();
    if (forceRefresh && refreshRateLimitedNow && !refreshDisabledReason) {
      refreshDisabledReason = "rate_limited";
    }
    if (
      forceRefresh &&
      !refreshDisabledRecently &&
      !refreshRateLimitedNow
    ) {
      try {
        await plaid().transactionsRefresh({
          access_token: item.accessToken,
        });
        refreshSucceeded = true;
        // (#725) Self-heal: a successful /transactions/refresh call
        // proves the Plaid client now has the `transactions_refresh`
        // add-on enabled, so any prior INVALID_PRODUCT short-circuit
        // stamp is stale. Clear it so we never have to run a manual
        // SQL fix again the next time the add-on flips on (e.g. after
        // Plaid approves a product-add request mid-week, as just
        // happened on 2026-05-18).
        // (#728) Self-heal: a successful refresh proves the per-item
        // quota window has rolled over, so any prior TRANSACTIONS_LIMIT
        // breaker stamp is stale. Clear it in the same UPDATE as the
        // INVALID_PRODUCT stamp so we make one round-trip instead of
        // two, and so partial clears can't leave the breaker engaged
        // after a clean refresh.
        if (item.refreshProductDisabledAt || item.refreshRateLimitedUntil) {
          try {
            await db
              .update(plaidItemsTable)
              .set({
                refreshProductDisabledAt: null,
                refreshRateLimitedUntil: null,
              })
              .where(eq(plaidItemsTable.id, itemRowId));
            logger.info(
              {
                userId,
                itemRowId,
                plaidItemIdExternal: item.itemId,
                institutionName: item.institutionName,
                clearedRefreshProductDisabledAt:
                  !!item.refreshProductDisabledAt,
                clearedRefreshRateLimitedUntil:
                  !!item.refreshRateLimitedUntil,
              },
              "[plaid-sync] cleared stale refreshProductDisabledAt / refreshRateLimitedUntil after successful /transactions/refresh",
            );
          } catch (clearErr) {
            // Best-effort — the refresh still ran, so the user's data
            // is fresh. The next successful refresh will retry the
            // clear. Log at warn so we have observability if this
            // ever starts failing systematically (e.g. constraint
            // change, transient DB pool exhaustion).
            logger.warn(
              {
                userId,
                itemRowId,
                plaidItemIdExternal: item.itemId,
                institutionName: item.institutionName,
                err:
                  clearErr instanceof Error
                    ? clearErr.message
                    : String(clearErr),
              },
              "[plaid-sync] failed to clear stale refreshProductDisabledAt after successful refresh (will retry on next sync)",
            );
          }
        }
      } catch (refreshErr) {
        const refreshExtracted = extractPlaidError(refreshErr);
        // (#720) When the institution simply doesn't have the
        // transactions_refresh add-on, Plaid returns INVALID_PRODUCT.
        // Stamp the item so subsequent syncs short-circuit above
        // rather than retrying the same doomed call every click.
        // Narrow to the specific "transactions_refresh add-on not
        // enabled" case so unrelated INVALID_PRODUCT errors (e.g. an
        // assets-only token someone routed here) don't get
        // misclassified as a permanently-disabled refresh.
        // (#728) Plaid TRANSACTIONS_LIMIT (HTTP 429) means the per-item
        // /transactions/refresh quota for this rolling window is
        // exhausted. Engage the circuit-breaker: stamp
        // `refresh_rate_limited_until = now()+1h` so subsequent Sync
        // clicks short-circuit the refresh call (the cursor walk and
        // gap-backfill below still run, so the user keeps seeing any
        // newly-cached Plaid data). Surface "rate_limited" on this
        // sync's result so the toast can swap to honest copy.
        if (refreshExtracted.code === "TRANSACTIONS_LIMIT") {
          refreshDisabledReason = "rate_limited";
          try {
            await db
              .update(plaidItemsTable)
              .set({
                refreshRateLimitedUntil: new Date(Date.now() + 60 * 60 * 1000),
              })
              .where(eq(plaidItemsTable.id, itemRowId));
          } catch {
            // Best-effort — the in-memory `refreshDisabledReason`
            // above still gets the honest toast to the user this
            // click; the breaker just won't persist until next sync.
          }
        }
        if (
          refreshExtracted.code === "INVALID_PRODUCT" &&
          /transactions_refresh/i.test(refreshExtracted.message ?? "")
        ) {
          // (#723) Surface the honest reason on this sync's result so
          // the toast can stop lying. Set even on the first occurrence
          // (before the persisted short-circuit kicks in).
          refreshDisabledReason =
            "transactions_refresh add-on not enabled on this Plaid client";
          try {
            await db
              .update(plaidItemsTable)
              .set({ refreshProductDisabledAt: new Date() })
              .where(eq(plaidItemsTable.id, itemRowId));
          } catch {
            // Best-effort — the gap-backfill fallback below still works.
          }
        }
        logger.warn(
          {
            userId,
            itemRowId,
            plaidItemIdExternal: item.itemId,
            institutionName: item.institutionName,
            plaidErrorCode: refreshExtracted.code,
            plaidErrorMessage: refreshExtracted.message,
            requestId: refreshExtracted.requestId,
            httpStatus: refreshExtracted.httpStatus,
          },
          "[plaid-sync] /transactions/refresh failed (best-effort) — continuing with cursor sync against cached Plaid data",
        );
      }
    }
    // (#671) Poll-after-refresh. /transactions/refresh asks Plaid to
    // re-fetch from the bank, but the response returns immediately —
    // Plaid then writes new rows into its own cache *asynchronously*.
    // If we walk /transactions/sync the moment the refresh call
    // resolves, the cursor commonly returns zero added/modified
    // because Plaid hasn't finished ingesting yet. The user then
    // sees "Added 0" and concludes the app is broken even though
    // the bank actually has fresh pending charges. To make a single
    // manual Sync click reliably land newly-authorized pending data,
    // re-walk the cursor several times with short backoffs when
    // a refresh actually succeeded and the first walk came back
    // empty (or returned only the stale historical batch already
    // sitting in the cursor). Budget caps at ≈22s of waits across
    // 6 attempts so user-facing latency stays bounded while still
    // covering Plaid's documented 8–15s ingestion tail. Tunable
    // via env for tests.
    const pollAttemptsEnv = Number(process.env.PLAID_REFRESH_POLL_ATTEMPTS);
    const pollAttemptsMax =
      refreshSucceeded
        ? Number.isFinite(pollAttemptsEnv) && pollAttemptsEnv > 0
          ? Math.min(pollAttemptsEnv, 6)
          : 6
        : 1;
    const pollDelaysEnv = process.env.PLAID_REFRESH_POLL_DELAYS_MS;
    const POLL_DELAYS_MS: number[] = (() => {
      if (pollDelaysEnv != null && pollDelaysEnv !== "") {
        const parsed = pollDelaysEnv
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n >= 0);
        if (parsed.length > 0) return parsed;
      }
      // (#717) Extended budget. The original [2500, 4000] across 3
      // attempts spent only ~6.5s of wall time, which routinely beat
      // Plaid's own /transactions/refresh ingestion (documented to
      // tail out to 8–15s for Chase) and returned with the stale
      // historical batch still being the only thing in the cursor.
      // The new schedule spends up to ~22s of waits across a 6-
      // attempt budget so the manual Sync click reliably waits long
      // enough for the freshly-refreshed rows to land — while still
      // staying inside a perceived <30s click→toast window.
      return [1500, 2500, 4000, 6000, 8000];
    })();
    while (pollAttemptsUsed < pollAttemptsMax) {
      let walkAdded = 0;
      let walkModified = 0;
      hasMore = true;
      while (hasMore) {
        const resp = await plaid().transactionsSync({
          access_token: item.accessToken,
          cursor,
          count: 500,
        });
        added = added.concat(resp.data.added);
        modified = modified.concat(resp.data.modified);
        removed = removed.concat(
          resp.data.removed as { transaction_id: string }[],
        );
        walkAdded += resp.data.added.length;
        walkModified += resp.data.modified.length;
        cursor = resp.data.next_cursor;
        hasMore = resp.data.has_more;
      }
      pollAttemptsUsed++;
      const drainEmpty = walkAdded + walkModified === 0;
      // (#717) Stop polling only when the drain is empty AND either we
      // already have data in hand (Plaid's ingestion has clearly
      // settled — one extra empty drain confirms no more rows are
      // about to land) or this is the cursor-only / refresh-failed
      // path where the budget is 1 anyway. The previous condition
      // broke on the *first* non-empty drain, which on healthy
      // production items frequently drained the stale historical
      // backlog left in the cursor from before the refresh, never
      // giving Plaid time to surface the fresh rows the refresh was
      // asking for. That is exactly how a real Chase item ended up
      // with 48 inserts dated April 17–24 while never reaching the
      // genuinely-missing May 14–18 transactions. Keep draining
      // until either the cursor goes empty after we've already
      // collected at least one row this run, or the budget runs
      // out (latter sets stillPreparing below).
      if (drainEmpty && (!refreshSucceeded || added.length + modified.length > 0)) {
        break;
      }
      if (pollAttemptsUsed >= pollAttemptsMax) break;
      const delayMs =
        POLL_DELAYS_MS[pollAttemptsUsed - 1] ??
        POLL_DELAYS_MS[POLL_DELAYS_MS.length - 1] ??
        3000;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    // (#671) Layer 1 contract: when the user-driven /refresh path
    // succeeded but Plaid's cache still hadn't ingested any rows by
    // the time the retry budget ran out, treat the sync as "still
    // preparing" — same UI semantics as PRODUCT_NOT_READY — so the
    // frontend renders an encouraging neutral toast instead of
    // "Added 0", and so a follow-up Sync click is offered. Only true
    // when refresh actually fired and succeeded; cursor-only
    // (webhook/cron) paths and refresh-failed paths fall through
    // with the normal zero-row success result.
    const pollRetriesExhaustedEmpty =
      forceRefresh &&
      refreshSucceeded &&
      pollAttemptsUsed >= pollAttemptsMax &&
      added.length + modified.length === 0;

    // Upsert added/modified
    const insertedCheckingTxns: { id: string; amount: number; date: string }[] = [];
    // Set of `transaction_id`s Plaid considers brand-new this batch — used
    // below to credit per-rule attribution counts to first-sight rows only,
    // even though we walk added+modified together for the upsert.
    const addedTxnIds = new Set(added.map((t) => t.transaction_id));
    // (#361) Counters returned to callers / tests so the
    // first-sync-cutoff behavior is observable. Skipped rows never
    // become transactions; merged rows attach `plaidTransactionId` to
    // an existing manual row instead of inserting.
    let firstSyncSkipped = 0;
    let firstSyncMerged = 0;
    // (#403) Track the oldest / newest occurredOn that actually
    // landed as a freshly inserted row this sync, so the post-link
    // panel can show "Imported N transactions from Mar 5 – Apr 28"
    // (or flag "still importing recent activity" when the max date
    // is not in the current month). Skipped + merged rows are
    // excluded — they don't represent new data Plaid handed us.
    let insertedMinDate: string | null = null;
    let insertedMaxDate: string | null = null;
    // (#728) Top-N descriptions of the rows this sync actually added
    // (added, not modified, not no-op upserts). Returned in
    // SyncResult.addedDescriptions so the post-sync toast can name a
    // few rows ("Added 3: VENMO, KROGER, +1 more") instead of just
    // "Added 3" — the latter trains the user to ignore the toast.
    // Capped at 5 entries so a huge import doesn't bloat the response.
    const ADDED_DESCRIPTIONS_LIMIT = 5;
    const addedDescriptions: string[] = [];
    const noteInsertedDate = (date: string): void => {
      if (insertedMinDate === null || date < insertedMinDate) insertedMinDate = date;
      if (insertedMaxDate === null || date > insertedMaxDate) insertedMaxDate = date;
    };
    const noteAddedDescription = (description: string): void => {
      if (addedDescriptions.length >= ADDED_DESCRIPTIONS_LIMIT) return;
      addedDescriptions.push(description);
    };
    for (const t of [...added, ...modified]) {
      const description = t.merchant_name || t.name || "(no description)";
      // `personal_finance_category` is the modern Plaid taxonomy used to
      // detect transfers (TRANSFER_IN/OUT) and as a fallback signal when no
      // mapping_rule matches the description.
      const pfc = (t as unknown as {
        personal_finance_category?: { primary?: string; detailed?: string } | null;
      }).personal_finance_category;
      const cat = categorize(
        {
          description,
          pfcPrimary: pfc?.primary ?? null,
          pfcDetailed: pfc?.detailed ?? null,
        },
        rules,
      );
      if (cat.categoryId) autoCategorized++;
      // Credit the per-rule attribution counter ONLY for first-sight rows
      // (Plaid's `added` array). `modified` events fire when upstream
      // metadata changes on a row we've already categorized — counting
      // them here would inflate the toast every time a merchant rename
      // or pending→posted flip rolled through.
      if (
        cat.matchedRuleId &&
        cat.matchedRulePattern &&
        addedTxnIds.has(t.transaction_id)
      ) {
        const existing = attributionCounts.get(cat.matchedRuleId);
        if (existing) {
          existing.count += 1;
        } else {
          attributionCounts.set(cat.matchedRuleId, {
            ruleId: cat.matchedRuleId,
            pattern: cat.matchedRulePattern,
            count: 1,
          });
        }
      }
      const isChecking =
        checkingPlaidAccountId !== null && t.account_id === checkingPlaidAccountId;
      // Plaid `datetime` / `authorized_datetime` are ISO 8601 strings that
      // some institutions populate with a real time. The docs warn they
      // "may contain default time values (such as 00:00:00)" — treat
      // explicit-midnight as "no real time" so the hourly spending clock
      // doesn't get an artificial midnight spike.
      const pickRealTime = (raw: string | null | undefined): string | null => {
        if (!raw) return null;
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) return null;
        if (
          parsed.getUTCHours() === 0 &&
          parsed.getUTCMinutes() === 0 &&
          parsed.getUTCSeconds() === 0
        ) {
          return null;
        }
        return parsed.toISOString();
      };
      // Try `datetime` first, then `authorized_datetime` — either may be a
      // midnight sentinel ("default" per Plaid docs) while the other has a
      // real time, so we evaluate them independently rather than short-
      // circuiting on the first non-null value.
      const occurredAt =
        pickRealTime(t.datetime) ?? pickRealTime(t.authorized_datetime);
      const signedAmount = plaidAmountToSigned(t);
      // Only attribute a transaction to a debt when it is actually a
      // balance-reducing PAYMENT on the linked liability account, never a
      // purchase. Plaid uses positive=debit/charge on liability accounts; our
      // convention flips the sign (`amount = -Plaid.amount`), so payments
      // appear as POSITIVE amounts in our app and purchases as negative.
      // Tagging purchases would make the dashboard double-count debt growth
      // as "paid off" and worsen the original bug.
      const linkedDebtId = debtIdByPlaidAccount.get(t.account_id) ?? null;
      const debtId =
        linkedDebtId && Number(signedAmount) > 0 ? linkedDebtId : null;

      // (#361) First-sync cutoff gate. For *added* rows on an account
      // that hasn't yet completed its first sync AND has a cutoff on
      // file:
      //   - Within ±7 days of the cutoff, try to merge with an
      //     unattached manual row (same userId+amount+date+source-
      //     scope, plaidTransactionId NULL). On match, adopt the
      //     plaid identifiers in-place instead of inserting — that's
      //     how a near-cutoff manual row becomes the canonical Plaid
      //     row without duplicating the user's history.
      //   - Otherwise, when t.date <= cutoff, skip the insert
      //     entirely. The user's existing manual / imported history
      //     stays as-is and Plaid's overlapping rows are dropped on
      //     the floor.
      // `modified` rows are never gated (they're updates of rows we
      // already inserted on a previous, post-cutoff sync).
      const acctRow = acctByExternalId.get(t.account_id);
      // (#662) NEVER apply the first-sync cutoff gate to pending Plaid
      // rows. The gate exists to suppress historical backfill that
      // would duplicate manual rows the user already typed in pre-link
      // — but pending charges are inherently live activity, never
      // historical, and have no manual pre-image to collide with. The
      // user-reported regression: after a relink mints fresh
      // plaid_accounts rows (firstSyncCompletedAt = null, fresh
      // importCutoffDate ≈ today), every pending row Chase returns
      // carries an authorization date a day or two old, falls into
      // `txnMs <= cutoffMs`, and was silently `continue`'d at the
      // skip branch below. The bank shows pending charges; H2 shows
      // none; the Sync toast says "0 added". Excluding `t.pending`
      // from the gate restores the previous behavior. The pending
      // row's later posted twin (same transaction_id, pending=false)
      // arrives as a `modified` row, which the gate already bypasses
      // (it only checks `addedTxnIds`), so the pending→posted
      // lifecycle keeps converging on a single row via the existing
      // `onConflictDoUpdate` below.
      const isFirstSyncForAcct =
        addedTxnIds.has(t.transaction_id) &&
        acctRow != null &&
        acctRow.firstSyncCompletedAt == null &&
        acctRow.importCutoffDate != null &&
        !t.pending;
      if (isFirstSyncForAcct) {
        const cutoffStr = acctRow.importCutoffDate as string;
        const cutoffMs = parseISO(cutoffStr).getTime();
        const txnMs = parseISO(t.date).getTime();
        const debtScope = debtIdsByAcctRowId.get(acctRow.id) ?? [];
        const isCheckingScope =
          !!forecastSettings?.bankSnapshotAccountId &&
          forecastSettings.bankSnapshotAccountId === acctRow.id;
        // (#452) Widened first-sync merge. Two independent merge
        // attempts so any manual row the user already typed in for
        // this account can be absorbed instead of insert-duplicating
        // alongside Plaid's row:
        //   1. Exact (date, amount) match on a manual row whose
        //      occurredOn is on/before the import cutoff. The previous
        //      ±7-day window meant a manual row dated weeks before the
        //      cutoff would survive AND Plaid's row would be skipped,
        //      leaving the user looking at a stale manual line. Now
        //      anything on/before the cutoff is fair game so the same
        //      real posting always collapses to a single Plaid-owned
        //      row.
        //   2. Pending→posted reconciliation: amount within $0.01 and
        //      date within ±3 days. A manually-entered "pending" row
        //      typically lands a day or two before the posted Plaid
        //      row, often with a slightly different cents value (tip,
        //      currency rounding). Capturing those near-twins prevents
        //      the doubled-row complaint at the heart of #452.
        // On either match we adopt the Plaid identifiers in-place and
        // upgrade `source` to `plaid:<slug>` so the row stops claiming
        // it was manually entered.
        const sourceScope = debtScope.length > 0
          ? ["manual", "amex"]
          : ["manual", "bank"];
        const baseScope = debtScope.length > 0
          ? and(
              eq(transactionsTable.householdId, householdId),
              sql`${transactionsTable.plaidTransactionId} is null`,
              inArray(transactionsTable.debtId, debtScope),
              inArray(transactionsTable.source, sourceScope),
            )
          : isCheckingScope
            ? and(
                eq(transactionsTable.householdId, householdId),
                sql`${transactionsTable.plaidTransactionId} is null`,
                sql`${transactionsTable.debtId} is null`,
                inArray(transactionsTable.source, sourceScope),
              )
            : null;
        let mergedTo: string | null = null;
        if (baseScope) {
          // Attempt 1: exact (date, amount), occurredOn <= cutoff.
          const [exactMatch] = await db
            .select({ id: transactionsTable.id })
            .from(transactionsTable)
            .where(
              and(
                baseScope,
                eq(transactionsTable.occurredOn, t.date),
                eq(transactionsTable.amount, signedAmount),
                sql`${transactionsTable.occurredOn} <= ${cutoffStr}`,
              ),
            )
            .limit(1);
          if (exactMatch) mergedTo = exactMatch.id;
          // Attempt 2: pending→posted (±$0.01, ±3 days).
          if (!mergedTo) {
            const lowDate = fmtISO(addDays(parseISO(t.date), -3));
            const highDate = fmtISO(addDays(parseISO(t.date), 3));
            const signed = Number(signedAmount);
            const lowAmt = (signed - 0.01).toFixed(2);
            const highAmt = (signed + 0.01).toFixed(2);
            const [fuzzyMatch] = await db
              .select({ id: transactionsTable.id })
              .from(transactionsTable)
              .where(
                and(
                  baseScope,
                  sql`${transactionsTable.occurredOn} >= ${lowDate}`,
                  sql`${transactionsTable.occurredOn} <= ${highDate}`,
                  sql`${transactionsTable.amount}::numeric between ${lowAmt}::numeric and ${highAmt}::numeric`,
                ),
              )
              .limit(1);
            if (fuzzyMatch) mergedTo = fuzzyMatch.id;
          }
        }
        if (mergedTo) {
          await db
            .update(transactionsTable)
            .set({
              plaidTransactionId: t.transaction_id,
              plaidAccountId: t.account_id,
              source,
            })
            .where(eq(transactionsTable.id, mergedTo));
          firstSyncMerged++;
          continue;
        }
        if (txnMs <= cutoffMs) {
          firstSyncSkipped++;
          continue;
        }
      }

      // Authoritative pending→posted link. When Plaid posts a charge it
      // sends the posted row as a NEW transaction_id whose
      // `pending_transaction_id` points at the pending row we already
      // stored. Re-key that existing row in place — adopt the new id and
      // refresh only Plaid-owned fields — so the user's manual work
      // (categoryId, allowance flags, all *UserOverridden guards) is
      // PRESERVED. This takes precedence over the fuzzy amount/date
      // re-mint below (which misses whenever the amount changes on
      // posting — tip, auth-hold → final — or the date shifts > 2 days),
      // and it makes the later `removed`-array delete for the old id a
      // no-op (the id no longer exists on any row).
      {
        const ptid = t.pending_transaction_id;
        if (ptid) {
          const [pendingMatch] = await db
            .select({ id: transactionsTable.id })
            .from(transactionsTable)
            .where(
              and(
                eq(transactionsTable.householdId, householdId),
                eq(transactionsTable.plaidAccountId, t.account_id),
                eq(transactionsTable.plaidTransactionId, ptid),
              ),
            )
            .limit(1);
          if (pendingMatch) {
            logger.info(
              {
                householdId,
                itemRowId,
                externalAcctId: t.account_id,
                pendingTransactionId: ptid,
                newPlaidTransactionId: t.transaction_id,
                occurredOn: t.date,
                amount: signedAmount,
              },
              "[plaid-sync] pending→posted adoption — re-keying existing pending row, preserving user edits",
            );
            await db
              .update(transactionsTable)
              .set({
                plaidTransactionId: t.transaction_id,
                // Honor a manual date edit, same CASE shape the upsert uses.
                occurredOn: sql`CASE WHEN ${transactionsTable.occurredOnUserOverridden} THEN ${transactionsTable.occurredOn} ELSE ${t.date} END`,
                occurredAt,
                description,
                amount: signedAmount,
                pending: !!t.pending,
                pfcPrimary: pfc?.primary ?? null,
                pfcDetailed: pfc?.detailed ?? null,
                // Deliberately NOT written → preserved: categoryId,
                // weekly/monthly/unplannedAllowance, isTransfer + all
                // *UserOverridden flags, debtId, forecastFlag, reviewed.
              })
              .where(eq(transactionsTable.id, pendingMatch.id));
            continue;
          }
        }
      }

      // (#720) Re-mint dedup on the cursor insert path. Mirror of the
      // gap-backfill guard: when Plaid re-issues an internal
      // transaction_id for the same real posting (observed after
      // cursor resets and forced re-links), the unique constraint on
      // plaid_transaction_id won't catch it — the new id is novel, so
      // onConflictDoUpdate misses and we'd insert a duplicate.
      // Look for an existing row on this account with the same amount
      // and occurred_on ±2 days carrying a *different*
      // plaid_transaction_id; if found, UPDATE in place and skip the
      // insert. The cursor sync path needs this just as much as the
      // backfill path — both can be the first to see the re-mint.
      {
        const remintLow = fmtISO(addDays(parseISO(t.date), -2));
        const remintHigh = fmtISO(addDays(parseISO(t.date), 2));
        const [remintMatch] = await db
          .select({
            id: transactionsTable.id,
            oldPtid: transactionsTable.plaidTransactionId,
          })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              eq(transactionsTable.plaidAccountId, t.account_id),
              eq(transactionsTable.amount, signedAmount),
              sql`${transactionsTable.occurredOn} >= ${remintLow}`,
              sql`${transactionsTable.occurredOn} <= ${remintHigh}`,
              sql`${transactionsTable.plaidTransactionId} is not null`,
              sql`${transactionsTable.plaidTransactionId} <> ${t.transaction_id}`,
            ),
          )
          .limit(1);
        if (remintMatch) {
          logger.warn(
            {
              householdId,
              itemRowId,
              externalAcctId: t.account_id,
              oldPlaidTransactionId: remintMatch.oldPtid,
              newPlaidTransactionId: t.transaction_id,
              occurredOn: t.date,
              amount: signedAmount,
            },
            "[plaid-sync] re-mint detected on cursor path — adopting new plaid_transaction_id on existing row instead of inserting",
          );
          await db
            .update(transactionsTable)
            .set({
              plaidTransactionId: t.transaction_id,
              occurredOn: t.date,
              description,
              amount: signedAmount,
              // (#728) Authoritative pending boolean replaces the old
              // `notes='[pending]'` marker. The re-mint path is an
              // in-place UPDATE so we ALWAYS write the current Plaid
              // lifecycle state — including flipping the flag back to
              // false on the pending→posted transition.
              pending: !!t.pending,
            })
            .where(eq(transactionsTable.id, remintMatch.id));
          continue;
        }
      }

      const values = {
        // (#623 follow-up) Data-owner is the household owner, not the
        // actor that triggered this sync. Using the actor here was the
        // root cause of "Plaid sees the expense but the app doesn't":
        // when a non-owner household member's session fired the sync,
        // every new row landed under their user_id and was filtered out
        // of the owner's ledger.
        userId: ownerUserId,
        householdId,
        occurredOn: t.date,
        occurredAt,
        description,
        amount: signedAmount,
        categoryId: cat.categoryId,
        isTransfer: cat.isTransfer,
        source,
        plaidTransactionId: t.transaction_id,
        plaidAccountId: t.account_id,
        // (#636) Persist Plaid's PFC on every insert so the startup
        // card-payment audit / future audits can catch bland-description
        // rows by pfc_primary (LOAN_PAYMENTS / TRANSFER_IN / TRANSFER_OUT)
        // even when the description never matches a heuristic pattern.
        pfcPrimary: pfc?.primary ?? null,
        pfcDetailed: pfc?.detailed ?? null,
        debtId,
        // (#728) First-class pending boolean — see schema comment.
        pending: !!t.pending,
        forecastFlag: isChecking && !cat.isTransfer,
      };
      noteInsertedDate(values.occurredOn);
      // (#728) Only count rows from Plaid's `added` array — modified
      // rows are lifecycle updates of rows we already inserted, and
      // surfacing their names in the "Added N" toast would be a lie.
      if (addedTxnIds.has(t.transaction_id)) {
        noteAddedDescription(description);
      }
      const [row] = await db
        .insert(transactionsTable)
        .values(values)
        .onConflictDoUpdate({
          target: transactionsTable.plaidTransactionId,
          // Preserve any manual override of categoryId — only refresh fields
          // that come straight from Plaid. For debtId we ONLY write when our
          // auto-detect computed a non-null link (positive payment on a
          // debt-linked account). When auto-detect yields null we leave the
          // existing debtId untouched, so manual /transactions PATCH overrides
          // (e.g. linking a checking-side payment to a debt) are not wiped on
          // the next Plaid sync.
          set: {
            // Honor a manual date edit. When the user pulled this row into
            // a different day (e.g. Sunday→Saturday so it counts in the
            // right allowance week), `occurred_on_user_overridden` is true
            // and we keep their date; otherwise refresh from Plaid. Same
            // CASE-guard shape as `isTransfer` below.
            occurredOn: sql`CASE WHEN ${transactionsTable.occurredOnUserOverridden} THEN ${transactionsTable.occurredOn} ELSE ${values.occurredOn} END`,
            occurredAt: values.occurredAt,
            description: values.description,
            amount: values.amount,
            // (#728) Refresh the pending boolean on every upsert so the
            // pending→posted lifecycle flip Plaid surfaces via a
            // `modified` row actually lands in the DB (and the UI's
            // Pending section empties out as charges post). Without
            // this, a row inserted as pending would stay pending
            // forever in the DB even after Plaid told us it posted.
            pending: values.pending,
            // (#479) Honor the user's manual override of `isTransfer`. When
            // `is_transfer_user_overridden` is true on the existing row,
            // preserve its current value instead of letting the auto-
            // categorize transfer heuristic re-flip it on every sync.
            isTransfer: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.isTransfer} ELSE ${values.isTransfer} END`,
            // (#636) Refresh persisted PFC on every sync so the
            // startup audit always sees the latest taxonomy. These
            // come straight from Plaid and are not user-editable.
            pfcPrimary: values.pfcPrimary,
            pfcDetailed: values.pfcDetailed,
            // (#632) When the classifier flips a row to a transfer
            // (e.g. a card-payment row caught by the new LOAN_PAYMENTS
            // PFC / "online payment" patterns), also clear the
            // Weekly/Monthly/Unplanned allowance flags so the row
            // disappears from every dashboard bucket — same shape the
            // category picker already does for the manual Transfer pick.
            // User overrides are respected via the same CASE guard.
            ...(cat.isTransfer
              ? {
                  weeklyAllowance: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.weeklyAllowance} ELSE FALSE END`,
                  monthlyAllowance: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.monthlyAllowance} ELSE FALSE END`,
                  unplannedAllowance: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.unplannedAllowance} ELSE FALSE END`,
                }
              : {}),
            ...(debtId ? { debtId } : {}),
            // (#479 follow-up) Re-set forecastFlag for checking rows on
            // every sync — EXCEPT when the user has manually flagged this
            // row as a transfer (`is_transfer_user_overridden=true` AND
            // the row currently `is_transfer`). The forecast register
            // (`filterForecastTxns`) includes a row purely on
            // `forecastFlag && isBankTxn` and does NOT re-check
            // `isTransfer`, so force-setting `forecastFlag=true` here would
            // drag a user-flagged transfer back into the running balance
            // and fake reconcile slack on the next sync. The same CASE
            // guard the `isTransfer` / allowance re-sets use keeps the
            // user's override sticky across syncs.
            ...(isChecking && !cat.isTransfer
              ? {
                  forecastFlag: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} AND ${transactionsTable.isTransfer} THEN ${transactionsTable.forecastFlag} ELSE TRUE END`,
                }
              : {}),
          },
        })
        .returning({ id: transactionsTable.id });
      if (isChecking && row) {
        insertedCheckingTxns.push({
          id: row.id,
          amount: Number(values.amount),
          date: values.occurredOn,
        });
      }
    }

    // (#452) Row-level dedupe pass over every Plaid account this
    // sync touched. The `transactions_plaid_txn_uq` unique index
    // is on `plaid_transaction_id` alone, so when the same real
    // posting arrives a second time under a different Plaid item
    // (re-link, cross-item duplicate, or a near-cutoff manual row
    // that escaped the merge window in #361) it survives the upsert
    // and would otherwise show up as a doubled line on the
    // Transactions page. Run before auto-match so a freshly-deleted
    // loser id never lands in `forecast_resolutions.matched_txn_id`.
    const touchedExternalAcctIds = new Set<string>();
    for (const t of [...added, ...modified]) {
      if (t.account_id) touchedExternalAcctIds.add(t.account_id);
    }
    for (const externalAcctId of touchedExternalAcctIds) {
      try {
        // (#623 follow-up) Dedupe is scoped by user_id; if we passed
        // the actor here it would only see the actor's slice of rows
        // and miss historical owner-attributed twins (or vice versa).
        // Always run as the owner so the dedupe pass sees the canonical
        // household-owner view of this account.
        await dedupeTransactionsForAccount(ownerUserId, externalAcctId);
      } catch (e) {
        logger.warn(
          { userId, ownerUserId, itemRowId, externalAcctId, err: e },
          "[plaid-sync] post-upsert dedupeTransactionsForAccount failed (non-fatal)",
        );
      }
    }

    // (Amex ··1009 / relink) Collapse CROSS-account duplicates too: a
    // categorized "orphan" row whose account row was deleted on a reconnect
    // (now preserved by the orphan-prune guard) plus its fresh live-linked
    // twin. The per-account pass above can't see across two different
    // account_ids; this merges the orphan's category/allowance flags onto the
    // live-linked survivor and drops the orphan — so the user sees ONE
    // categorized charge, not two. Short-circuits cheaply when nothing is
    // orphaned. Non-fatal.
    try {
      await dedupeTransactionsAcrossAccountsForUser(ownerUserId);
    } catch (e) {
      logger.warn(
        { userId, ownerUserId, itemRowId, err: e },
        "[plaid-sync] post-upsert cross-account dedupe failed (non-fatal)",
      );
    }

    // Auto-match: for each new checking txn, find a planned recurring event
    // within ±3 days with the same sign and (within $1) amount, and mark it matched.
    //
    // (#760, Phase A) Gated behind the module-level `AUTO_MATCH_ENABLED`
    // kill-switch. While disabled, the entire block — recurring-item
    // lookup, event expansion, candidate scoring, and the
    // `forecast_resolutions` insert — is skipped, and one info log per
    // sync records the skip so production operators can see the gate
    // running. The matching logic is preserved verbatim so a later phase
    // can resurface it as an opt-in feature without rewriting it.
    if (!AUTO_MATCH_ENABLED) {
      if (insertedCheckingTxns.length > 0) {
        logger.info(
          {
            householdId,
            userId: ownerUserId,
            itemRowId,
            skippedCheckingTxnCount: insertedCheckingTxns.length,
          },
          "[plaid-sync] forecast auto-match skipped (AUTO_MATCH_ENABLED=false)",
        );
      }
    } else if (insertedCheckingTxns.length > 0) {
      const recurring = await db
        .select()
        .from(recurringItemsTable)
        .where(eq(recurringItemsTable.householdId, householdId));
      const minDate = insertedCheckingTxns.reduce((a, b) => (a < b.date ? a : b.date), insertedCheckingTxns[0].date);
      const maxDate = insertedCheckingTxns.reduce((a, b) => (a > b.date ? a : b.date), insertedCheckingTxns[0].date);
      const from = addDays(parseISO(minDate), -7);
      const to = addDays(parseISO(maxDate), 7);
      const events = recurring.flatMap((r) => expandItem(r, from, to));

      const existingResolutions = await db
        .select()
        .from(forecastResolutionsTable)
        .where(eq(forecastResolutionsTable.householdId, householdId));
      const usedPlanKeys = new Set(
        existingResolutions
          .filter((r) => r.recurringItemId && r.occurrenceDate)
          .map((r) => `${r.recurringItemId}|${r.occurrenceDate}`),
      );
      const usedTxnIds = new Set(
        existingResolutions
          .filter((r) => r.matchedTxnId)
          .map((r) => r.matchedTxnId as string),
      );

      for (const txn of insertedCheckingTxns) {
        if (usedTxnIds.has(txn.id)) continue;
        const txnSign = Math.sign(txn.amount) || 0;
        if (txnSign === 0) continue;
        let bestKey: string | null = null;
        let bestItemId: string | null = null;
        let bestDate: string | null = null;
        let bestScore = Infinity;
        const txnMs = parseISO(txn.date).getTime();
        for (const ev of events) {
          if (Math.sign(ev.amount) !== txnSign) continue;
          if (Math.abs(Math.abs(ev.amount) - Math.abs(txn.amount)) > 1) continue;
          const evMs = parseISO(ev.date).getTime();
          const days = Math.abs(evMs - txnMs) / 86_400_000;
          if (days > 3) continue;
          const key = `${ev.itemId}|${ev.date}`;
          if (usedPlanKeys.has(key)) continue;
          const score = days * 10 + Math.abs(Math.abs(ev.amount) - Math.abs(txn.amount));
          if (score < bestScore) {
            bestScore = score;
            bestKey = key;
            bestItemId = ev.itemId;
            bestDate = ev.date;
          }
        }
        if (bestKey && bestItemId && bestDate) {
          await db.insert(forecastResolutionsTable).values({
            // (#623 follow-up) Same data-owner fix as the transactions
            // insert above — resolutions belong to the household owner
            // so the owner's user_id-scoped forecast view sees them
            // regardless of which member's session triggered the sync.
            userId: ownerUserId,
            householdId,
            recurringItemId: bestItemId,
            occurrenceDate: bestDate,
            status: "matched",
            matchedTxnId: txn.id,
          });
          usedPlanKeys.add(bestKey);
          usedTxnIds.add(txn.id);
        }
      }
      void fmtISO; // silence unused warning if helper not needed elsewhere
    }

    // Remove. NEVER hard-delete a row the user has touched: mirror the
    // orphan-prune guard. In the common pending→posted case the pending row
    // was already re-keyed to the posted id by the adoption block above, so
    // this delete no-ops for it. If Plaid removes an id we never adopted
    // (adoption missed), keeping the user's categorized/allowance-flagged row
    // is strictly better than silently destroying their work — the per-sync
    // dedupe reconciles any transient pair onto the user-owned survivor.
    for (const r of removed) {
      await db
        .delete(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, householdId),
            eq(transactionsTable.plaidTransactionId, r.transaction_id),
            sql`${transactionsTable.categoryId} is null`,
            eq(transactionsTable.weeklyAllowance, false),
            eq(transactionsTable.monthlyAllowance, false),
            eq(transactionsTable.unplannedAllowance, false),
            eq(transactionsTable.reviewed, false),
            eq(transactionsTable.isTransferUserOverridden, false),
            eq(transactionsTable.occurredOnUserOverridden, false),
          ),
        );
    }

    // (#732) NOTE: vanished-pending reconciliation deliberately does
    // NOT run here on the cursor-sync delta. /transactions/sync is
    // delta-based — it returns only transactions whose state has
    // changed since the last cursor. An unchanged-but-still-in-flight
    // pending will not appear in `added` or `modified` on a quiet
    // cycle, so treating "id absent from this delta" as "vanished
    // upstream" would falsely delete legitimate pendings. The
    // authoritative sweep lives on the gap-backfill path below
    // (`reconcileVanishedPendings` invoked from
    // `runGapBackfillForItem`), which diffs against /transactions/get
    // — that endpoint returns the full set of transactions in the
    // queried window, so absence there is real. The stale-cursor
    // fallback in this same function auto-fires gap-backfill on a
    // user-initiated sync whose cursor delta is empty, which is
    // exactly the "Metro pre-auth silently dropped without a removed
    // event" lifecycle this task exists to clean up.

    await db
      .update(plaidItemsTable)
      .set({
        cursor,
        lastSyncedAt: new Date(),
        lastSyncError: null,
        lastSyncErrorCode: null,
        // The bank successfully returned a /transactions/sync result, so
        // it is no longer "still preparing". Clear the badge so Settings
        // shows this item as healthy again on the next list refresh.
        stillPreparingSince: null,
      })
      .where(eq(plaidItemsTable.id, itemRowId));

    // (#361) Stamp `first_sync_completed_at` on every account belonging
    // to this item that hasn't been stamped yet, so the cutoff gate
    // above is permanently disabled for subsequent cursor-based syncs.
    // Done after the upsert/remove pass so a mid-sync crash leaves the
    // gate active and the next attempt can re-apply it.
    await db
      .update(plaidAccountsTable)
      .set({ firstSyncCompletedAt: new Date() })
      .where(
        and(
          eq(plaidAccountsTable.itemId, itemRowId),
          eq(plaidAccountsTable.householdId, householdId),
          sql`${plaidAccountsTable.firstSyncCompletedAt} is null`,
        ),
      );
    void firstSyncMerged;

    // If this item is American Express, refresh the persisted Amex anchor so
    // GET /amex/anchor's `asOf` timestamp advances and the linked debt's
    // balance moves forward (unless the user has manually overridden it via
    // the debts UI since the last auto-update).
    if (slug === "amex") {
      try {
        // (#623) Anchor settings live on the household owner, not
        // the actor — pass `ownerUserId` so a member-driven sync
        // still updates the same row the owner sees on the
        // dashboard.
        await refreshAmexAnchor(ownerUserId, db, { adopt: false });
      } catch {
        // Anchor refresh is best-effort; never break the sync result.
      }
    }

    // Auto-refresh bank snapshot balance if a Plaid checking account is
    // configured (#45). Keeps the forecast anchor fresh on every sync.
    let balanceRefreshError: string | null = null;
    let balanceRefreshErrorCode: string | null = null;
    // (#357) Structured details of the balance-refresh failure so the
    // per-item response carries the same enriched payload as the
    // /transactions/sync catch path below.
    let balanceErrorDetails: ExtractedPlaidError | null = null;
    // (#723) Gate the auto-balance call to manual Sync clicks only.
    // Plaid bills per `/accounts/balance/get`. Before this gate, every
    // webhook (`SYNC_UPDATES_AVAILABLE`, `LOGIN_REPAIRED`, etc., several
    // per item per day), the hourly cron, and the 2-second post-link
    // debounce auto-fired a balance check — producing ~100 billed calls
    // per day and routinely tripping Plaid's `BALANCE_LIMIT` 429. Only
    // the user-clicked Sync path actually needs the live anchor refresh;
    // the two user-tap balance routes in `routes/forecast.ts` are
    // intentionally untouched.
    if (
      syncOrigin === "manual" &&
      checkingPlaidAccountId &&
      forecastSettings?.bankSnapshotAccountId &&
      bankSnapshotBelongsToThisItem
    ) {
      try {
        const resp = await plaid().accountsBalanceGet({
          access_token: item.accessToken,
          options: { account_ids: [checkingPlaidAccountId] },
        });
        const acct = resp.data.accounts.find(
          (a) => a.account_id === checkingPlaidAccountId,
        );
        // (#balance) Anchor on the CURRENT (posted) balance, not `available`.
        // Pending charges are stored as ledger transactions, so the forecast
        // already deducts them going forward — anchoring on `available` (which
        // has pending pre-subtracted) would double-count them. Current also
        // matches what the bank shows as the account balance.
        const live = acct?.balances.current ?? acct?.balances.available;
        if (live != null) {
          await db
            .update(forecastSettingsTable)
            .set({
              bankSnapshotBalance: Number(live).toFixed(2),
              bankSnapshotAt: new Date(),
              bankSnapshotSource: "plaid",
            })
            .where(eq(forecastSettingsTable.userId, ownerUserId));
        }
      } catch (e) {
        // Don't break the sync — but capture Plaid's real reason so the
        // user sees "balance refresh failed: <real plaid message>" rather
        // than a silent failure.
        const extracted = extractPlaidError(e);
        const { code, message } = extracted;
        // PRODUCT_NOT_READY on balance is just as transient as on
        // /transactions/sync — surface as still-preparing, never as a
        // hard error chip.
        if (code !== "PRODUCT_NOT_READY") {
          balanceRefreshError = `Balance refresh failed: ${message}`;
          balanceRefreshErrorCode = code;
          balanceErrorDetails = extracted;
        }
        // (#45) Log per-item context so support can trace which user /
        // institution / Plaid error surfaced the lastSyncError chip on
        // a hourly sync. Persistence-only would leave us blind whenever
        // the chip turns over before anyone notices.
        logger.warn(
          {
            userId,
            itemRowId,
            itemId: item.itemId,
            institutionName: item.institutionName,
            checkingPlaidAccountId,
            code,
            err: message,
            ...plaidLogContext(e, "/accounts/balance/get"),
          },
          "Plaid bank-snapshot balance refresh failed",
        );
      }
    }

    if (balanceRefreshError) {
      await db
        .update(plaidItemsTable)
        .set({
          lastSyncError: balanceRefreshError,
          lastSyncErrorCode: balanceRefreshErrorCode,
        })
        .where(eq(plaidItemsTable.id, itemRowId));
    }

    // (#279) Record one row per attempted product call so the
    // Settings → Linked banks "Recent activity" panel can show the
    // full history (success/failure per kind), not just the latest
    // chip. Only emit a `balance` row when we actually attempted the
    // refresh (item owns the bank-snapshot account).
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "transactions",
      success: true,
      errorCode: null,
      errorMessage: null,
    });
    if (
      checkingPlaidAccountId &&
      forecastSettings?.bankSnapshotAccountId &&
      bankSnapshotBelongsToThisItem
    ) {
      await recordPlaidSyncAttempt({
        userId,
        plaidItemId: itemRowId,
        kind: "balance",
        success: !balanceRefreshError,
        errorCode: balanceRefreshErrorCode,
        errorMessage: balanceRefreshError,
        // (#357) Persist the structured Plaid failure so the Settings →
        // Recent activity row carries the same plain-English reason +
        // Reconnect CTA the live toast does, without re-deriving from
        // the raw axios error on render.
        plaidDisplayMessage: balanceErrorDetails?.displayMessage ?? null,
        requestId: balanceErrorDetails?.requestId ?? null,
        httpStatus: balanceErrorDetails?.httpStatus ?? null,
        errorKind: balanceErrorDetails?.kind ?? null,
      });
    }

    // Sort attributions by count desc; insertion order (rule-first-hit
    // order) is the natural tiebreaker because Map preserves it.
    const ruleAttributions: RuleAttribution[] = Array.from(
      attributionCounts.values(),
    ).sort((a, b) => b.count - a.count);

    // (#402) Compute the most recent occurredOn across rows this run
    // actually touched so the post-link panel can deep-link to that
    // month directly. Plaid txns carry a YYYY-MM-DD `date`, which is
    // what we persist into transactions.occurredOn, so a lexicographic
    // max is correct.
    let lastOccurredOn: string | null = null;
    for (const t of added) {
      if (t.date && (!lastOccurredOn || t.date > lastOccurredOn)) {
        lastOccurredOn = t.date;
      }
    }
    for (const t of modified) {
      if (t.date && (!lastOccurredOn || t.date > lastOccurredOn)) {
        lastOccurredOn = t.date;
      }
    }
    // (#408) Heal-driven gap backfill. When this sync transitioned the
    // item from error → healthy (chip set on entry, cleared above by
    // the cursor-sync write), chase with a /transactions/get window
    // pull per account so any rows Plaid advanced past while the
    // access_token was malformed land now instead of waiting for the
    // user to notice an empty May. The cursor alone can skip that
    // window because Plaid moved it forward during the outage. Result
    // counts roll into the SyncResult so the post-link panel reports
    // the full added total.
    let backfillAdded = 0;
    let backfillRange: { min: string; max: string } | null = null;
    let deliveryMode: "cursor" | "gap-backfill" = "cursor";
    // (#732) Track whether any gap-backfill ran successfully so we can
    // re-fire the Amex anchor refresh below — the gap-backfill path
    // can delete vanished pendings, which moves the anchor balance,
    // and the existing post-cursor refreshAmexAnchor above ran BEFORE
    // those deletes.
    let backfillRan = false;
    if (wasUnhealthy) {
      try {
        const bf = await runGapBackfillForItem(userId, itemRowId);
        backfillAdded = bf.added;
        backfillRange = bf.importedDateRange;
        backfillRan = true;
      } catch (e) {
        logger.warn(
          { userId, itemRowId, err: e },
          "[plaid-sync] gap backfill after heal failed (non-fatal)",
        );
      }
    }
    // (#720) Stale-cursor fallback. The cursor sync against the
    // /transactions/sync endpoint only returns rows that Plaid's
    // *background poll* has already ingested from the institution.
    // For Chase that background poll routinely runs on a 24–72h
    // cadence, so a perfectly healthy item with `transactions_refresh`
    // disabled on the Dashboard can sit for two days returning empty
    // cursor deltas while the bank itself has fresh activity to give
    // up. Detect that exact state — user-initiated sync, cursor delta
    // empty in every direction, max(occurred_on) for this item is
    // >24h stale (or no Plaid rows on file yet) — and fall through to
    // /transactions/get via runGapBackfillForItem. That endpoint is
    // part of the base Transactions product (no add-on required) and
    // its per-account window pull bypasses the stale poll entirely.
    // Skipped when the wasUnhealthy branch above already fired the
    // same backfill so we never double-call /transactions/get.
    if (
      syncOrigin === "manual" &&
      forceRefresh &&
      !wasUnhealthy &&
      added.length === 0 &&
      modified.length === 0 &&
      removed.length === 0
    ) {
      let lastBank: string | null = null;
      try {
        const [maxRow] = await db
          .select({
            occurredOn: sql<string | null>`max(${transactionsTable.occurredOn})`,
          })
          .from(transactionsTable)
          .innerJoin(
            plaidAccountsTable,
            eq(plaidAccountsTable.accountId, transactionsTable.plaidAccountId),
          )
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              eq(plaidAccountsTable.itemId, itemRowId),
            ),
          );
        lastBank = (maxRow?.occurredOn as string | null) ?? null;
      } catch {
        // best-effort
      }
      const STALE_THRESHOLD_HOURS = 24;
      const staleByDate =
        !lastBank ||
        (Date.now() - parseISO(lastBank).getTime()) / 3600000 >
          STALE_THRESHOLD_HOURS;
      if (staleByDate) {
        logger.info(
          {
            userId,
            itemRowId,
            plaidItemIdExternal: item.itemId,
            institutionName: item.institutionName,
            lastBankOccurredOn: lastBank,
          },
          "[plaid-sync] stale cursor on user-initiated sync — falling back to /transactions/get gap-backfill",
        );
        try {
          // (#720) overlapDays:1 so the window is
          // (lastBankTxOn-1d, today]. Without overlap a pending→posted
          // flip whose posted date equals lastBankTxOn would be
          // excluded — the very class of bug the fallback exists to
          // fix.
          const bf = await runGapBackfillForItem(userId, itemRowId, {
            overlapDays: 1,
          });
          backfillAdded += bf.added;
          backfillRan = true;
          if (bf.importedDateRange) {
            backfillRange = backfillRange
              ? {
                  min:
                    bf.importedDateRange.min < backfillRange.min
                      ? bf.importedDateRange.min
                      : backfillRange.min,
                  max:
                    bf.importedDateRange.max > backfillRange.max
                      ? bf.importedDateRange.max
                      : backfillRange.max,
                }
              : bf.importedDateRange;
          }
          if (bf.added > 0) deliveryMode = "gap-backfill";
        } catch (e) {
          logger.warn(
            { userId, itemRowId, err: e },
            "[plaid-sync] stale-cursor gap-backfill failed (non-fatal)",
          );
        }
      }
    }
    // (#720) Promote backfill's freshest date into lastOccurredOn so
    // the post-sync toast says "through May 18" instead of clinging to
    // the stale max it computed from the empty cursor delta.
    if (
      backfillRange &&
      (!lastOccurredOn || backfillRange.max > lastOccurredOn)
    ) {
      lastOccurredOn = backfillRange.max;
    }
    let mergedMin: string | null = insertedMinDate as string | null;
    let mergedMax: string | null = insertedMaxDate as string | null;
    if (backfillRange) {
      if (mergedMin === null || backfillRange.min < mergedMin) mergedMin = backfillRange.min;
      if (mergedMax === null || backfillRange.max > mergedMax) mergedMax = backfillRange.max;
    }
    // (#732) Re-fire the Amex anchor refresh AFTER any gap-backfill —
    // the backfill's vanished-pending sweep can delete rows that
    // contributed to the anchor balance, and the existing post-cursor
    // refresh above ran before those deletes. Without this second
    // call, a Metro pre-auth that vanishes via the gap-backfill path
    // would clear from transactions but leave the Amex anchor inflated
    // until the next sync.
    if (slug === "amex" && backfillRan) {
      try {
        await refreshAmexAnchor(ownerUserId, db, { adopt: false });
      } catch {
        // Best-effort; the next sync's anchor refresh will catch up.
      }
    }
    // (#671) Single structured delivery-metrics log line per successful
    // sync. Lets support correlate "where did my pending charge go?"
    // tickets against the per-item picture (which path triggered the
    // sync, did /transactions/refresh fire, how many cursor walks did
    // we burn before data arrived, what's the freshest date Plaid
    // gave us) without piecing together half a dozen ad-hoc warnings.
    logger.info(
      {
        userId,
        itemRowId,
        plaidItemIdExternal: item.itemId,
        institutionName: item.institutionName,
        institutionSlug: slug,
        forceRefresh,
        refreshSucceeded,
        pollAttemptsUsed,
        pollRetriesExhaustedEmpty,
        added: added.length,
        modified: modified.length,
        removed: removed.length,
        // (#671) Pending-rows count surfaced separately so support can
        // tell at a glance whether a "no new rows" delivery actually
        // landed pending charges (the most common user complaint) vs
        // a true no-op cycle.
        pending:
          added.filter((t) => (t as { pending?: boolean }).pending === true)
            .length +
          modified.filter((t) => (t as { pending?: boolean }).pending === true)
            .length,
        backfillAdded,
        skippedPreCutoff: firstSyncSkipped,
        lastOccurredOn,
        wasUnhealthy,
        deliveryMode,
      },
      "[plaid-sync] delivery metrics",
    );
    return {
      itemId: item.itemId,
      plaidItemRowId: itemRowId,
      institutionName: item.institutionName,
      added: added.length + backfillAdded,
      modified: modified.length,
      removed: removed.length,
      autoCategorized,
      ruleAttributions,
      // (#403) Min/max date among the rows we actually wrote — null
      // when nothing was inserted.
      importedDateRange:
        mergedMin && mergedMax
          ? { min: mergedMin, max: mergedMax }
          : null,
      error: balanceRefreshError,
      lastOccurredOn,
      // (#662) Surface how many `added` rows the first-sync gate
      // dropped on this run so observability catches future
      // regressions where live rows get silently filtered.
      skippedPreCutoff: firstSyncSkipped,
      // (#665) Echo whether we asked Plaid to re-fetch from the bank
      // before walking the cursor. True for user-triggered syncs.
      refreshAttempted: forceRefresh,
      // (#723) Plain-English reason the refresh path was effectively a
      // no-op (currently only set when the client lacks the
      // `transactions_refresh` add-on). The UI swaps the misleading
      // "still preparing the initial batch" toast for honest copy when
      // this is set on any item in the response.
      refreshDisabledReason,
      // (#723) Prior `lastSyncedAt` for this item (before this run
      // overwrote it with `now`). Lets the honest refresh-disabled
      // toast tell the user *when* the data they're looking at was
      // last refreshed by Plaid — "Data is current as of 4h ago" —
      // so they don't keep clicking Sync expecting fresher numbers.
      lastSyncedAt: item.lastSyncedAt
        ? new Date(item.lastSyncedAt).toISOString()
        : null,
      // (#671) Signal Layer-1 "Plaid hasn't ingested yet" so the UI
      // skips the destructive "Added 0" toast and offers a retry.
      // Same semantics as the PRODUCT_NOT_READY catch path.
      ...(pollRetriesExhaustedEmpty ? { stillPreparing: true } : {}),
      // (#720) Surface which Plaid path produced these rows so the
      // success toast can say "Caught up Chase via direct fetch" when
      // the gap-backfill rescued a stuck cursor.
      deliveryMode,
      // (#728) Names of the rows this sync added (capped at 5) so the
      // success toast can read "Added 3: VENMO, KROGER, +1 more"
      // rather than a bare "Added 3" count.
      addedDescriptions,
      // (#357) Mirror the structured fields onto the response so a
      // failed balance refresh on an otherwise-healthy /transactions/sync
      // still gives the client a real Plaid code + display message + kind
      // to render in the toast — never just "Balance refresh failed".
      plaidErrorCode: balanceErrorDetails?.code ?? null,
      plaidErrorMessage: balanceErrorDetails?.message ?? null,
      plaidDisplayMessage: balanceErrorDetails?.displayMessage ?? null,
      requestId: balanceErrorDetails?.requestId ?? null,
      httpStatus: balanceErrorDetails?.httpStatus ?? null,
      kind: balanceErrorDetails?.kind ?? null,
    };
  } catch (e) {
    const extracted = extractPlaidError(e);
    const { code, message } = extracted;
    // PRODUCT_NOT_READY is Plaid still staging the historical batch for a
    // freshly linked item. It is transient and recovers on its own (or on
    // the very next Sync click). Don't write it into last_sync_error and
    // don't surface a destructive `error` to the client; instead flag it as
    // "still preparing" so the UI can render an encouraging neutral toast.
    if (code === "PRODUCT_NOT_READY") {
      // Stamp a "still preparing since" timestamp so the Settings page can
      // surface a per-item badge until the next successful sync clears it.
      // We deliberately do NOT touch lastSyncError — PRODUCT_NOT_READY is
      // transient and would clobber a real, actionable error from a prior run.
      await db
        .update(plaidItemsTable)
        .set({ stillPreparingSince: new Date() })
        .where(eq(plaidItemsTable.id, itemRowId));
      // (#279) Record the still-preparing outcome so the Recent
      // activity panel shows the warm-up phase, not just the eventual
      // first success. Treated as a failure with the PRODUCT_NOT_READY
      // code so support can see how long the warm-up took.
      await recordPlaidSyncAttempt({
        userId,
        plaidItemId: itemRowId,
        kind: "transactions",
        success: false,
        errorCode: code,
        errorMessage: message,
        plaidDisplayMessage: extracted.displayMessage,
        requestId: extracted.requestId,
        httpStatus: extracted.httpStatus,
        errorKind: "transient",
      });
      return {
        itemId: item.itemId,
        plaidItemRowId: itemRowId,
        institutionName: item.institutionName,
        added: 0,
        modified: 0,
        removed: 0,
        autoCategorized: 0,
        ruleAttributions: [],
        error: null,
        stillPreparing: true,
        // (#357) PRODUCT_NOT_READY is structurally an error even though
        // we surface it as a neutral toast — include the metadata so
        // Settings → Recent activity / mobile can render the same
        // structured payload as any other failure.
        plaidErrorCode: code,
        plaidErrorMessage: message,
        plaidDisplayMessage: extracted.displayMessage,
        requestId: extracted.requestId,
        httpStatus: extracted.httpStatus,
        kind: "transient",
      };
    }
    // (#238) When Plaid returns a re-auth code that carries a consent
    // cutoff (PENDING_EXPIRATION / PENDING_DISCONNECT) refresh the stored
    // `consent_expiration_time` so the dated banner copy ("Chase will
    // disconnect on May 21") reflects the latest cutoff Plaid reports.
    // Best-effort: any failure here must not mask the original sync
    // error we still need to write below.
    let refreshedConsentExpirationAt: Date | null | undefined = undefined;
    // (#265) Track the consent-refresh /item/get outcome separately
    // from the wrapping sync error so we can persist a clear, inline
    // failure reason next to "Disconnect date checked …" on Settings
    // without clobbering it on the next healthy sync.
    let consentRefreshError: string | null = null;
    let consentRefreshErrorCode: string | null = null;
    let consentRefreshSucceeded = false;
    if (code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT") {
      try {
        const itemResp = await plaid().itemGet({
          access_token: item.accessToken,
        });
        const cet = (itemResp.data.item as unknown as {
          consent_expiration_time?: string | null;
        }).consent_expiration_time;
        if (cet) {
          const parsed = new Date(cet);
          if (!Number.isNaN(parsed.getTime())) {
            refreshedConsentExpirationAt = parsed;
          } else {
            refreshedConsentExpirationAt = null;
          }
        } else {
          refreshedConsentExpirationAt = null;
        }
        consentRefreshSucceeded = true;
      } catch (refreshErr) {
        // Leave the previously stored cutoff value alone if /item/get
        // fails, but capture the reason so the Settings row can show
        // a "Couldn't verify disconnect date: …" line.
        const refreshed = extractPlaidError(refreshErr);
        consentRefreshError = refreshed.message;
        consentRefreshErrorCode = refreshed.code;
      }
    }
    await db
      .update(plaidItemsTable)
      .set({
        lastSyncError: message,
        lastSyncErrorCode: code,
        // (#258) Stamp the freshness timestamp whenever /item/get
        // succeeded, regardless of whether the cutoff value actually
        // moved. Lets support tell "the cutoff is current" apart from
        // "we have not been able to reach Plaid for this item lately".
        ...(consentRefreshSucceeded
          ? {
              consentExpirationAt: refreshedConsentExpirationAt,
              consentExpirationLastRefreshedAt: new Date(),
              // (#265) Clear any previously persisted consent-refresh
              // error now that /item/get has succeeded again.
              consentExpirationLastRefreshError: null,
              consentExpirationLastRefreshErrorCode: null,
            }
          : {}),
        // (#265) Persist the /item/get failure reason so Settings can
        // render it inline under "Disconnect date checked …".
        ...(consentRefreshError !== null
          ? {
              consentExpirationLastRefreshError: consentRefreshError,
              consentExpirationLastRefreshErrorCode: consentRefreshErrorCode,
            }
          : {}),
      })
      .where(eq(plaidItemsTable.id, itemRowId));
    // (#279) Audit the failed transactions sync so the Recent activity
    // panel can show "failed 4 of the last 10".
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "transactions",
      success: false,
      errorCode: code,
      errorMessage: message,
      plaidDisplayMessage: extracted.displayMessage,
      requestId: extracted.requestId,
      httpStatus: extracted.httpStatus,
      errorKind: extracted.kind,
    });
    // (#357) Always log the full structured Plaid context on the catch
    // path so a user-reported "Couldn't sync Chase" ticket can be
    // root-caused from server logs alone — request_id, http_status,
    // error_code, display_message, item, institution.
    logger.warn(
      {
        userId,
        plaidItemId: itemRowId,
        plaidItemIdExternal: item.itemId,
        institutionName: item.institutionName,
        plaidErrorCode: code,
        plaidErrorMessage: message,
        plaidDisplayMessage: extracted.displayMessage,
        requestId: extracted.requestId,
        httpStatus: extracted.httpStatus,
        errorKind: extracted.kind,
        rawError:
          e instanceof Error ? { name: e.name, message: e.message } : String(e),
      },
      "[plaid-sync] /transactions/sync failed",
    );
    // (#671) Mirror the success-path delivery metrics on the failure
    // path too so "why didn't my pending charge land?" tickets always
    // have one structured line per attempt regardless of outcome.
    logger.info(
      {
        userId,
        itemRowId,
        plaidItemIdExternal: item.itemId,
        institutionName: item.institutionName,
        forceRefresh,
        refreshSucceeded,
        pollAttemptsUsed,
        added: 0,
        modified: 0,
        removed: 0,
        backfillAdded: 0,
        skippedPreCutoff: 0,
        lastOccurredOn: null,
        wasUnhealthy,
        failed: true,
        plaidErrorCode: code,
        errorKind: extracted.kind,
      },
      "[plaid-sync] delivery metrics",
    );
    return {
      itemId: item.itemId,
      plaidItemRowId: itemRowId,
      institutionName: item.institutionName,
      added: 0,
      modified: 0,
      removed: 0,
      autoCategorized: 0,
      ruleAttributions: [],
      error: message,
      // (#357) Carry the full structured Plaid failure to the client so
      // the toast can show "<Institution>: <plain English reason>" and
      // surface a Reconnect CTA for kind=reauth without ever exposing
      // raw axios "Request failed with status code 400" strings.
      plaidErrorCode: code,
      plaidErrorMessage: message,
      plaidDisplayMessage: extracted.displayMessage,
      requestId: extracted.requestId,
      httpStatus: extracted.httpStatus,
      kind: extracted.kind,
    };
  }
}

/**
 * (#623) Scope is now per-household (every household member sees the
 * same set of linked items), not per-actor. `actorUserId` is the
 * signed-in user used for audit logging on each per-item sync.
 */
/**
 * (#671 follow-up) Delete transactions left behind when an old plaid_item
 * was deleted (e.g. a sandbox-token item the user re-linked in
 * production). Their `plaid_account_id` points at a `plaid_accounts.id`
 * that no longer exists, so:
 *   * they can never be refreshed by Plaid again (no item, no token),
 *   * their `plaid_transaction_id` never collides with the new item's
 *     freshly-issued ids, so the existing onConflict / first-sync merge
 *     can't dedupe them, and
 *   * they appear as 1-for-1 ghost twins of every row the relinked item
 *     just brought in, flooding the forecast review bucket.
 * Run once at the top of every household sync — idempotent, scoped to a
 * single household, and only ever touches rows whose Plaid account row
 * is gone for good. If the user merely un-linked an item temporarily,
 * its plaid_accounts rows survive (item-delete is what cascades them),
 * so those transactions are left alone.
 */
export async function pruneOrphanPlaidTransactionsForHousehold(
  householdId: string,
): Promise<number> {
  const result = await db
    .delete(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        sql`${transactionsTable.plaidTransactionId} is not null`,
        sql`${transactionsTable.plaidAccountId} is not null`,
        sql`not exists (select 1 from ${plaidAccountsTable}
              where ${plaidAccountsTable.accountId} = ${transactionsTable.plaidAccountId})`,
        // Never delete a transaction the user has TOUCHED. An "orphan" here
        // usually means the account row was momentarily re-materialized (e.g.
        // a resync, or two Amex cards sharing mask ··1009 colliding on
        // reconnect) — pruning a categorized / allowance-flagged row in that
        // window destroys the user's work, which is exactly the data loss we
        // hit. Only prune pristine, untouched rows; anything carrying a
        // category, an allowance bucket, a reimbursable/reviewed mark, or a
        // manual override survives and gets re-linked on the next account
        // refresh instead.
        sql`${transactionsTable.categoryId} is null`,
        eq(transactionsTable.weeklyAllowance, false),
        eq(transactionsTable.monthlyAllowance, false),
        eq(transactionsTable.unplannedAllowance, false),
        eq(transactionsTable.reimbursable, false),
        eq(transactionsTable.reviewed, false),
        eq(transactionsTable.isTransferUserOverridden, false),
        eq(transactionsTable.occurredOnUserOverridden, false),
      ),
    )
    .returning({ id: transactionsTable.id });
  if (result.length > 0) {
    logger.info(
      { householdId, prunedCount: result.length },
      "[plaid-sync] pruned orphan plaid transactions (account row deleted with a prior item)",
    );
  }
  return result.length;
}

export async function syncAllForUser(
  actorUserId: string,
  householdId: string,
  opts: {
    forceRefresh?: boolean;
    syncOrigin?: "manual" | "webhook" | "cron" | "internal";
  } = {},
): Promise<SyncResult[]> {
  // (#671 follow-up) Cull orphans BEFORE we fetch the new batch so the
  // first-sync merge inside `syncPlaidItem` doesn't have to compete
  // with rows that already carry a (now-meaningless) plaidTransactionId
  // — those rows would otherwise survive as ghost twins of every line
  // the relinked item brings back.
  await pruneOrphanPlaidTransactionsForHousehold(householdId);
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.householdId, householdId));
  // (#speed) Run every item's sync in PARALLEL. The serialization inside
  // syncPlaidItemSerialized is keyed per-item (itemRowId), so distinct items
  // never race each other — only a same-item concurrent webhook sync queues
  // behind this one. A household with Chase + Amex now waits for ONE live bank
  // refresh window, not the sum of both back-to-back.
  // (#671) Per-item promise chain still guards same-item concurrency.
  const out = await Promise.all(
    items.map((it) => syncPlaidItemSerialized(actorUserId, it.id, opts)),
  );
  return out;
}

export async function syncAllForAllUsers(
  opts: {
    forceRefresh?: boolean;
    syncOrigin?: "manual" | "webhook" | "cron" | "internal";
  } = {},
): Promise<void> {
  // Use the linker's userId as the actor for audit purposes; the
  // sync itself derives household scope from item.householdId.
  const items = await db
    .select({
      id: plaidItemsTable.id,
      userId: plaidItemsTable.userId,
      lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
    })
    .from(plaidItemsTable);
  for (const it of items) {
    // (#671) On the frequent forced-refresh loop, skip items already
    // sitting in a reauth state — calling /transactions/refresh on a
    // login-required item just burns quota and risks compounding the
    // rate-limit. Hourly cron (forceRefresh=false) walks them anyway
    // to surface a fresh chip if the user fixed things out-of-band.
    if (
      opts.forceRefresh &&
      it.lastSyncErrorCode &&
      PLAID_REAUTH_ERROR_CODES.has(it.lastSyncErrorCode)
    ) {
      continue;
    }
    try {
      await syncPlaidItemSerialized(it.userId, it.id, opts);
    } catch {
      // continue
    }
  }
}

// (#671) Per-item promise chain so background loops, webhook flushes,
// and manual user clicks for the same item never overlap. Two concurrent
// /transactions/sync calls with the same starting cursor would each
// fetch the same batch, both upsert (idempotent on the conflict key but
// wasteful), and race to write `cursor`; whichever wrote last could
// rewind the other's advance and silently drop the in-between batch on
// the *next* sync. Chaining serializes calls per item without blocking
// other items.
const itemSyncChain = new Map<string, Promise<unknown>>();

export async function syncPlaidItemSerialized(
  userId: string,
  itemRowId: string,
  opts: {
    forceRefresh?: boolean;
    syncOrigin?: "manual" | "webhook" | "cron" | "internal";
  } = {},
): Promise<SyncResult> {
  const prior = itemSyncChain.get(itemRowId) ?? Promise.resolve();
  const next: Promise<SyncResult> = prior
    .catch(() => {})
    .then(() => syncPlaidItem(userId, itemRowId, opts));
  itemSyncChain.set(itemRowId, next);
  try {
    return await next;
  } finally {
    if (itemSyncChain.get(itemRowId) === next) {
      itemSyncChain.delete(itemRowId);
    }
  }
}

// Test helper — clears the per-item serialization chain. The tests own
// the mock plaid client and reset state between cases; leaving stale
// chained promises across tests can leak rerun work into the wrong
// suite.
export function _resetPlaidSyncChainForTests(): void {
  itemSyncChain.clear();
}

export type ConsentRefreshResult = {
  itemRowId: string;
  itemId: string;
  institutionName: string | null;
  consentExpirationAt: string | null;
  // (#258) Wall-clock timestamp of when this refresh completed (i.e. the
  // value we just wrote into `consent_expiration_last_refreshed_at`).
  // Null when the refresh failed before /item/get returned, so callers
  // can tell "Plaid said nothing changed" apart from "we never reached
  // Plaid this run". Useful for the manual-trigger response and tests.
  consentExpirationLastRefreshedAt: string | null;
  changed: boolean;
  error: string | null;
};

/**
 * (#253) Refresh the cached `consent_expiration_time` for a single Plaid
 * item by calling /item/get and persisting whatever Plaid currently
 * reports. Best-effort: any error is captured on the returned record but
 * never thrown — callers (the daily cron, the admin endpoint) should not
 * have one bad item poison the whole batch.
 *
 * Why this exists separately from the on-sync refresh path:
 *   - syncPlaidItem() already refreshes consent_expiration_time when sync
 *     hits PENDING_EXPIRATION / PENDING_DISCONNECT, but a healthy item
 *     that is silently approaching its cutoff never lands in that branch.
 *   - Plaid sometimes rolls the cutoff forward when the user partially
 *     re-consents in another flow, so the stored value can drift even on
 *     items we never get a sync error for.
 * Running this once a day keeps the dated banner copy ("Chase will
 * disconnect on May 21") honest regardless of whether the user opens the
 * app or sync ever errors.
 */
export async function refreshConsentExpirationForItem(
  itemRowId: string,
): Promise<ConsentRefreshResult> {
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.id, itemRowId));
  if (!item) {
    return {
      itemRowId,
      itemId: itemRowId,
      institutionName: null,
      consentExpirationAt: null,
      consentExpirationLastRefreshedAt: null,
      changed: false,
      error: "Item not found",
    };
  }
  // (#398) Synthetic seed rows have no upstream Plaid item — skip the
  // /item/get call (and the malformed-token flagging) entirely.
  if (isSyntheticPlaidItem(item)) {
    return {
      itemRowId: item.id,
      itemId: item.itemId,
      institutionName: item.institutionName,
      consentExpirationAt: null,
      consentExpirationLastRefreshedAt: null,
      changed: false,
      error: null,
    };
  }
  // (#366) Same malformed-token guard as syncPlaidItem — never invoke
  // /item/get with a value that can't possibly be a valid Plaid token.
  // Marks the item as needing reconnect so the daily cron's failure
  // count surfaces it, but the user-visible state is the friendly
  // "reconnect" copy rather than an opaque Plaid 400 echoed verbatim.
  if (!isValidPlaidAccessToken(item.accessToken)) {
    await markItemMalformedToken(item.id);
    return {
      itemRowId: item.id,
      itemId: item.itemId,
      institutionName: item.institutionName,
      consentExpirationAt: item.consentExpirationAt
        ? item.consentExpirationAt.toISOString()
        : null,
      consentExpirationLastRefreshedAt: item.consentExpirationLastRefreshedAt
        ? item.consentExpirationLastRefreshedAt.toISOString()
        : null,
      changed: false,
      error: MALFORMED_PLAID_TOKEN_MESSAGE,
    };
  }
  // (#654) Env-mismatch guard — same rationale as the syncPlaidItem
  // env-mismatch branch. Don't call /item/get with a token Plaid will
  // bounce; flag the item as INVALID_ACCESS_TOKEN so the Reconnect CTA
  // shows up.
  if (!isAccessTokenForCurrentEnv(item.accessToken)) {
    await markItemMalformedToken(item.id, {
      code: "INVALID_ACCESS_TOKEN",
      message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
    });
    return {
      itemRowId: item.id,
      itemId: item.itemId,
      institutionName: item.institutionName,
      consentExpirationAt: item.consentExpirationAt
        ? item.consentExpirationAt.toISOString()
        : null,
      consentExpirationLastRefreshedAt: item.consentExpirationLastRefreshedAt
        ? item.consentExpirationLastRefreshedAt.toISOString()
        : null,
      changed: false,
      error: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
    };
  }
  try {
    const itemResp = await plaid().itemGet({ access_token: item.accessToken });
    const cet = (itemResp.data.item as unknown as {
      consent_expiration_time?: string | null;
    }).consent_expiration_time;
    let next: Date | null = null;
    if (cet) {
      const parsed = new Date(cet);
      if (!Number.isNaN(parsed.getTime())) next = parsed;
    }
    const prev = item.consentExpirationAt
      ? item.consentExpirationAt.getTime()
      : null;
    const nextMs = next ? next.getTime() : null;
    const changed = prev !== nextMs;
    // (#258) Always stamp the freshness timestamp on a successful
    // /item/get — even when `changed=false`. The whole point of the
    // column is to let support answer "did the daily refresh actually
    // run for this item today?" without diffing logs, so skipping the
    // write on no-change would defeat the purpose. The cutoff value
    // itself is only re-written when it actually moved (avoids needless
    // row churn / tuple bloat on stable items).
    const refreshedAt = new Date();
    await db
      .update(plaidItemsTable)
      .set({
        consentExpirationLastRefreshedAt: refreshedAt,
        ...(changed ? { consentExpirationAt: next } : {}),
        // (#265) Clear any previously persisted consent-refresh
        // error now that /item/get has succeeded again.
        consentExpirationLastRefreshError: null,
        consentExpirationLastRefreshErrorCode: null,
      })
      .where(eq(plaidItemsTable.id, itemRowId));
    return {
      itemRowId: item.id,
      itemId: item.itemId,
      institutionName: item.institutionName,
      consentExpirationAt: next ? next.toISOString() : null,
      consentExpirationLastRefreshedAt: refreshedAt.toISOString(),
      changed,
      error: null,
    };
  } catch (e) {
    const { code, message } = extractPlaidError(e);
    // (#265) Persist the failure so a user who walks away after the
    // manual or cron-driven refresh can still see *why* this item's
    // disconnect-date check failed without having to re-trigger the
    // refresh. Distinct from `last_sync_error` so a healthy
    // /transactions/sync does not erase the consent-refresh failure.
    await db
      .update(plaidItemsTable)
      .set({
        consentExpirationLastRefreshError: message,
        consentExpirationLastRefreshErrorCode: code,
      })
      .where(eq(plaidItemsTable.id, itemRowId));
    return {
      itemRowId: item.id,
      itemId: item.itemId,
      institutionName: item.institutionName,
      consentExpirationAt: item.consentExpirationAt
        ? item.consentExpirationAt.toISOString()
        : null,
      // (#258) /item/get failed, so the stored cutoff is exactly as
      // stale as before this call. Echo back whatever timestamp we
      // already had on the row (or null) so the manual-trigger UI does
      // not falsely advertise a fresh verification.
      consentExpirationLastRefreshedAt: item.consentExpirationLastRefreshedAt
        ? item.consentExpirationLastRefreshedAt.toISOString()
        : null,
      changed: false,
      error: message,
    };
  }
}

/**
 * (#253) Refresh consent_expiration_time for every Plaid item belonging
 * to a single user. Best-effort: per-item failures are captured on the
 * returned record list but never thrown.
 */
export async function refreshConsentExpirationForUser(
  householdId: string,
): Promise<ConsentRefreshResult[]> {
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.householdId, householdId));
  const out: ConsentRefreshResult[] = [];
  for (const it of items) {
    out.push(await refreshConsentExpirationForItem(it.id));
  }
  return out;
}

/**
 * (#253) Daily background job: walk every active Plaid item across every
 * user and refresh the cached consent_expiration_time. Errors are logged
 * (per-item) but never thrown — the cron must never crash the process or
 * abort early on a single bad item.
 */
/**
 * (#366) One-shot backfill scan: walks every `plaid_items` row and flips
 * those whose stored `access_token` fails `isValidPlaidAccessToken`
 * into the synthetic `ITEM_LOGIN_REQUIRED` "needs reconnect" state.
 * Idempotent — running it again on a row already flagged is a no-op
 * write that does not surface to the user.
 *
 * Wired from `index.ts` to run once on boot so any pre-existing bad
 * row immediately renders the Reconnect CTA, without waiting for the
 * next sync attempt to discover the same condition. Returns counts so
 * boot logs can surface "scanned 12 plaid items, flagged 1 malformed
 * token" instead of being silent on the recovery action.
 */
export type FlaggedMalformedItem = {
  itemRowId: string;
  itemId: string;
  institutionName: string | null;
};

export async function flagMalformedAccessTokens(): Promise<{
  scanned: number;
  flagged: number;
  flaggedItems: FlaggedMalformedItem[];
}> {
  const items = await db
    .select({
      id: plaidItemsTable.id,
      accessToken: plaidItemsTable.accessToken,
      itemId: plaidItemsTable.itemId,
      institutionName: plaidItemsTable.institutionName,
      lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
    })
    .from(plaidItemsTable);
  let flagged = 0;
  const flaggedItems: FlaggedMalformedItem[] = [];
  for (const it of items) {
    // (#398) Don't count synthetic seed rows as malformed — they're a
    // known placeholder for the bank-snapshot tile, not a real Plaid
    // connection. Treating them as "flagged" inflates the daily
    // health-check spike alert (#371) and re-poisons /plaid/items
    // every cron tick.
    if (isSyntheticPlaidItem(it)) continue;
    const malformed = !isValidPlaidAccessToken(it.accessToken);
    // (#654) Treat env-mismatched-but-well-formed tokens the same as
    // malformed for the daily backfill sweep — Plaid will reject every
    // call against them with INVALID_ACCESS_TOKEN, so the user needs
    // the same Reconnect CTA without waiting for the next sync cycle
    // to re-stamp the row.
    const envMismatch =
      !malformed && !isAccessTokenForCurrentEnv(it.accessToken);
    if (!malformed && !envMismatch) continue;
    flagged++;
    flaggedItems.push({
      itemRowId: it.id,
      itemId: it.itemId,
      institutionName: it.institutionName,
    });
    // Always write — same value twice is harmless, and we can't
    // distinguish a "real" ITEM_LOGIN_REQUIRED from our synthetic one
    // without re-checking the message column.
    if (envMismatch) {
      await markItemMalformedToken(it.id, {
        code: "INVALID_ACCESS_TOKEN",
        message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
      });
    } else {
      await markItemMalformedToken(it.id);
    }
    logger.warn(
      {
        itemRowId: it.id,
        plaidItemIdExternal: it.itemId,
        institutionName: it.institutionName,
        envMismatch,
      },
      "[plaid-backfill] flagged item with unusable stored access_token as needs-reconnect",
    );
  }
  return { scanned: items.length, flagged, flaggedItems };
}

/**
 * (#408) One-shot date-window backfill via Plaid's /transactions/get
 * for an item that just transitioned from a malformed-token / re-auth
 * error state back to healthy. The cursor-based /transactions/sync
 * loop in {@link syncPlaidItem} alone does NOT recover transactions
 * Plaid advanced past while the access_token was unusable: the cursor
 * was server-stamped at the last successful sync, and Plaid's sync
 * stream only replays from there forward — anything that *was already
 * past* the cursor when sync next ran is gone.
 *
 * For each account on the item we compute `lastBankTxOn` (the newest
 * Plaid-sourced occurredOn on file for that account), then ask
 * /transactions/get for `(lastBankTxOn, today]`. Returned rows are
 * upserted with `onConflictDoUpdate` keyed on plaid_transaction_id so
 * a row already pulled by the cursor sync becomes a no-op write
 * (idempotent — running this multiple times is safe). The same
 * ±7-day merge against unattached manual rows that the first-sync
 * gate uses runs here too so a manual entry the user added during
 * the outage is adopted in place instead of duplicated.
 *
 * Best-effort: any per-account or per-page failure is logged and the
 * scan continues — backfill must never poison the wrapping sync.
 *
 * `overlapDays` (default 0) extends the start of the window backwards
 * by N days. The stale-cursor fallback passes 1 so the window becomes
 * `(lastBankTxOn - 1 day, today]` — that overlap is what catches a
 * pending→posted lifecycle flip that landed on the same date as the
 * latest row already on file (without overlap we'd compute
 * `start = lastBankTxOn + 1`, exclude that day from /transactions/get,
 * and miss the posting that was previously pending). The upserts are
 * idempotent on plaid_transaction_id, so revisiting overlap days is
 * cheap and safe.
 */
export async function runGapBackfillForItem(
  userId: string,
  itemRowId: string,
  opts: { today?: Date; overlapDays?: number } = {},
): Promise<{
  added: number;
  importedDateRange: { min: string; max: string } | null;
  perAccount: Array<{
    externalAcctId: string;
    start: string;
    end: string;
    added: number;
  }>;
}> {
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.id, itemRowId));
  if (!item) {
    return { added: 0, importedDateRange: null, perAccount: [] };
  }
  if (!isValidPlaidAccessToken(item.accessToken)) {
    return { added: 0, importedDateRange: null, perAccount: [] };
  }
  // (#654) Env-mismatch guard. Same rationale as syncPlaidItem — a
  // sandbox-prefixed token on a production server would be bounced by
  // Plaid on every /transactions/get page. Bail before the per-account
  // loop hammers Plaid with calls it can't satisfy. Wrapping callers
  // (syncPlaidItem, the manual /plaid/sync route) have already
  // short-circuited and stamped the reauth state, so this is a
  // belt-and-braces guard for any future direct caller.
  if (!isAccessTokenForCurrentEnv(item.accessToken)) {
    return { added: 0, importedDateRange: null, perAccount: [] };
  }
  // (#623) See syncPlaidItem comment — actor is `userId`; data scope
  // (`householdId`, `ownerUserId`) is derived from the item itself so a
  // member can backfill any of the household's items.
  const householdId = item.householdId!;
  const [householdRow] = await db
    .select({ ownerUserId: householdsTable.ownerUserId })
    .from(householdsTable)
    .where(eq(householdsTable.id, householdId));
  const ownerUserId = householdRow?.ownerUserId ?? userId;
  const slug = item.institutionSlug || institutionSlug(item.institutionName);
  const source = `plaid:${slug}`;
  const rules = await loadUserRules(householdId);

  const accounts = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.itemId, itemRowId),
        eq(plaidAccountsTable.householdId, householdId),
      ),
    );
  if (accounts.length === 0) {
    return { added: 0, importedDateRange: null, perAccount: [] };
  }

  const linkedDebts = await db
    .select({
      debtId: debtsTable.id,
      plaidAccountRowId: debtsTable.plaidAccountId,
    })
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const debtIdByExternal = new Map<string, string>();
  const debtIdsByAcctRowId = new Map<string, string[]>();
  for (const d of linkedDebts) {
    if (!d.plaidAccountRowId) continue;
    const acct = accounts.find((a) => a.id === d.plaidAccountRowId);
    if (acct) {
      debtIdByExternal.set(acct.accountId, d.debtId);
      const arr = debtIdsByAcctRowId.get(acct.id) ?? [];
      arr.push(d.debtId);
      debtIdsByAcctRowId.set(acct.id, arr);
    }
  }
  // (#408) Mirror first-sync merge scope handling — without this, a
  // checking-account backfill would not adopt unattached manual rows
  // the user added during the outage and could insert duplicate
  // Plaid rows at the same date/amount.
  const [forecastSettings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  const checkingAcctRowId = forecastSettings?.bankSnapshotAccountId ?? null;

  const today = opts.today ?? new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const addDay = (ymd: string): string => {
    const d = parseISO(ymd);
    return fmtISO(addDays(d, 1));
  };

  let totalAdded = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  const perAccount: Array<{
    externalAcctId: string;
    start: string;
    end: string;
    added: number;
  }> = [];

  for (const acct of accounts) {
    const externalAcctId = acct.accountId;
    // Newest Plaid-sourced row for this account on file. Source is
    // matched via the plaid_account_id column rather than `source`
    // since rows merged in from manual entries also carry that fk.
    const [latest] = await db
      .select({ occurredOn: transactionsTable.occurredOn })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          eq(transactionsTable.plaidAccountId, externalAcctId),
        ),
      )
      .orderBy(sql`${transactionsTable.occurredOn} desc`)
      .limit(1);
    const lastBankTxOn = latest?.occurredOn ?? null;
    let startStr: string | null = null;
    // (#720) overlapDays widens the window backwards so a
    // pending→posted lifecycle flip on `lastBankTxOn` itself isn't
    // excluded by `addDay(...)`. Idempotent upsert on
    // plaid_transaction_id makes the re-fetched day a no-op when no
    // such flip happened.
    const overlap = Math.max(0, opts.overlapDays ?? 0);
    if (lastBankTxOn) {
      startStr =
        overlap > 0
          ? fmtISO(addDays(parseISO(lastBankTxOn), -overlap))
          : addDay(lastBankTxOn);
    } else if (acct.importCutoffDate) {
      startStr =
        overlap > 0
          ? fmtISO(addDays(parseISO(acct.importCutoffDate), -overlap))
          : addDay(acct.importCutoffDate);
    }
    // (#734) Widen startStr backwards to also cover the oldest local
    // pending for this account. Without this, the gap-backfill window
    // is anchored at `max(occurredOn)` so any vanished pre-auth older
    // than the most recent activity on the card escapes the
    // vanished-pending sweep — the moment a newer pending lands
    // locally the floor jumps past every older still-pending row.
    // Asking Plaid about the full pending range keeps the sweep
    // window's coverage matched to the cursor path's.
    const [oldestPending] = await db
      .select({ occurredOn: transactionsTable.occurredOn })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          eq(transactionsTable.plaidAccountId, externalAcctId),
          eq(transactionsTable.pending, true),
        ),
      )
      .orderBy(sql`${transactionsTable.occurredOn} asc`)
      .limit(1);
    const oldestLocalPendingOn = oldestPending?.occurredOn ?? null;
    if (oldestLocalPendingOn) {
      if (!startStr || oldestLocalPendingOn < startStr) {
        startStr = oldestLocalPendingOn;
      }
    }
    if (!startStr || startStr > todayStr) {
      perAccount.push({
        externalAcctId,
        start: startStr ?? "",
        end: todayStr,
        added: 0,
      });
      continue;
    }

    let acctAdded = 0;
    try {
      const all: PlaidTxn[] = [];
      let offset = 0;
      const pageSize = 500;
      // Hard cap on pages to bound a runaway loop in case of a
      // malformed Plaid response.
      for (let page = 0; page < 20; page++) {
        const resp = await plaid().transactionsGet({
          access_token: item.accessToken,
          start_date: startStr,
          end_date: todayStr,
          options: {
            account_ids: [externalAcctId],
            count: pageSize,
            offset,
          },
        });
        const batch = (resp.data.transactions ?? []) as PlaidTxn[];
        all.push(...batch);
        const total = (resp.data as { total_transactions?: number })
          .total_transactions;
        if (
          batch.length < pageSize ||
          (typeof total === "number" && all.length >= total)
        ) {
          break;
        }
        offset += batch.length;
      }

      for (const t of all) {
        const description = t.merchant_name || t.name || "(no description)";
        const pfc = (t as unknown as {
          personal_finance_category?: { primary?: string; detailed?: string } | null;
        }).personal_finance_category;
        const cat = categorize(
          {
            description,
            pfcPrimary: pfc?.primary ?? null,
            pfcDetailed: pfc?.detailed ?? null,
          },
          rules,
        );
        const signedAmount = plaidAmountToSigned(t);
        const linkedDebtId = debtIdByExternal.get(t.account_id) ?? null;
        const debtId =
          linkedDebtId && Number(signedAmount) > 0 ? linkedDebtId : null;

        // ±7-day merge with an unattached manual row (same
        // userId+amount+date+source-scope, plaidTransactionId NULL).
        // Mirrors the first-sync merge scope handling: credit/loan-
        // linked accounts merge against manual|amex rows attributed
        // to the same debt; the user's chosen checking account
        // merges against manual|bank rows with no debt link.
        const debtScope = debtIdsByAcctRowId.get(acct.id) ?? [];
        const isCheckingScope =
          checkingAcctRowId !== null && checkingAcctRowId === acct.id;
        let mergeWhere = null as ReturnType<typeof and> | null;
        if (debtScope.length > 0) {
          mergeWhere = and(
            eq(transactionsTable.householdId, householdId),
            eq(transactionsTable.occurredOn, t.date),
            eq(transactionsTable.amount, signedAmount),
            sql`${transactionsTable.plaidTransactionId} is null`,
            inArray(transactionsTable.debtId, debtScope),
            inArray(transactionsTable.source, ["manual", "amex"]),
          );
        } else if (isCheckingScope) {
          mergeWhere = and(
            eq(transactionsTable.householdId, householdId),
            eq(transactionsTable.occurredOn, t.date),
            eq(transactionsTable.amount, signedAmount),
            sql`${transactionsTable.plaidTransactionId} is null`,
            sql`${transactionsTable.debtId} is null`,
            inArray(transactionsTable.source, ["manual", "bank"]),
          );
        }
        if (mergeWhere) {
          const [match] = await db
            .select({ id: transactionsTable.id })
            .from(transactionsTable)
            .where(mergeWhere)
            .limit(1);
          if (match) {
            await db
              .update(transactionsTable)
              .set({
                plaidTransactionId: t.transaction_id,
                plaidAccountId: t.account_id,
              })
              .where(eq(transactionsTable.id, match.id));
            continue;
          }
        }

        const values = {
          // (#623 follow-up) Twin of the cursor-sync data-owner fix:
          // gap-backfill inserts must also land on the household owner,
          // not the actor that triggered the sync, so the rows are
          // visible in the owner-scoped ledger.
          userId: ownerUserId,
          householdId: item.householdId!,
          occurredOn: t.date,
          occurredAt: null,
          description,
          amount: signedAmount,
          categoryId: cat.categoryId,
          isTransfer: cat.isTransfer,
          source,
          plaidTransactionId: t.transaction_id,
          plaidAccountId: t.account_id,
          // (#636) Twin of the cursor-sync values block — persist Plaid's
          // PFC on the gap-backfill path too so a row that lands here
          // (and never came back through the cursor sync) is still
          // picked up by the startup card-payment audit.
          pfcPrimary: pfc?.primary ?? null,
          pfcDetailed: pfc?.detailed ?? null,
          debtId,
          // (#728) First-class pending boolean — see schema comment.
          pending: !!t.pending,
          forecastFlag: false,
        };
        // Twin of the cursor-path pending→posted adoption. When Plaid's
        // posted row references the pending row we already stored via
        // `pending_transaction_id`, re-key that row in place and refresh
        // only Plaid-owned fields — preserving the user's categoryId,
        // allowance flags, and every *UserOverridden guard. Takes
        // precedence over the fuzzy re-mint below and no-ops the later
        // `removed` delete for the old id.
        {
          const ptid = t.pending_transaction_id;
          if (ptid) {
            const [pendingMatch] = await db
              .select({ id: transactionsTable.id })
              .from(transactionsTable)
              .where(
                and(
                  eq(transactionsTable.householdId, householdId),
                  eq(transactionsTable.plaidAccountId, t.account_id),
                  eq(transactionsTable.plaidTransactionId, ptid),
                ),
              )
              .limit(1);
            if (pendingMatch) {
              logger.info(
                {
                  householdId,
                  itemRowId,
                  externalAcctId,
                  pendingTransactionId: ptid,
                  newPlaidTransactionId: t.transaction_id,
                  occurredOn: t.date,
                  amount: signedAmount,
                },
                "[plaid-backfill] pending→posted adoption — re-keying existing pending row, preserving user edits",
              );
              await db
                .update(transactionsTable)
                .set({
                  plaidTransactionId: t.transaction_id,
                  occurredOn: sql`CASE WHEN ${transactionsTable.occurredOnUserOverridden} THEN ${transactionsTable.occurredOn} ELSE ${values.occurredOn} END`,
                  occurredAt: values.occurredAt,
                  description: values.description,
                  amount: values.amount,
                  pending: values.pending,
                  pfcPrimary: values.pfcPrimary,
                  pfcDetailed: values.pfcDetailed,
                  // Preserved (not written): categoryId, allowance flags,
                  // isTransfer + all *UserOverridden guards, debtId,
                  // forecastFlag, reviewed.
                })
                .where(eq(transactionsTable.id, pendingMatch.id));
              continue;
            }
          }
        }
        // (#720) Belt-and-suspenders ±2-day re-mint dedup. The
        // unique constraint on `plaid_transaction_id` alone can't
        // catch the case where Plaid re-mints a transaction_id for
        // the same real posting (observed when a cursor reset or
        // re-link forces Plaid to re-issue its internal id). Before
        // we insert, look for an existing row with the same
        // (plaid_account_id, amount, occurred_on ±2 days) and a
        // *different* plaid_transaction_id; if found, treat the
        // incoming row as a re-mint of that posting and UPDATE the
        // existing row's identifier in place instead of inserting
        // a duplicate. Logged at warn level so the audit trail keeps
        // both ids for support diffing.
        const remintLow = fmtISO(addDays(parseISO(t.date), -2));
        const remintHigh = fmtISO(addDays(parseISO(t.date), 2));
        const [remintMatch] = await db
          .select({
            id: transactionsTable.id,
            oldPtid: transactionsTable.plaidTransactionId,
          })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              eq(transactionsTable.plaidAccountId, t.account_id),
              eq(transactionsTable.amount, signedAmount),
              sql`${transactionsTable.occurredOn} >= ${remintLow}`,
              sql`${transactionsTable.occurredOn} <= ${remintHigh}`,
              sql`${transactionsTable.plaidTransactionId} is not null`,
              sql`${transactionsTable.plaidTransactionId} <> ${t.transaction_id}`,
            ),
          )
          .limit(1);
        if (remintMatch) {
          logger.warn(
            {
              householdId,
              itemRowId,
              externalAcctId,
              oldPlaidTransactionId: remintMatch.oldPtid,
              newPlaidTransactionId: t.transaction_id,
              occurredOn: t.date,
              amount: signedAmount,
            },
            "[plaid-backfill] re-mint detected — adopting new plaid_transaction_id on existing row instead of inserting",
          );
          await db
            .update(transactionsTable)
            .set({
              plaidTransactionId: t.transaction_id,
              occurredOn: t.date,
              description,
              amount: signedAmount,
              pfcPrimary: values.pfcPrimary,
              pfcDetailed: values.pfcDetailed,
              // (#728) Mirror the cursor re-mint path — adopt the
              // current Plaid pending state on every in-place id
              // re-mint so the pending→posted flip lands here too.
              pending: values.pending,
            })
            .where(eq(transactionsTable.id, remintMatch.id));
          continue;
        }
        // Idempotent insert — if cursor sync already pulled this
        // exact transaction_id, this becomes a no-op refresh of the
        // mutable fields and is NOT counted as a new add.
        const before = await db
          .select({ id: transactionsTable.id })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              eq(transactionsTable.plaidTransactionId, t.transaction_id),
            ),
          )
          .limit(1);
        await db
          .insert(transactionsTable)
          .values(values)
          .onConflictDoUpdate({
            target: transactionsTable.plaidTransactionId,
            set: {
              // Twin of the cursor-sync guard above: honor a manual date
              // edit (Sunday→Saturday week fix) so the gap-backfill path
              // doesn't restamp `occurredOn` back to Plaid's value.
              occurredOn: sql`CASE WHEN ${transactionsTable.occurredOnUserOverridden} THEN ${transactionsTable.occurredOn} ELSE ${values.occurredOn} END`,
              description: values.description,
              amount: values.amount,
              // (#728) Gap-backfill upsert mirrors the cursor-sync
              // path — refresh the pending boolean so a row that
              // first landed here as pending flips to posted when
              // Plaid surfaces its posted twin on a later run.
              pending: values.pending,
              // (#479) See twin onConflictDoUpdate above — the gap-backfill
              // path must honor the user's manual `isTransfer` override the
              // same way as the cursor sync path.
              isTransfer: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.isTransfer} ELSE ${values.isTransfer} END`,
              // (#636) Refresh persisted PFC on the gap-backfill
              // upsert too — twin of the cursor-sync block above.
              pfcPrimary: values.pfcPrimary,
              pfcDetailed: values.pfcDetailed,
              // (#632) Twin of the cursor-sync allowance-clearing block:
              // when the classifier flips this row to a transfer (e.g.
              // newly-covered card-payment patterns), drop the dashboard
              // bucket flags so it stops counting toward Monthly/Weekly/
              // Unplanned. User overrides preserved via the same guard.
              ...(cat.isTransfer
                ? {
                    weeklyAllowance: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.weeklyAllowance} ELSE FALSE END`,
                    monthlyAllowance: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.monthlyAllowance} ELSE FALSE END`,
                    unplannedAllowance: sql`CASE WHEN ${transactionsTable.isTransferUserOverridden} THEN ${transactionsTable.unplannedAllowance} ELSE FALSE END`,
                  }
                : {}),
              ...(debtId ? { debtId } : {}),
            },
          });
        if (before.length === 0) {
          acctAdded++;
          if (minDate === null || t.date < minDate) minDate = t.date;
          if (maxDate === null || t.date > maxDate) maxDate = t.date;
        }
      }

      // (#732) Vanished-pending sweep, scoped to the
      // [startStr, todayStr] window we just fetched. Diff Plaid's
      // returned pending ids against local pending rows for this
      // account inside the same window; anything Plaid no longer
      // surfaces is a dropped pre-auth. Runs INSIDE the try so a
      // transient /transactions/get failure (caught below) never
      // wipes local rows we couldn't re-verify.
      const currentPendingIds = new Set<string>();
      for (const t of all) {
        if (t.pending) currentPendingIds.add(t.transaction_id);
      }
      try {
        await reconcileVanishedPendings({
          householdId,
          userId,
          itemRowId,
          plaidAccountId: externalAcctId,
          currentPendingIds,
          windowStart: startStr,
          windowEnd: todayStr,
        });
      } catch (sweepErr) {
        logger.warn(
          { userId, itemRowId, externalAcctId, err: sweepErr },
          "[plaid-backfill] (#732) vanished-pending sweep failed (non-fatal)",
        );
      }
    } catch (e) {
      logger.warn(
        {
          userId,
          itemRowId,
          externalAcctId,
          start: startStr,
          end: todayStr,
          ...plaidLogContext(e, "/transactions/get (gap backfill)"),
        },
        "[plaid-sync] gap-backfill /transactions/get failed for account",
      );
    }
    totalAdded += acctAdded;
    perAccount.push({
      externalAcctId,
      start: startStr,
      end: todayStr,
      added: acctAdded,
    });
  }

  return {
    added: totalAdded,
    importedDateRange:
      minDate && maxDate ? { min: minDate, max: maxDate } : null,
    perAccount,
  };
}

export async function refreshConsentExpirationForAllItems(): Promise<{
  scanned: number;
  updated: number;
  failed: number;
}> {
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable);
  let updated = 0;
  let failed = 0;
  for (const it of items) {
    try {
      const result = await refreshConsentExpirationForItem(it.id);
      if (result.error) {
        failed++;
        // Log per-item context so support can trace which institution
        // failed when the daily summary shows a non-zero `failed` count.
        // Aggregate counts alone make it impossible to diagnose whether
        // one bad item is failing every day or different items rotate.
        logger.warn(
          {
            itemRowId: result.itemRowId,
            itemId: result.itemId,
            institutionName: result.institutionName,
            err: result.error,
          },
          "Plaid consent_expiration_time refresh failed for item",
        );
      } else if (result.changed) {
        updated++;
      }
    } catch (err) {
      failed++;
      logger.warn(
        { itemRowId: it.id, err },
        "Plaid consent_expiration_time refresh threw unexpectedly",
      );
    }
  }
  return { scanned: items.length, updated, failed };
}

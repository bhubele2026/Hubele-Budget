import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidItemsTable,
  plaidAccountsTable,
  transactionsTable,
  forecastSettingsTable,
  forecastResolutionsTable,
  recurringItemsTable,
} from "@workspace/db";
import { plaid, institutionSlug, type PlaidTxn } from "./plaid";
import { loadUserRules, categorize } from "./autoCategorize";
import { expandItem, parseISO, addDays, fmtISO } from "./cashSignal";
import { refreshAmexAnchor } from "./amexAnchor";
import { logger } from "./logger";
import { recordPlaidSyncAttempt } from "./plaidSyncAttempts";
import { PLAID_REAUTH_ERROR_CODES } from "./plaidReauthCodes";

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

function plaidAmountToSigned(t: PlaidTxn): string {
  // Plaid: positive = money out (debit). We use negative = spend.
  const n = Number(t.amount ?? 0);
  return (-n).toFixed(2);
}

export async function syncPlaidItem(
  userId: string,
  itemRowId: string,
): Promise<SyncResult> {
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(
      and(
        eq(plaidItemsTable.id, itemRowId),
        eq(plaidItemsTable.userId, userId),
      ),
    );
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

  const slug = item.institutionSlug || institutionSlug(item.institutionName);
  const source = `plaid:${slug}`;
  const rules = await loadUserRules(userId);

  // Identify the user's chosen "checking" Plaid account (if any) so we can
  // auto-flag its transactions for the cash forecast and try to auto-match
  // them against planned recurring items.
  const [forecastSettings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, userId));
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
    .where(eq(debtsTable.userId, userId));
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
        .where(eq(plaidAccountsTable.userId, userId))
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
        eq(plaidAccountsTable.userId, userId),
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
    while (hasMore) {
      const resp = await plaid().transactionsSync({
        access_token: item.accessToken,
        cursor,
        count: 500,
      });
      added = added.concat(resp.data.added);
      modified = modified.concat(resp.data.modified);
      removed = removed.concat(resp.data.removed as { transaction_id: string }[]);
      cursor = resp.data.next_cursor;
      hasMore = resp.data.has_more;
    }

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
      const isFirstSyncForAcct =
        addedTxnIds.has(t.transaction_id) &&
        acctRow != null &&
        acctRow.firstSyncCompletedAt == null &&
        acctRow.importCutoffDate != null;
      if (isFirstSyncForAcct) {
        const cutoffStr = acctRow.importCutoffDate as string;
        const cutoffMs = parseISO(cutoffStr).getTime();
        const txnMs = parseISO(t.date).getTime();
        const daysFromCutoff = Math.abs(txnMs - cutoffMs) / 86_400_000;
        if (daysFromCutoff <= 7) {
          const debtScope = debtIdsByAcctRowId.get(acctRow.id) ?? [];
          const isCheckingScope =
            !!forecastSettings?.bankSnapshotAccountId &&
            forecastSettings.bankSnapshotAccountId === acctRow.id;
          let mergeWhere = null as ReturnType<typeof and> | null;
          if (debtScope.length > 0) {
            mergeWhere = and(
              eq(transactionsTable.userId, userId),
              eq(transactionsTable.occurredOn, t.date),
              eq(transactionsTable.amount, signedAmount),
              sql`${transactionsTable.plaidTransactionId} is null`,
              inArray(transactionsTable.debtId, debtScope),
              inArray(transactionsTable.source, ["manual", "amex"]),
            );
          } else if (isCheckingScope) {
            mergeWhere = and(
              eq(transactionsTable.userId, userId),
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
              firstSyncMerged++;
              continue;
            }
          }
        }
        if (parseISO(t.date).getTime() <= cutoffMs) {
          firstSyncSkipped++;
          continue;
        }
      }

      const values = {
        userId,
        occurredOn: t.date,
        occurredAt,
        description,
        amount: signedAmount,
        categoryId: cat.categoryId,
        isTransfer: cat.isTransfer,
        source,
        plaidTransactionId: t.transaction_id,
        plaidAccountId: t.account_id,
        debtId,
        notes: t.pending ? "[pending]" : null,
        forecastFlag: isChecking && !cat.isTransfer,
      };
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
            occurredOn: values.occurredOn,
            occurredAt: values.occurredAt,
            description: values.description,
            amount: values.amount,
            notes: values.notes,
            isTransfer: values.isTransfer,
            ...(debtId ? { debtId } : {}),
            ...(isChecking && !cat.isTransfer ? { forecastFlag: true } : {}),
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

    // Auto-match: for each new checking txn, find a planned recurring event
    // within ±3 days with the same sign and (within $1) amount, and mark it matched.
    if (insertedCheckingTxns.length > 0) {
      const recurring = await db
        .select()
        .from(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      const minDate = insertedCheckingTxns.reduce((a, b) => (a < b.date ? a : b.date), insertedCheckingTxns[0].date);
      const maxDate = insertedCheckingTxns.reduce((a, b) => (a > b.date ? a : b.date), insertedCheckingTxns[0].date);
      const from = addDays(parseISO(minDate), -7);
      const to = addDays(parseISO(maxDate), 7);
      const events = recurring.flatMap((r) => expandItem(r, from, to));

      const existingResolutions = await db
        .select()
        .from(forecastResolutionsTable)
        .where(eq(forecastResolutionsTable.userId, userId));
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
            userId,
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

    // Remove
    for (const r of removed) {
      await db
        .delete(transactionsTable)
        .where(
          and(
            eq(transactionsTable.userId, userId),
            eq(transactionsTable.plaidTransactionId, r.transaction_id),
          ),
        );
    }

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
          eq(plaidAccountsTable.userId, userId),
          sql`${plaidAccountsTable.firstSyncCompletedAt} is null`,
        ),
      );
    void firstSyncSkipped;
    void firstSyncMerged;

    // If this item is American Express, refresh the persisted Amex anchor so
    // GET /amex/anchor's `asOf` timestamp advances and the linked debt's
    // balance moves forward (unless the user has manually overridden it via
    // the debts UI since the last auto-update).
    if (slug === "amex") {
      try {
        await refreshAmexAnchor(userId, db, { adopt: false });
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
    if (
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
        const live = acct?.balances.available ?? acct?.balances.current;
        if (live != null) {
          await db
            .update(forecastSettingsTable)
            .set({
              bankSnapshotBalance: Number(live).toFixed(2),
              bankSnapshotAt: new Date(),
              bankSnapshotSource: "plaid",
            })
            .where(eq(forecastSettingsTable.userId, userId));
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

    return {
      itemId: item.itemId,
      plaidItemRowId: itemRowId,
      institutionName: item.institutionName,
      added: added.length,
      modified: modified.length,
      removed: removed.length,
      autoCategorized,
      ruleAttributions,
      error: balanceRefreshError,
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

export async function syncAllForUser(userId: string): Promise<SyncResult[]> {
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, userId));
  const out: SyncResult[] = [];
  for (const it of items) out.push(await syncPlaidItem(userId, it.id));
  return out;
}

export async function syncAllForAllUsers(): Promise<void> {
  const items = await db
    .select({ id: plaidItemsTable.id, userId: plaidItemsTable.userId })
    .from(plaidItemsTable);
  for (const it of items) {
    try {
      await syncPlaidItem(it.userId, it.id);
    } catch {
      // continue
    }
  }
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
  userId: string,
): Promise<ConsentRefreshResult[]> {
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, userId));
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

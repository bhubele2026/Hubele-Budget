import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  plaidItemsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireOwner } from "../middlewares/requireOwner";
import { maybeAlertOnMalformedTokenSpike } from "../lib/plaidMalformedTokenAlert";
import {
  plaid,
  PLAID_PRODUCTS,
  PLAID_OPTIONAL_PRODUCTS,
  PLAID_COUNTRY_CODES,
  institutionSlug,
  getPlaidEnv,
  isPlaidConfigured,
  isValidPlaidAccessToken,
  isAccessTokenForCurrentEnv,
  ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
  isSyntheticPlaidItem,
  MALFORMED_PLAID_TOKEN_MESSAGE,
} from "../lib/plaid";

// Plaid issues access tokens prefixed with the environment they were
// minted in (e.g. `access-sandbox-...`, `access-development-...`,
// `access-production-...`). We use that prefix to detect which existing
// `plaid_items` rows came from a non-production environment so they can
// be cleaned up after the production cutover.
export function tokenEnv(token: string | null | undefined): string | null {
  if (!token) return null;
  const m = /^access-([^-]+)-/.exec(token);
  return m ? m[1].toLowerCase() : null;
}
import {
  extractPlaidError,
  flagMalformedAccessTokens,
  markItemMalformedToken,
  plaidLogContext,
  refreshConsentExpirationForItem,
  refreshConsentExpirationForUser,
  syncPlaidItem,
  syncPlaidItemSerialized,
  syncAllForUser,
  pruneOrphanPlaidTransactionsForHousehold,
  runGapBackfillForItem,
  derivePlaidErrorKind,
} from "../lib/plaidSync";
import {
  autoDetectCutoffsForItem,
  computeImportCutoffForAccount,
} from "../lib/plaidImportCutoff";
import { scheduleSyncForItem } from "../lib/plaidSyncScheduler";
import { sendExpirationRemindersForUser } from "../lib/plaidExpirationReminder";
import { PLAID_REAUTH_ERROR_CODES as PLAID_REAUTH_ERROR_CODES_LIB } from "../lib/plaidReauthCodes";
import { verifyPlaidWebhook } from "../lib/plaidWebhookVerify";
import {
  fetchLiabilitiesForItem,
  fetchLiabilitiesForUser,
} from "../lib/plaidLiabilities";
import {
  listRecentSyncAttempts,
  PLAID_SYNC_ATTEMPT_LIST_LIMIT,
} from "../lib/plaidSyncAttempts";
import {
  dedupePlaidAccountsForUser,
  markAutoDedupeRan,
} from "../lib/dedupePlaidAccounts";
import {
  upsertPlaidAccountFromApi,
  refreshPlaidAccountsForItem,
} from "../lib/upsertPlaidAccount";
import { cleanupMalformedTokenSiblings } from "../lib/plaidMalformedSiblingCleanup";
import { debtsTable } from "@workspace/db";

const router: IRouter = Router();

// (#44) Subtypes that map to a real debt obligation (vs. e.g. an HSA or
// generic asset). Mirrored on both the auto-create-on-exchange path and
// the GET /plaid/liability-accounts filter.
const DEBT_SUBTYPES = new Set([
  "credit card",
  "paypal",
  "line of credit",
  "student",
  "mortgage",
  "home equity",
  "auto",
  "loan",
  "commercial",
  "construction",
  "consumer",
  "overdraft",
]);

type PlaidAccountRow = typeof plaidAccountsTable.$inferSelect;

export function plaidAccountIsDebtLike(a: PlaidAccountRow): boolean {
  if (a.liabilityKind) return true;
  if (a.type === "credit" || a.type === "loan") return true;
  const sub = (a.subtype ?? "").toLowerCase();
  return DEBT_SUBTYPES.has(sub);
}

// (#44) Build the suggested debt name we use both for auto-create and
// for the picker's preview. "{Institution} ••{mask}" is consistent with
// how the rest of the app shows linked Plaid accounts (see
// DebtPlaidSource), so a debt created this way reads naturally.
export function suggestedDebtName(
  acct: PlaidAccountRow,
  institutionName: string | null | undefined,
): string {
  const inst = (institutionName ?? "").trim();
  const mask = (acct.mask ?? "").trim();
  const base = acct.officialName?.trim() || acct.name?.trim() || "Account";
  if (inst && mask) return `${inst} ••${mask}`;
  if (inst) return `${inst} — ${base}`;
  if (mask) return `${base} ••${mask}`;
  return base;
}

// (#44) Map a Plaid account subtype/liabilityKind to one of the simple
// debt `type` values the avalanche page already uses. Falls back to
// "credit_card" because that is by far the most common debt-like
// account users link.
export function suggestedDebtType(acct: PlaidAccountRow): string {
  if (acct.liabilityKind === "mortgage") return "mortgage";
  if (acct.liabilityKind === "student") return "student_loan";
  const sub = (acct.subtype ?? "").toLowerCase();
  if (sub === "mortgage" || sub === "home equity") return "mortgage";
  if (sub === "student") return "student_loan";
  if (sub === "auto") return "auto_loan";
  if (
    sub === "loan" ||
    sub === "consumer" ||
    sub === "commercial" ||
    sub === "construction"
  )
    return "loan";
  if (acct.type === "loan") return "loan";
  return "credit_card";
}

// (#44) Postgres unique-violation code. The partial unique index on
// debts.plaid_account_id raises this when a concurrent request beats us
// to linking the same account; the helpers + create endpoint translate
// it into a 409 instead of a 500.
export const PG_UNIQUE_VIOLATION = "23505";
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // Drizzle/pg can put SQLSTATE either directly on .code (most direct
  // pg errors) or on .cause.code (when the driver wraps the original
  // error). Check both so the helper / endpoint translate it into 409
  // regardless of which driver path produced the error.
  const direct = (err as { code?: string }).code;
  const wrapped = (err as { cause?: { code?: string } }).cause?.code;
  return direct === PG_UNIQUE_VIOLATION || wrapped === PG_UNIQUE_VIOLATION;
}
export class PlaidAccountAlreadyLinkedError extends Error {
  constructor() {
    super("This Plaid account is already linked to a debt");
    this.name = "PlaidAccountAlreadyLinkedError";
  }
}

export type SuggestedDebt = {
  name: string;
  type: string;
  balance: string | null;
  apr: string | null;
  minPayment: string | null;
  // (#44) Day-of-month derived from /liabilities/get (when Plaid
  // provides them) so the auto-created debt's dueDay/statementDay
  // are populated up-front instead of forcing a follow-up edit.
  dueDay: number | null;
  statementDay: number | null;
};

export function buildSuggestedDebt(
  acct: PlaidAccountRow,
  institutionName: string | null | undefined,
): SuggestedDebt {
  return {
    name: suggestedDebtName(acct, institutionName),
    type: suggestedDebtType(acct),
    balance: acct.liabilityBalance ?? null,
    apr: acct.liabilityApr ?? null,
    minPayment: acct.liabilityMinPayment ?? null,
    dueDay: acct.liabilityDueDay ?? null,
    statementDay: acct.liabilityStatementDay ?? null,
  };
}

/**
 * (#44) Insert a debt from a Plaid account, marking every Plaid-provided
 * field's *_source as "plaid" and stamping the sync timestamp so the
 * Avalanche/Amex pages immediately treat the row as live. If a debt with
 * the suggested name already exists for this user *without* a Plaid link
 * (typical case: user already created an "Amex" row manually), link the
 * existing row instead of creating a duplicate.
 *
 * Returns the resulting debt row plus an `action` describing what
 * happened so the caller (auto-create on exchange, the explicit
 * create-debt endpoint) can report it back to the user.
 */
export async function createOrLinkDebtFromPlaidAccount(opts: {
  userId: string;
  householdId: string;
  account: PlaidAccountRow;
  institutionName: string | null | undefined;
  // (#44) Optional caller override (used by the post-Link bulk dialog
  // when the user edited the suggested name before clicking "Add as
  // debts"). Falls back to the institution+mask suggestion.
  nameOverride?: string | null;
}): Promise<{
  debt: typeof debtsTable.$inferSelect;
  action: "created" | "linked-existing";
}> {
  const { userId, householdId, account, institutionName, nameOverride } = opts;
  const suggested = buildSuggestedDebt(account, institutionName);
  const overridden = nameOverride?.trim();
  const finalName = overridden && overridden.length > 0 ? overridden : suggested.name;
  const now = new Date();

  // De-dupe by name: if a same-name debt already exists with no Plaid
  // link, adopt it rather than creating a second row.
  const existing = await db
    .select()
    .from(debtsTable)
    .where(
      and(
        eq(debtsTable.householdId, householdId),
        eq(debtsTable.name, finalName),
        sql`${debtsTable.plaidAccountId} is null`,
      ),
    );
  if (existing.length > 0) {
    const target = existing[0];
    // (#44) Adopting an existing debt by linking it to this Plaid account
    // means future Plaid syncs should drive balance/APR/min payment going
    // forward. Always flip the *_source columns to "plaid" — even when
    // the cached suggestion is currently null — so the next refresh that
    // does carry a value gets adopted automatically. Without this, an
    // initial-empty Plaid response would freeze the row at source=manual
    // and the eventual refresh would be ignored.
    const patch: Partial<typeof debtsTable.$inferInsert> = {
      plaidAccountId: account.id,
      plaidLastSyncedAt: now,
      updatedAt: now,
      balanceSource: "plaid",
      aprSource: "plaid",
      minPaymentSource: "plaid",
    };
    if (suggested.balance != null) {
      patch.balance = suggested.balance;
      patch.lastBalanceUpdate = now;
      if (target.originalBalance == null) {
        patch.originalBalance = suggested.balance;
      }
    }
    if (suggested.apr != null) {
      patch.apr = suggested.apr;
    }
    if (suggested.minPayment != null) {
      patch.minPayment = suggested.minPayment;
    }
    // (#44) Only fill due/statement day when the existing debt row didn't
    // already have a value — typed-over fields win over the Plaid hint.
    if (suggested.dueDay != null && target.dueDay == null) {
      patch.dueDay = suggested.dueDay;
    }
    if (suggested.statementDay != null && target.statementDay == null) {
      patch.statementDay = suggested.statementDay;
    }
    try {
      const [updated] = await db
        .update(debtsTable)
        .set(patch)
        .where(and(eq(debtsTable.id, target.id), eq(debtsTable.householdId, householdId)))
        .returning();
      // (#361) Now that this Plaid account is linked to a debt with
      // (potentially) historical manual rows, re-compute the import
      // cutoff so the account's first-sync gate covers them. Only
      // applies while the gate is still active (firstSyncCompletedAt
      // null) — otherwise leave any prior cutoff in place untouched.
      if (account.firstSyncCompletedAt == null) {
        const cutoff = await computeImportCutoffForAccount(
          userId,
          account,
          null,
        );
        if (cutoff) {
          await db
            .update(plaidAccountsTable)
            .set({ importCutoffDate: cutoff })
            .where(eq(plaidAccountsTable.id, account.id));
        }
      }
      return { debt: updated ?? target, action: "linked-existing" };
    } catch (e) {
      // (#44) Concurrent linker beat us to this Plaid account — partial
      // unique index `debts_plaid_account_unique` raised 23505. Surface
      // as a typed error so the route can return 409 instead of 500.
      if (isUniqueViolation(e)) throw new PlaidAccountAlreadyLinkedError();
      throw e;
    }
  }

  // (#44) Brand-new Plaid-sourced debt — always mark all three *_source
  // columns as "plaid" so subsequent refreshes (which gate updates by
  // source) keep the row in sync. We do this even when a value is
  // currently null in the cached suggestion, so the first refresh that
  // *does* carry a value adopts it automatically instead of being
  // ignored as "user-entered manual".
  const values: typeof debtsTable.$inferInsert = {
    userId,
    householdId,
    name: finalName,
    type: suggested.type,
    status: "active",
    plaidAccountId: account.id,
    plaidLastSyncedAt: now,
    balanceSource: "plaid",
    aprSource: "plaid",
    minPaymentSource: "plaid",
  };
  if (suggested.balance != null) {
    values.balance = suggested.balance;
    values.originalBalance = suggested.balance;
    values.lastBalanceUpdate = now;
  }
  if (suggested.apr != null) {
    values.apr = suggested.apr;
  }
  if (suggested.minPayment != null) {
    values.minPayment = suggested.minPayment;
  }
  if (suggested.dueDay != null) values.dueDay = suggested.dueDay;
  if (suggested.statementDay != null) values.statementDay = suggested.statementDay;
  try {
    const [created] = await db.insert(debtsTable).values(values).returning();
    return { debt: created!, action: "created" };
  } catch (e) {
    // (#44) Same race-protection as the link branch above — the partial
    // unique index turns the "two simultaneous create-debt calls" case
    // into a clean 409 instead of an inconsistent state.
    if (isUniqueViolation(e)) throw new PlaidAccountAlreadyLinkedError();
    throw e;
  }
}

router.post("/plaid/link-token", requireAuth, async (req, res): Promise<void> => {
  try {
    const redirectUri = process.env.PLAID_REDIRECT_URI?.trim();
    const webhookUrl = process.env.PLAID_WEBHOOK_URL?.trim();
    const resp = await plaid().linkTokenCreate({
      user: { client_user_id: req.userId! },
      client_name: "H2 Family Budget",
      products: PLAID_PRODUCTS,
      // Only include the field when there is at least one optional
      // product configured — Plaid rejects an empty array on some
      // versions of the API.
      ...(PLAID_OPTIONAL_PRODUCTS.length > 0
        ? { optional_products: PLAID_OPTIONAL_PRODUCTS }
        : {}),
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      // (preflight) Register the webhook at link time so the item is
      // born with a webhook URL on Plaid's side. Without this, /item/get
      // reports webhook=null for every linked item and Plaid never
      // notifies us of SYNC_UPDATES_AVAILABLE — sync requires a manual
      // refresh. Conditional so dev environments that don't have a
      // publicly reachable webhook URL don't accidentally point Plaid
      // at production.
      ...(webhookUrl ? { webhook: webhookUrl } : {}),
    });
    res.json({
      linkToken: resp.data.link_token,
      expiration: resp.data.expiration,
    });
  } catch (e) {
    // Surface Plaid's structured error to the client so the toast on the
    // page shows the real reason (e.g. "Your account is not enabled for
    // liabilities") instead of a generic axios "Request failed with
    // status code 400" message.
    const { code: plaidCode, message: msg } = extractPlaidError(e);
    req.log.error(
      { err: e, ...plaidLogContext(e, "/link/token/create") },
      "Plaid link token failed",
    );
    res.status(500).json({
      error: msg,
      ...(plaidCode ? { code: plaidCode } : {}),
    });
  }
});

// Plaid error codes that indicate the only fix is for the user to
// re-authenticate the bank via Plaid Link in update mode. The frontend
// keys off this set to decide when to render the "Reconnect" button.
// Re-exported here for backwards compatibility — the canonical home is
// `lib/plaidReauthCodes.ts` so other lib modules can import the set
// without creating a circular dependency through this routes file.
export const PLAID_REAUTH_ERROR_CODES = PLAID_REAUTH_ERROR_CODES_LIB;

router.post(
  "/plaid/link-token/update",
  requireAuth,
  async (req, res): Promise<void> => {
    const { itemId } = req.body ?? {};
    if (!itemId || typeof itemId !== "string") {
      res.status(400).json({ error: "itemId is required" });
      return;
    }
    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, itemId),
          eq(plaidItemsTable.householdId, req.householdId!),
        ),
      );
    if (!item) {
      res.status(404).json({ error: "Plaid item not found" });
      return;
    }
    // (#366) If the stored token is malformed, /link/token/create in
    // update mode would 400 with the same opaque "INVALID_INPUT" Plaid
    // returns for a bogus access_token. Short-circuit instead: flag the
    // item as needing reconnect and tell the client to remove + relink
    // from scratch (which mints a fresh token via /plaid/exchange).
    if (!isValidPlaidAccessToken(item.accessToken)) {
      await markItemMalformedToken(item.id);
      req.log.warn(
        { itemRowId: item.id, plaidItemIdExternal: item.itemId },
        "[plaid-update] short-circuit: stored access_token failed isValidPlaidAccessToken — caller must remove + relink",
      );
      res.status(409).json({
        error: MALFORMED_PLAID_TOKEN_MESSAGE,
        code: "ITEM_LOGIN_REQUIRED",
        action: "relink",
      });
      return;
    }
    // (#654) Env-mismatch guard. Update-mode link-token creation needs
    // a token Plaid will accept — a sandbox-prefixed token on a
    // production server is bounced with INVALID_ACCESS_TOKEN, so the
    // user would click Reconnect, see a 500, and stay stuck. Treat
    // this exactly like the malformed-token branch: tell the client to
    // remove + relink from scratch (action: "relink") so the existing
    // fresh-link fallback in the Reconnect button kicks in instead.
    if (!isAccessTokenForCurrentEnv(item.accessToken)) {
      await markItemMalformedToken(item.id, {
        code: "INVALID_ACCESS_TOKEN",
        message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
      });
      req.log.warn(
        { itemRowId: item.id, plaidItemIdExternal: item.itemId },
        "[plaid-update] short-circuit: stored access_token env does not match PLAID_ENV — caller must remove + relink",
      );
      res.status(409).json({
        error: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
        code: "INVALID_ACCESS_TOKEN",
        action: "relink",
      });
      return;
    }
    try {
      const redirectUri = process.env.PLAID_REDIRECT_URI?.trim();
      const webhookUrl = process.env.PLAID_WEBHOOK_URL?.trim();
      const resp = await plaid().linkTokenCreate({
        user: { client_user_id: req.userId! },
        client_name: "H2 Family Budget",
        // Update mode: pass the existing access_token, omit `products`.
        access_token: item.accessToken,
        country_codes: PLAID_COUNTRY_CODES,
        language: "en",
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
        // (preflight) Keep the webhook fresh on update-mode re-links too,
        // so re-authenticated items don't silently drop their webhook.
        ...(webhookUrl ? { webhook: webhookUrl } : {}),
      });
      res.json({
        linkToken: resp.data.link_token,
        expiration: resp.data.expiration,
      });
    } catch (e) {
      const { code: plaidCode, message: msg } = extractPlaidError(e);
      req.log.error(
        { err: e, ...plaidLogContext(e, "/link/token/create (update)") },
        "Plaid update link token failed",
      );
      // (#654) Defensive: even after the pre-flight env-mismatch guard,
      // Plaid can still surface INVALID_ACCESS_TOKEN for other reasons
      // (rotated server credentials, item-side disconnect that hasn't
      // been webhooked back yet). Translate to the same 409 relink
      // response so the Reconnect button's fresh-link fallback always
      // recovers instead of leaving the user on a generic 500.
      if (plaidCode === "INVALID_ACCESS_TOKEN") {
        await markItemMalformedToken(item.id, {
          code: "INVALID_ACCESS_TOKEN",
          message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
        });
        res.status(409).json({
          error: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
          code: "INVALID_ACCESS_TOKEN",
          action: "relink",
        });
        return;
      }
      res.status(500).json({
        error: msg,
        ...(plaidCode ? { code: plaidCode } : {}),
      });
    }
  },
);

router.post("/plaid/exchange", requireAuth, async (req, res): Promise<void> => {
  const { publicToken, institutionId, institutionName } = req.body ?? {};
  if (!publicToken || typeof publicToken !== "string") {
    res.status(400).json({ error: "publicToken is required" });
    return;
  }
  try {
    const exch = await plaid().itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exch.data.access_token;
    const itemId = exch.data.item_id;

    // (#366) Centralized malformed-token guard. Plaid has, in rare
    // post-OAuth-failure scenarios, returned an exchange response with
    // an empty or truncated access_token. Persisting that value bricks
    // every subsequent product call (transactions/sync, item/get,
    // accounts/get, liabilities/get) for this row with an opaque 400.
    // Refuse to persist instead and tell the client to retry the link
    // flow — this is preferable to silently writing a poison row.
    if (!isValidPlaidAccessToken(accessToken)) {
      req.log.error(
        {
          plaidItemIdExternal: itemId,
          accessTokenLength: typeof accessToken === "string" ? accessToken.length : 0,
        },
        "[plaid-exchange] refusing to persist malformed access_token returned by Plaid",
      );
      res.status(502).json({
        error: MALFORMED_PLAID_TOKEN_MESSAGE,
        code: "ITEM_LOGIN_REQUIRED",
        action: "relink",
      });
      return;
    }

    let resolvedName: string | null =
      typeof institutionName === "string" ? institutionName : null;
    let resolvedInstId: string | null =
      typeof institutionId === "string" ? institutionId : null;
    // (#238) Plaid's /item/get returns `consent_expiration_time` as the
    // cutoff after which the bank link will be auto-disconnected unless
    // the user re-consents. Capture it here so the PENDING_EXPIRATION /
    // PENDING_DISCONNECT reconnect banners can show the real date instead
    // of the date-less fallback copy. Most non-OAuth institutions do not
    // populate this field, so leave it null when absent.
    let consentExpirationAt: Date | null = null;
    // (#258) Tracks whether /item/get succeeded so we can stamp
    // `consent_expiration_last_refreshed_at` only when we actually
    // verified the cutoff against Plaid (not when the call failed and
    // we fell back to defaults).
    let consentRefreshedAt: Date | null = null;
    try {
      const itemResp = await plaid().itemGet({ access_token: accessToken });
      resolvedInstId = itemResp.data.item.institution_id ?? resolvedInstId;
      const cet = (itemResp.data.item as unknown as {
        consent_expiration_time?: string | null;
      }).consent_expiration_time;
      if (cet) {
        const parsed = new Date(cet);
        if (!Number.isNaN(parsed.getTime())) consentExpirationAt = parsed;
      }
      consentRefreshedAt = new Date();
      if (resolvedInstId && !resolvedName) {
        const inst = await plaid().institutionsGetById({
          institution_id: resolvedInstId,
          country_codes: PLAID_COUNTRY_CODES,
        });
        resolvedName = inst.data.institution.name;
      }
    } catch (e) {
      req.log.warn(
        { err: e, ...plaidLogContext(e, "/item/get | /institutions/get_by_id") },
        "Could not resolve institution metadata",
      );
    }

    const slug = institutionSlug(resolvedName);
    // (#659) Atomic upsert + sibling cleanup. Before this transaction
    // wrap, the survivor row insert and `cleanupMalformedTokenSiblings`
    // ran as two independent statements with the cleanup wrapped in a
    // best-effort try/catch — so a transient DB blip after the survivor
    // committed but before the orphan delete left the env-mismatched
    // ghost in `plaid_items` forever (a regression of the very bug
    // this task closes). Wrapping both in `db.transaction` means a
    // cleanup failure rolls the survivor insert back too; the user
    // sees a 5xx and retries Reconnect, which is strictly better than
    // a silent half-cleanup masquerading as success.
    const { item, cleaned, relinked } = await db.transaction(async (tx) => {
      const [existingItem] = await tx
        .select({ id: plaidItemsTable.id })
        .from(plaidItemsTable)
        .where(eq(plaidItemsTable.itemId, itemId));
      // (#367) Compute `relinked` from the actual upsert path: was
      // there already a row for this Plaid item_id (re-link of an
      // existing, possibly chip-flagged item) or is this a brand-new
      // insert (first-ever link of this institution for this user)?
      // The Settings UI uses this to choose between "Bank reconnected"
      // copy and the celebratory "Account linked" copy. Hardcoding
      // `true` would misdrive the brand-new-link case.
      const relinkedInTx = !!existingItem;
      const [itemRow] = await tx
        .insert(plaidItemsTable)
        .values({
          userId: req.userId!,
          householdId: req.householdId!,
          itemId,
          accessToken,
          institutionId: resolvedInstId,
          institutionName: resolvedName,
          institutionSlug: slug,
          consentExpirationAt,
          consentExpirationLastRefreshedAt: consentRefreshedAt,
        })
        .onConflictDoUpdate({
          target: plaidItemsTable.itemId,
          set: {
            accessToken,
            institutionId: resolvedInstId,
            institutionName: resolvedName,
            institutionSlug: slug,
            consentExpirationAt,
            // Only bump the freshness timestamp when /item/get actually
            // succeeded above; otherwise leave any prior value alone.
            ...(consentRefreshedAt
              ? { consentExpirationLastRefreshedAt: consentRefreshedAt }
              : {}),
            // (#367) Self-heal: when Plaid Link comes back through the
            // exchange path it ALWAYS represents a freshly authorized
            // item — any previously persisted reconnect-state error is
            // by definition stale. Clearing the chip + the still-
            // preparing timestamp here is what stops the "Reconnect
            // loop" the user reported: previously, a successful relink
            // left the synthetic ITEM_LOGIN_REQUIRED chip in place
            // until the next /transactions/sync happened to succeed,
            // which the over-strict token guard would then misclassify
            // as malformed all over again.
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparingSince: null,
            consentExpirationLastRefreshError: null,
            consentExpirationLastRefreshErrorCode: null,
          },
        })
        .returning();

      // (#401, #659) Auto-clean up any *other* row for the same
      // household + same institution whose stored access_token is
      // unusable for the current server. When Plaid mints a fresh
      // internal item_id on a re-link from scratch (instead of going
      // through update mode), the original broken row would otherwise
      // sit forever with a stale "Stored Plaid credential is
      // malformed" / "wrong Plaid environment" chip and re-surface
      // stale "needs reconnecting" banners on other pages and in the
      // daily health-check cron.
      //
      // "Unusable" covers BOTH the original malformed-token case AND
      // env-mismatched tokens (well-formed but wrong PLAID_ENV
      // prefix). The user's production Chase ghost row is the
      // latter: a sandbox-prefixed token that survived a previous
      // re-link because the upsert is keyed on `item_id` and the
      // fresh OAuth grant minted a brand-new item_id. We never touch
      // a healthy duplicate sibling — a user with two legitimate
      // Chase logins is left alone. Local cleanup only (debt source
      // flags reset, accounts + item deleted); skipping the upstream
      // itemRemove is safe because Plaid would reject the token
      // anyway (400 on malformed, INVALID_ACCESS_TOKEN on env-
      // mismatch).
      const { cleaned: cleanedSiblings } = await cleanupMalformedTokenSiblings({
        userId: req.userId!,
        householdId: req.householdId!,
        survivorItemRowId: itemRow!.id,
        institutionId: resolvedInstId,
        institutionSlug: slug,
        log: req.log,
        tx,
      });
      return { item: itemRow, cleaned: cleanedSiblings, relinked: relinkedInTx };
    });

    // (#659) Per-task contract: emit a single summary line so support
    // can grep `[plaid-exchange] archived N orphan` and immediately
    // see how many ghost rows the relink swept. The per-row info
    // line below is preserved for drill-down. `cleaned.length === 0`
    // is the common case (first-ever link) and we still emit a debug
    // line so the absence of cleanup is observable too.
    const institutionLabel = resolvedName ?? slug ?? "unknown institution";
    if (cleaned.length > 0) {
      req.log.info(
        {
          userId: req.userId,
          householdId: req.householdId,
          replacedByItemRowId: item!.id,
          replacedByPlaidItemIdExternal: item!.itemId,
          institution: institutionLabel,
          archivedCount: cleaned.length,
          archivedItemRowIds: cleaned.map((c) => c.itemRowId),
        },
        `[plaid-exchange] archived ${cleaned.length} orphan env-mismatched item(s) for ${institutionLabel}`,
      );
    }
    for (const c of cleaned) {
      req.log.info(
        {
          userId: req.userId,
          householdId: req.householdId,
          replacedByItemRowId: item!.id,
          replacedByPlaidItemIdExternal: item!.itemId,
          cleanedItemRowId: c.itemRowId,
          cleanedPlaidItemIdExternal: c.itemId,
          institutionName: c.institutionName,
        },
        "[plaid-exchange] auto-archived stale unusable-token row replaced by fresh re-link",
      );
    }

    // Pull and persist accounts via the shared upsert helper so the
    // (#410 / #754) tiered (mask + name) candidate logic stays in one
    // place — the same helper also powers /plaid/sync's pre-prune
    // account refresh, which is what self-heals a previously-deleted
    // row (e.g. the Amex Delta Gold ··1009 collision) without needing
    // a manual re-link.
    try {
      const acctResp = await plaid().accountsGet({ access_token: accessToken });
      for (const a of acctResp.data.accounts) {
        await upsertPlaidAccountFromApi({
          householdId: req.householdId!,
          userId: req.userId!,
          itemRowId: item!.id,
          institutionName: item!.institutionName ?? null,
          account: a,
        });
      }
    } catch (e) {
      // (#367) Unify Plaid log context: every line touching a Plaid
      // item must carry userId + plaidItemRowId + plaidItemIdExternal
      // so support can pivot from a single chip back to the originating
      // request without grepping. plaidLogContext() handles the
      // Plaid-API-specific fields (errorCode/displayMessage/requestId).
      req.log.warn(
        {
          err: e,
          userId: req.userId,
          plaidItemRowId: item!.id,
          plaidItemIdExternal: item!.itemId,
          institutionName: item!.institutionName,
          ...plaidLogContext(e, "/accounts/get"),
        },
        "accountsGet failed",
      );
    }

    // (#361) Before the very first /transactions/sync runs, auto-detect
    // an `import_cutoff_date` for each freshly upserted account so the
    // sync's `added` rows that overlap manual / imported history are
    // skipped (or merged in-place) instead of duplicated. Best-effort:
    // any failure here just leaves the cutoff null (no gate).
    try {
      await autoDetectCutoffsForItem(
        req.userId!,
        item!.id,
        item!.institutionSlug,
      );
    } catch (e) {
      // (#367) Same context fields as the surrounding Plaid logs so
      // support can correlate a missing-cutoff symptom with the
      // exchange that should have set it.
      req.log.warn(
        {
          err: e,
          userId: req.userId,
          plaidItemRowId: item!.id,
          plaidItemIdExternal: item!.itemId,
          institutionName: item!.institutionName,
        },
        "autoDetectCutoffsForItem failed during exchange — first sync will not gate duplicates",
      );
    }

    // Initial sync (last 90 days come via /transactions/sync naturally).
    // (#665) `forceRefresh: true` so the very first sync after a fresh
    // link / relink asks Plaid to pull from the bank right now instead
    // of returning whatever Plaid happened to have cached pre-link.
    await syncPlaidItemSerialized(req.userId!, item!.id, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    // (#408) Heal-driven gap backfill on relink. The /exchange upsert
    // above proactively cleared any prior `lastSyncErrorCode` chip on
    // the row, so the wasUnhealthy detection inside syncPlaidItem
    // can't see the prior error here. Trigger backfill explicitly so
    // a Chase relink that healed a malformed-token item still chases
    // the (lastBankTxOn, today] window per account that the cursor
    // sync alone won't replay.
    if (relinked) {
      try {
        await runGapBackfillForItem(req.userId!, item!.id);
      } catch (e) {
        req.log.warn(
          {
            err: e,
            userId: req.userId,
            plaidItemRowId: item!.id,
            plaidItemIdExternal: item!.itemId,
            institutionName: item!.institutionName,
          },
          "[plaid-exchange] gap backfill after relink failed (non-fatal)",
        );
      }
    }

    // (#44) Pull liabilities best-effort so the post-Link "Add as debts"
    // dialog the client opens after exchange has cached balance/APR/min
    // payment to show — without auto-creating any debts. The user
    // explicitly confirms which accounts to add via the dialog.
    try {
      await fetchLiabilitiesForItem(req.userId!, item!.id);
    } catch (e) {
      req.log.warn(
        {
          err: e,
          userId: req.userId,
          plaidItemRowId: item!.id,
          plaidItemIdExternal: item!.itemId,
          institutionName: item!.institutionName,
          ...plaidLogContext(e, "/liabilities/get | /accounts/get (post-exchange)"),
        },
        "fetchLiabilitiesForItem failed during exchange — post-Link dialog may show empty fields",
      );
    }

    // (#416) After every successful link/relink, run an institution-
    // agnostic dedupe pass over this user's plaid_accounts so a re-link
    // that minted brand-new account_ids for the same physical card
    // (institution + mask) collapses to one row. The (institution,
    // mask) upsert guard above (#410) already prevents most of these,
    // but this final sweep catches stray rows from older items that
    // pre-date the guard, mirroring the heal hook on /amex/anchor.
    try {
      const healed = await dedupePlaidAccountsForUser(req.userId!);
      // (#411) One-line summary so we can see how many users were
      // affected by the auto-heal across all hooks.
      console.info(
        `[auto-dedupe] userId=${req.userId} trigger=plaid-exchange groupsScanned=${healed.groupsScanned} duplicatesRemoved=${healed.duplicatesRemoved} transactionsRepointed=${healed.transactionsRepointed} debtsRepointed=${healed.debtsRepointed} snapshotRepointed=${healed.snapshotRepointed} syntheticDropped=${healed.syntheticDropped} accountSnapshotsRepointed=${healed.accountSnapshotsRepointed} accountSnapshotsPruned=${healed.accountSnapshotsPruned} transactionsDeduped=${healed.transactionsDeduped ?? 0}`,
      );
      // (#411) We just ran the heal — flip the per-user gate so the
      // next listCheckingAccounts / /forecast hit doesn't re-run an
      // identical no-op pass. No-op for users whose flag is already set.
      await markAutoDedupeRan(req.userId!);
      if (
        healed &&
        (healed.duplicatesRemoved > 0 ||
          healed.debtsRepointed > 0 ||
          healed.transactionsRepointed > 0 ||
          healed.snapshotRepointed ||
          healed.syntheticDropped)
      ) {
        req.log.info(
          { userId: req.userId, ...healed },
          "[plaid-exchange] dedupePlaidAccountsForUser healed duplicates after relink",
        );
      }
    } catch (e) {
      req.log.warn(
        { err: e },
        "[plaid-exchange] dedupePlaidAccountsForUser failed (non-fatal)",
      );
    }

    const accounts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.itemId, item!.id));

    res.json({
      id: item!.id,
      itemId: item!.itemId,
      institutionId: item!.institutionId,
      institutionName: item!.institutionName,
      institutionSlug: item!.institutionSlug,
      // (#367) Surface whether exchange ran against an existing row
      // (true → a re-link of an item that had been chip-flagged, so
      // show the calmer "Bank reconnected" copy) vs. a brand-new
      // insert (false → first-ever link, show the celebratory
      // "Account linked" copy). Computed from the pre-upsert lookup
      // above, NOT hardcoded.
      relinked,
      lastSyncedAt: item!.lastSyncedAt
        ? item!.lastSyncedAt.toISOString()
        : new Date().toISOString(),
      lastSyncError: null,
      lastSyncErrorCode: null,
      consentExpirationAt: item!.consentExpirationAt
        ? item!.consentExpirationAt.toISOString()
        : null,
      // (#258) When the cutoff was last verified against Plaid.
      consentExpirationLastRefreshedAt: item!.consentExpirationLastRefreshedAt
        ? item!.consentExpirationLastRefreshedAt.toISOString()
        : null,
      accounts: accounts.map((a) => ({
        id: a.id,
        accountId: a.accountId,
        name: a.name,
        officialName: a.officialName,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        importCutoffDate: a.importCutoffDate,
        firstSyncCompletedAt: a.firstSyncCompletedAt
          ? a.firstSyncCompletedAt.toISOString()
          : null,
      })),
    });
  } catch (e) {
    const { message: msg } = extractPlaidError(e);
    req.log.error(
      { err: e, ...plaidLogContext(e, "/item/public_token/exchange") },
      "Plaid exchange error",
    );
    res.status(500).json({ error: msg });
  }
});

type PlaidItemRow = typeof plaidItemsTable.$inferSelect;

function serializePlaidItemDetail(
  it: PlaidItemRow,
  accounts: PlaidAccountRow[],
  lastBankTxOn: string | null = null,
) {
  return {
    id: it.id,
    itemId: it.itemId,
    institutionId: it.institutionId,
    institutionName: it.institutionName,
    institutionSlug: it.institutionSlug,
    lastSyncedAt: it.lastSyncedAt ? it.lastSyncedAt.toISOString() : null,
    lastSyncError: it.lastSyncError,
    lastSyncErrorCode: it.lastSyncErrorCode,
    stillPreparing: it.stillPreparingSince != null,
    stillPreparingSince: it.stillPreparingSince
      ? it.stillPreparingSince.toISOString()
      : null,
    // (#238) Plaid's `consent_expiration_time` cutoff for this item.
    // Powers the dated PENDING_EXPIRATION / PENDING_DISCONNECT subline
    // copy ("Chase will disconnect on May 21 — reconnect now to keep
    // it linked.") on the page-top reauth banner, the DebtReauthBanner,
    // and the Settings tooltip. Null when Plaid does not provide one.
    consentExpirationAt: it.consentExpirationAt
      ? it.consentExpirationAt.toISOString()
      : null,
    // (#258) Wall-clock timestamp of when we last successfully
    // verified `consentExpirationAt` against Plaid (any path: link
    // exchange, sync's PENDING_EXPIRATION refresh, or the daily
    // cron). The Settings page surfaces this so users and support
    // can confirm the disconnect countdown is fresh ("checked just
    // now" vs. "we have not been able to reach Plaid for this item
    // in a week"). Null until the first successful refresh.
    consentExpirationLastRefreshedAt: it.consentExpirationLastRefreshedAt
      ? it.consentExpirationLastRefreshedAt.toISOString()
      : null,
    // (#265) Latest /item/get failure captured during the consent-
    // refresh path (manual button, on-sync PENDING_EXPIRATION
    // refresh, or daily cron). Cleared on the next successful
    // refresh. The Settings page renders this inline under the
    // "Disconnect date checked …" line so users can see *why* the
    // most recent disconnect-date check failed without having to
    // re-trigger the refresh.
    consentExpirationLastRefreshError:
      it.consentExpirationLastRefreshError ?? null,
    consentExpirationLastRefreshErrorCode:
      it.consentExpirationLastRefreshErrorCode ?? null,
    // (#274) The cutoff value the user dismissed the dashboard
    // "consent expiring soon" banner for. The dashboard banner
    // suppresses an item only while its current cutoff still equals
    // this stored value, so dismissals persist across reloads but a
    // re-consent or a brand-new item entering the window naturally
    // re-surfaces the alert.
    // (#408) Categorical bucket the client uses to decide between
    // Reconnect / wait / retry copy without re-importing the helper.
    errorKind: it.lastSyncErrorCode
      ? derivePlaidErrorKind(it.lastSyncErrorCode, null)
      : null,
    // (#408) Powers the post-link "No new transactions since <date>"
    // copy after a relink heal that backfilled zero rows. Computed by
    // the caller (max occurredOn across this item's accounts).
    lastBankTxOn,
    // (#725) Exposed so the Settings bank tile can render a
    // "Re-enable refresh" link when the short-circuit stamp is set
    // (e.g. after Plaid just approved the `transactions_refresh`
    // add-on but the in-memory stamp is still blocking calls for up
    // to 7 days). Click clears the stamp via
    // POST /plaid/items/{id}/clear-refresh-disabled.
    refreshProductDisabledAt: it.refreshProductDisabledAt
      ? it.refreshProductDisabledAt.toISOString()
      : null,
    consentWarningDismissedForCutoff: it.consentWarningDismissedForCutoff
      ? it.consentWarningDismissedForCutoff.toISOString()
      : null,
    accounts: accounts.map((a) => ({
      id: a.id,
      accountId: a.accountId,
      name: a.name,
      officialName: a.officialName,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      // (#361) First-sync dedupe gate. `importCutoffDate` is the
      // inclusive upper bound on dates Plaid is allowed to insert on
      // the first /transactions/sync; rows on/before it are skipped
      // and rows within ±7 days first try to merge with an unattached
      // manual row. `firstSyncCompletedAt` is stamped at the end of
      // that sync, after which the gate is permanently off. Settings
      // exposes a date picker that calls PATCH
      // /plaid/accounts/{id}/import-cutoff to override the auto-
      // detected value, but only while `firstSyncCompletedAt` is null.
      importCutoffDate: a.importCutoffDate,
      firstSyncCompletedAt: a.firstSyncCompletedAt
        ? a.firstSyncCompletedAt.toISOString()
        : null,
    })),
  };
}

// (#361) Override the auto-detected first-sync `import_cutoff_date`
// for a single Plaid account. Only allowed while the account's
// `first_sync_completed_at` is still null — once the first sync has
// stamped that timestamp the gate is permanently off and a later
// override would silently do nothing. Pass `null` to clear the
// cutoff (Plaid's first sync will then insert every row it returns).
router.patch(
  "/plaid/accounts/:id/import-cutoff",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { importCutoffDate?: unknown };
    const raw = body.importCutoffDate;
    let cutoff: string | null;
    if (raw === null) {
      cutoff = null;
    } else if (typeof raw === "string") {
      // Accept a YYYY-MM-DD date string. Reject anything else so the
      // client doesn't accidentally pass a Date object's full ISO
      // string and get whatever Postgres' implicit cast produces.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        res.status(400).json({
          error: "importCutoffDate must be a YYYY-MM-DD string or null",
        });
        return;
      }
      cutoff = raw;
    } else {
      res.status(400).json({
        error: "importCutoffDate must be a YYYY-MM-DD string or null",
      });
      return;
    }
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.id, id),
          eq(plaidAccountsTable.householdId, req.householdId!),
        ),
      );
    if (!acct) {
      res.status(404).json({ error: "Plaid account not found" });
      return;
    }
    if (acct.firstSyncCompletedAt) {
      res.status(409).json({
        error:
          "First sync already completed — cutoff override is no longer accepted",
      });
      return;
    }
    await db
      .update(plaidAccountsTable)
      .set({ importCutoffDate: cutoff })
      .where(eq(plaidAccountsTable.id, id));
    res.json({
      id: acct.id,
      importCutoffDate: cutoff,
      firstSyncCompletedAt: null,
    });
  },
);

router.get("/plaid/items", requireAuth, async (req, res): Promise<void> => {
  const allItems = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.householdId, req.householdId!));
  // (#398) Hide synthetic seed rows (April-2026 Chase placeholder)
  // from Linked Banks / reauth banner / sync-button chip — they were
  // never real Plaid connections and should never surface a "needs
  // reconnecting" CTA. The bank-snapshot tile reads forecast_settings
  // directly, so filtering here doesn't break the dashboard.
  const items = allItems.filter((it) => !isSyntheticPlaidItem(it));
  const accts = await db
    .select()
    .from(plaidAccountsTable)
    .where(eq(plaidAccountsTable.householdId, req.householdId!));
  const byItem = new Map<string, PlaidAccountRow[]>();
  for (const a of accts) {
    const arr = byItem.get(a.itemId) ?? [];
    arr.push(a);
    byItem.set(a.itemId, arr);
  }
  // (#408) Compute newest occurredOn across every Plaid-attached
  // (account-mapped) row per item so the post-link panel can render
  // "No new transactions since <date>" after a relink heal that
  // backfilled zero rows. One grouped query is cheap; we fan it out
  // by external account_id and roll back up by item.
  const externalIds = accts.map((a) => a.accountId);
  const lastByItem = new Map<string, string>();
  if (externalIds.length > 0) {
    const rows = await db
      .select({
        plaidAccountId: transactionsTable.plaidAccountId,
        maxDate: sql<string>`max(${transactionsTable.occurredOn})::text`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, req.householdId!),
          inArray(transactionsTable.plaidAccountId, externalIds),
        ),
      )
      .groupBy(transactionsTable.plaidAccountId);
    const itemByExternal = new Map(accts.map((a) => [a.accountId, a.itemId]));
    for (const r of rows) {
      if (!r.plaidAccountId || !r.maxDate) continue;
      const itemRowId = itemByExternal.get(r.plaidAccountId);
      if (!itemRowId) continue;
      const prev = lastByItem.get(itemRowId);
      if (!prev || r.maxDate > prev) lastByItem.set(itemRowId, r.maxDate);
    }
  }
  res.json(
    items.map((it) =>
      serializePlaidItemDetail(
        it,
        byItem.get(it.id) ?? [],
        lastByItem.get(it.id) ?? null,
      ),
    ),
  );
});

// (#274) Persist the user's dismissal of the dashboard "bank consent
// expiring soon" banner for a single item. We stamp
// `consent_warning_dismissed_for_cutoff` with the current
// `consent_expiration_at` so reloads stay quiet, while a re-consent
// (which rolls the cutoff forward) or a brand-new item entering the
// window naturally re-shows the alert without a separate "clear
// dismissal" call. Returns the updated item so the client can refresh
// its cache without an extra round trip.
router.post(
  "/plaid/items/:id/dismiss-expiration-warning",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = String(req.params.id);
    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, id),
          eq(plaidItemsTable.householdId, req.householdId!),
        ),
      );
    if (!item) {
      res.sendStatus(404);
      return;
    }
    // No cutoff to dismiss against — nothing to persist. Return the
    // item unchanged so the client can keep moving. (The dashboard
    // never offers dismiss for items without a cutoff, but we treat
    // this as a no-op rather than an error to stay forgiving.)
    if (!item.consentExpirationAt) {
      const accts = await db
        .select()
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.itemId, item.id),
            eq(plaidAccountsTable.householdId, req.householdId!),
          ),
        );
      res.json(serializePlaidItemDetail(item, accts));
      return;
    }
    const [updated] = await db
      .update(plaidItemsTable)
      .set({ consentWarningDismissedForCutoff: item.consentExpirationAt })
      .where(
        and(
          eq(plaidItemsTable.id, item.id),
          eq(plaidItemsTable.householdId, req.householdId!),
        ),
      )
      .returning();
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.itemId, item.id),
          eq(plaidAccountsTable.householdId, req.householdId!),
        ),
      );
    res.json(serializePlaidItemDetail(updated ?? item, accts));
  },
);

router.delete("/plaid/items/:id", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(
      and(eq(plaidItemsTable.id, id), eq(plaidItemsTable.householdId, req.householdId!)),
    );
  if (!item) {
    res.sendStatus(204);
    return;
  }
  // (#366) Skip the upstream itemRemove when the stored token is
  // malformed — Plaid would 400, and the user's intent is "delete
  // locally" anyway. Local cleanup below still runs unconditionally.
  if (isValidPlaidAccessToken(item.accessToken)) {
    try {
      await plaid().itemRemove({ access_token: item.accessToken });
    } catch (e) {
      req.log.warn({ err: e }, "Plaid itemRemove failed");
    }
  } else {
    req.log.warn(
      { itemRowId: item.id, plaidItemIdExternal: item.itemId },
      "[plaid-items.delete] skipping upstream itemRemove — stored access_token is malformed; proceeding with local delete only",
    );
  }
  // Reset source flags on any debts linked to accounts under this item.
  // The FK on debts.plaid_account_id has ON DELETE SET NULL, so the link
  // itself is cleared automatically; we just need to flip Plaid-sourced
  // fields back to manual so they no longer display Plaid badges/timestamps.
  const itemAccounts = await db
    .select({ id: plaidAccountsTable.id })
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.itemId, item.id),
        eq(plaidAccountsTable.householdId, req.householdId!),
      ),
    );
  const itemAcctIds = itemAccounts.map((a) => a.id);
  if (itemAcctIds.length > 0) {
    await db
      .update(debtsTable)
      .set({
        balanceSource: "manual",
        aprSource: "manual",
        minPaymentSource: "manual",
        plaidLastSyncedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(debtsTable.householdId, req.householdId!),
          inArray(debtsTable.plaidAccountId, itemAcctIds),
        ),
      );
  }
  await db
    .delete(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.itemId, item.id),
        eq(plaidAccountsTable.householdId, req.householdId!),
      ),
    );
  await db
    .delete(plaidItemsTable)
    .where(
      and(eq(plaidItemsTable.id, item.id), eq(plaidItemsTable.householdId, req.householdId!)),
    );
  res.sendStatus(204);
});

router.get(
  "/plaid/liability-accounts",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const householdId = req.householdId!;
    const refresh = String(req.query.refresh ?? "") === "true";
    if (refresh) {
      try {
        await fetchLiabilitiesForUser(userId, householdId);
      } catch (e) {
        req.log.warn({ err: e }, "fetchLiabilitiesForUser failed");
      }
    } else {
      // Opportunistic refresh if we have no cached liability data yet.
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.householdId, householdId),
            sql`${plaidAccountsTable.liabilityLastFetchedAt} is not null`,
          ),
        );
      if (Number(count ?? 0) === 0) {
        try {
          await fetchLiabilitiesForUser(userId, householdId);
        } catch (e) {
          req.log.warn({ err: e }, "initial liabilities fetch failed");
        }
      }
    }

    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.householdId, householdId));
    const itemById = new Map(items.map((i) => [i.id, i]));
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.householdId, householdId));
    const linkedDebts = await db
      .select({ id: debtsTable.id, name: debtsTable.name, plaidAccountId: debtsTable.plaidAccountId })
      .from(debtsTable)
      .where(eq(debtsTable.householdId, householdId));
    const linkedByAcct = new Map(
      linkedDebts
        .filter((d) => d.plaidAccountId)
        .map((d) => [d.plaidAccountId!, { id: d.id, name: d.name }]),
    );

    res.json(
      accts.filter(plaidAccountIsDebtLike).map((a) => {
        const item = itemById.get(a.itemId);
        const linked = linkedByAcct.get(a.id);
        // (#44) Surface the would-be debt payload for unmatched accounts
        // so the picker can offer "Add as new debt" without a second
        // round trip. Null when the account is already linked — the
        // client uses linkedDebt for that case.
        const suggestedDebt = linked
          ? null
          : buildSuggestedDebt(a, item?.institutionName);
        return {
          id: a.id,
          accountId: a.accountId,
          itemId: a.itemId,
          name: a.name,
          officialName: a.officialName,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          liabilityKind: a.liabilityKind,
          balance: a.liabilityBalance,
          apr: a.liabilityApr,
          minPayment: a.liabilityMinPayment,
          lastFetchedAt: a.liabilityLastFetchedAt
            ? a.liabilityLastFetchedAt.toISOString()
            : null,
          institutionId: item?.institutionId ?? null,
          institutionName: item?.institutionName ?? null,
          institutionSlug: item?.institutionSlug ?? null,
          linkedDebt: linked ?? null,
          suggestedDebt,
        };
      }),
    );
  },
);

// (#44) One-click "Add as new debt" — creates a debt row from the
// Plaid account's cached liability data and links it. Refuses with
// 409 if the account is already linked to another debt; instead of
// duplicating an existing same-name debt it adopts that row.
router.post(
  "/plaid/liability-accounts/:plaidAccountId/create-debt",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const householdId = req.householdId!;
    const plaidAccountId = String(req.params.plaidAccountId);
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.id, plaidAccountId),
          eq(plaidAccountsTable.householdId, householdId),
        ),
      );
    if (!acct) {
      res.status(404).json({ error: "Plaid account not found" });
      return;
    }
    if (!plaidAccountIsDebtLike(acct)) {
      res.status(400).json({
        error: "This Plaid account does not look like a debt account",
      });
      return;
    }
    const [taken] = await db
      .select({ id: debtsTable.id, name: debtsTable.name })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.householdId, householdId),
          eq(debtsTable.plaidAccountId, plaidAccountId),
        ),
      );
    if (taken) {
      res.status(409).json({
        error: "This Plaid account is already linked to a debt",
        debtId: taken.id,
        debtName: taken.name,
      });
      return;
    }
    // Refresh liabilities so the suggestion mirrors current Plaid data.
    // Best-effort — if the call fails we fall back to whatever values we
    // already have cached on the account row.
    try {
      await fetchLiabilitiesForItem(userId, acct.itemId);
    } catch (e) {
      req.log.warn(
        { err: e, itemRowId: acct.itemId },
        "fetchLiabilitiesForItem failed during create-debt — using cached values",
      );
    }
    const [refreshed] = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.id, plaidAccountId),
          eq(plaidAccountsTable.householdId, householdId),
        ),
      );
    // (#44) Always scope by householdId — even though we already verified
    // the account belongs to the household, the item lookup must not
    // silently grab another household's institution name if a row id ever
    // overlaps.
    const [item] = await db
      .select({ institutionName: plaidItemsTable.institutionName })
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, (refreshed ?? acct).itemId),
          eq(plaidItemsTable.householdId, householdId),
        ),
      );
    try {
      const result = await createOrLinkDebtFromPlaidAccount({
        userId,
        householdId,
        account: refreshed ?? acct,
        institutionName: item?.institutionName ?? null,
      });
      res.status(201).json({
        debt: {
          ...result.debt,
          lastBalanceUpdate: result.debt.lastBalanceUpdate
            ? result.debt.lastBalanceUpdate.toISOString()
            : null,
          plaidLastSyncedAt: result.debt.plaidLastSyncedAt
            ? result.debt.plaidLastSyncedAt.toISOString()
            : null,
        },
        action: result.action,
      });
    } catch (e) {
      // (#44) The helper raises this typed error when the partial unique
      // index catches a race; surface it as 409 with the existing debt
      // info if we can find it.
      if (e instanceof PlaidAccountAlreadyLinkedError) {
        const [winner] = await db
          .select({ id: debtsTable.id, name: debtsTable.name })
          .from(debtsTable)
          .where(
            and(
              eq(debtsTable.householdId, householdId),
              eq(debtsTable.plaidAccountId, plaidAccountId),
            ),
          );
        res.status(409).json({
          error: e.message,
          debtId: winner?.id,
          debtName: winner?.name,
        });
        return;
      }
      const msg = e instanceof Error ? e.message : "Could not create debt";
      req.log.error({ err: e }, "createOrLinkDebtFromPlaidAccount failed");
      res.status(500).json({ error: msg });
    }
  },
);

// (#44) Bulk variant of /create-debt — used by the post-Link follow-up
// dialog so the user can add several newly-discovered debt-like
// accounts in one round-trip. Each entry succeeds, fails, or skips
// independently and the per-account result is reported back so the UI
// can render a precise success toast (count + names + Avalanche link).
router.post(
  "/plaid/liability-accounts/create-debts",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const householdId = req.householdId!;
    const body = (req.body ?? {}) as {
      accounts?: Array<{ plaidAccountId?: unknown; name?: unknown }>;
    };
    const inputs = Array.isArray(body.accounts) ? body.accounts : [];
    if (inputs.length === 0) {
      res.status(400).json({ error: "accounts must be a non-empty array" });
      return;
    }
    type ResultStatus =
      | "created"
      | "linked-existing"
      | "already-linked"
      | "not-debt-like"
      | "not-found"
      | "error";
    type Result = {
      plaidAccountId: string;
      status: ResultStatus;
      debtId?: string;
      debtName?: string;
      error?: string;
    };
    const results: Result[] = [];
    const refreshedItemIds = new Set<string>();

    for (const entry of inputs) {
      const plaidAccountId =
        typeof entry?.plaidAccountId === "string" ? entry.plaidAccountId : "";
      const nameOverride =
        typeof entry?.name === "string" ? entry.name : null;
      if (!plaidAccountId) {
        results.push({
          plaidAccountId: "",
          status: "not-found",
          error: "missing plaidAccountId",
        });
        continue;
      }
      const [acct] = await db
        .select()
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.id, plaidAccountId),
            eq(plaidAccountsTable.householdId, householdId),
          ),
        );
      if (!acct) {
        results.push({ plaidAccountId, status: "not-found" });
        continue;
      }
      if (!plaidAccountIsDebtLike(acct)) {
        results.push({ plaidAccountId, status: "not-debt-like" });
        continue;
      }
      const [taken] = await db
        .select({ id: debtsTable.id, name: debtsTable.name })
        .from(debtsTable)
        .where(
          and(
            eq(debtsTable.householdId, householdId),
            eq(debtsTable.plaidAccountId, plaidAccountId),
          ),
        );
      if (taken) {
        results.push({
          plaidAccountId,
          status: "already-linked",
          debtId: taken.id,
          debtName: taken.name,
        });
        continue;
      }
      // Refresh liabilities once per item so cached balance/APR/min/day
      // values are current before we materialize multiple debts under it.
      if (!refreshedItemIds.has(acct.itemId)) {
        try {
          await fetchLiabilitiesForItem(userId, acct.itemId);
        } catch (e) {
          req.log.warn(
            { err: e, itemRowId: acct.itemId },
            "fetchLiabilitiesForItem failed during bulk create-debts — using cached values",
          );
        }
        refreshedItemIds.add(acct.itemId);
      }
      const [refreshed] = await db
        .select()
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.id, plaidAccountId),
            eq(plaidAccountsTable.householdId, householdId),
          ),
        );
      const [item] = await db
        .select({ institutionName: plaidItemsTable.institutionName })
        .from(plaidItemsTable)
        .where(
          and(
            eq(plaidItemsTable.id, (refreshed ?? acct).itemId),
            eq(plaidItemsTable.householdId, householdId),
          ),
        );
      try {
        const r = await createOrLinkDebtFromPlaidAccount({
          userId,
          householdId,
          account: refreshed ?? acct,
          institutionName: item?.institutionName ?? null,
          nameOverride,
        });
        results.push({
          plaidAccountId,
          status: r.action,
          debtId: r.debt.id,
          debtName: r.debt.name,
        });
      } catch (e) {
        if (e instanceof PlaidAccountAlreadyLinkedError) {
          const [winner] = await db
            .select({ id: debtsTable.id, name: debtsTable.name })
            .from(debtsTable)
            .where(
              and(
                eq(debtsTable.householdId, householdId),
                eq(debtsTable.plaidAccountId, plaidAccountId),
              ),
            );
          results.push({
            plaidAccountId,
            status: "already-linked",
            debtId: winner?.id,
            debtName: winner?.name,
          });
          continue;
        }
        const msg = e instanceof Error ? e.message : "Could not create debt";
        req.log.error(
          { err: e, plaidAccountId },
          "bulk create-debts: per-row failure",
        );
        results.push({ plaidAccountId, status: "error", error: msg });
      }
    }

    res.status(201).json({ results });
  },
);

router.get("/plaid/environment", requireAuth, async (req, res): Promise<void> => {
  let env: string | null = null;
  let configured = false;
  let configError: string | null = null;
  try {
    configured = isPlaidConfigured();
    if (configured) env = getPlaidEnv();
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }
  const items = await db
    .select({ id: plaidItemsTable.id, accessToken: plaidItemsTable.accessToken, institutionName: plaidItemsTable.institutionName })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.householdId, req.householdId!));
  const nonProdItems = items
    .map((it) => ({ id: it.id, institutionName: it.institutionName, env: tokenEnv(it.accessToken) }))
    .filter((it) => it.env !== null && it.env !== "production");
  res.json({
    env,
    configured,
    configError,
    nonProdItemCount: nonProdItems.length,
    nonProdItems,
  });
});

router.post(
  "/plaid/cleanup-non-prod",
  requireAuth,
  async (req, res): Promise<void> => {
    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.householdId, req.householdId!));
    const targets = items.filter((it) => {
      const env = tokenEnv(it.accessToken);
      return env !== null && env !== "production";
    });
    let removed = 0;
    for (const item of targets) {
      // (#366) Apply the same centralized guard as DELETE /plaid/items
      // — never invoke itemRemove with a value that can't possibly be
      // a valid Plaid token. Local cleanup below still proceeds.
      if (isValidPlaidAccessToken(item.accessToken)) {
        try {
          // Best-effort: a sandbox/development token will be rejected by the
          // production Plaid host, but we still want to free the local rows.
          await plaid().itemRemove({ access_token: item.accessToken });
        } catch (e) {
          req.log.warn({ err: e, itemId: item.id }, "itemRemove failed during non-prod cleanup");
        }
      } else {
        req.log.warn(
          { itemId: item.id },
          "[plaid-cleanup-non-prod] skipping upstream itemRemove — stored access_token is malformed; proceeding with local delete only",
        );
      }
      const itemAccounts = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.itemId, item.id),
            eq(plaidAccountsTable.householdId, req.householdId!),
          ),
        );
      const itemAcctIds = itemAccounts.map((a) => a.id);
      if (itemAcctIds.length > 0) {
        await db
          .update(debtsTable)
          .set({
            balanceSource: "manual",
            aprSource: "manual",
            minPaymentSource: "manual",
            plaidLastSyncedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(debtsTable.householdId, req.householdId!),
              inArray(debtsTable.plaidAccountId, itemAcctIds),
            ),
          );
      }
      await db
        .delete(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.itemId, item.id),
            eq(plaidAccountsTable.householdId, req.householdId!),
          ),
        );
      await db
        .delete(plaidItemsTable)
        .where(
          and(
            eq(plaidItemsTable.id, item.id),
            eq(plaidItemsTable.householdId, req.householdId!),
          ),
        );
      removed++;
    }
    res.json({ removed });
  },
);

// Friendly copy that mirrors the per-code reasons the frontend's
// `plaidReauthReason` shows. We persist these into `last_sync_error` when an
// ITEM webhook arrives so the Settings "Linked Accounts" row immediately
// renders the existing "Needs reconnect" badge + Reconnect button — without
// waiting for the next /transactions/sync to re-discover the same condition
// (which, for PENDING_EXPIRATION, may not happen for days).
const ITEM_ERROR_FALLBACK_MESSAGES: Record<string, string> = {
  ITEM_LOGIN_REQUIRED:
    "Your saved login expired. Reconnect this bank to resume syncing.",
  PENDING_EXPIRATION:
    "Bank connection is about to expire. Reconnect to keep it linked.",
  PENDING_DISCONNECT:
    "Plaid will disconnect this bank soon. Reconnect to keep it linked.",
  USER_PERMISSION_REVOKED:
    "Bank access was revoked. Re-link this bank to resume syncing.",
  USER_ACCOUNT_REVOKED:
    "An account on this bank was revoked. Re-link to resume syncing.",
};

router.post("/plaid/webhook", async (req, res): Promise<void> => {
  // The Plaid-Verification JWT pins a SHA-256 of the *raw* request body, so
  // the webhook route is mounted on `express.raw` (see app.ts) — req.body
  // arrives as a Buffer. Tests may use `express.json` instead and pass a
  // pre-parsed object; tolerate both shapes.
  let rawBody: Buffer;
  let parsed: {
    webhook_type?: string;
    webhook_code?: string;
    item_id?: string;
    error?: { error_code?: string; error_message?: string } | null;
    consent_expiration_time?: string | null;
  };
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body;
    if (rawBody.length === 0) {
      res.sendStatus(400);
      return;
    }
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }
  } else {
    parsed = (req.body ?? {}) as typeof parsed;
    rawBody = Buffer.from(JSON.stringify(parsed));
  }

  // Verification is mandatory in production. For local dev / tests where
  // Plaid isn't reachable, set PLAID_WEBHOOK_VERIFICATION_DISABLED=true to
  // skip — never set this in production.
  const skipVerify =
    process.env.PLAID_WEBHOOK_VERIFICATION_DISABLED === "true";
  if (!skipVerify) {
    const header =
      (req.header("Plaid-Verification") ??
        req.header("plaid-verification")) ||
      undefined;
    const result = await verifyPlaidWebhook(rawBody, header);
    if (!result.ok) {
      req.log.warn(
        { reason: result.reason },
        "Plaid webhook verification failed",
      );
      res.sendStatus(401);
      return;
    }
  }

  const { webhook_type, webhook_code, item_id, error } = parsed;
  req.log.info(
    { webhook_type, webhook_code, item_id },
    "Plaid webhook received",
  );
  if (!item_id) {
    res.sendStatus(400);
    return;
  }
  const items = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.itemId, String(item_id)));
  if (items.length === 0) {
    // We may receive webhooks for items that were unlinked locally but not
    // yet itemRemove'd at Plaid. 200 (instead of 404) so Plaid stops
    // retrying — there's nothing actionable on our side.
    res.sendStatus(200);
    return;
  }
  const item = items[0];

  if (webhook_type === "TRANSACTIONS") {
    // SYNC_UPDATES_AVAILABLE is the modern code; DEFAULT_UPDATE /
    // INITIAL_UPDATE / HISTORICAL_UPDATE are the legacy /transactions/get
    // codes some institutions still emit. All four mean "new data is
    // ready" → just re-run the cursor-based sync.
    if (
      webhook_code === "SYNC_UPDATES_AVAILABLE" ||
      webhook_code === "DEFAULT_UPDATE" ||
      webhook_code === "INITIAL_UPDATE" ||
      webhook_code === "HISTORICAL_UPDATE"
    ) {
      // Plaid often fires SYNC_UPDATES_AVAILABLE several times in quick
      // succession (one per transaction batch). Hand off to a per-item
      // scheduler that debounces a burst into a single syncPlaidItem call
      // and records a trailing rerun if more webhooks arrive while one is
      // already in-flight. The handler returns 200 immediately — the sync
      // runs in the background.
      //
      // (#plaid-free-pending) Hand off to the per-item scheduler, which
      // debounces Plaid's burst of SYNC_UPDATES_AVAILABLE webhooks into a
      // single run and calls syncPlaidItemSerialized WITHOUT forceRefresh —
      // i.e. the FREE /transactions/sync only, NEVER the billable
      // /transactions/refresh. Plaid fires these webhooks for free when it
      // ingests new data (including pending charges), so this is the
      // zero-cost way to surface pending automatically. Returns 200 below
      // immediately; the sync runs in the background.
      //
      // NOTE: the ~$500/mo incident was the every-10-min BILLABLE forced-
      // refresh cron in index.ts (forceRefresh:true), which stays disabled.
      // This path never passes forceRefresh, so it cannot bill a refresh.
      scheduleSyncForItem(item.userId, item.id);
    }
  } else if (webhook_type === "ITEM") {
    if (webhook_code === "ERROR") {
      // Plaid wraps the actionable code in an `error` object on ITEM/ERROR
      // webhooks. ITEM_LOGIN_REQUIRED is the most common case; whatever
      // code arrives gets persisted so the existing reauth detection (set
      // of codes in PLAID_REAUTH_ERROR_CODES) can fire the Reconnect
      // button on Settings → Linked Accounts and the page-top banner.
      const code = error?.error_code ?? null;
      if (code) {
        const message =
          error?.error_message ??
          ITEM_ERROR_FALLBACK_MESSAGES[code] ??
          `Plaid reported "${code}" for this bank.`;
        await db
          .update(plaidItemsTable)
          .set({ lastSyncError: message, lastSyncErrorCode: code })
          .where(eq(plaidItemsTable.id, item.id));
      }
    } else if (
      webhook_code === "PENDING_EXPIRATION" ||
      webhook_code === "PENDING_DISCONNECT"
    ) {
      // Both are "you must reconnect before <date>" warnings — they're in
      // PLAID_REAUTH_ERROR_CODES so writing them to lastSyncErrorCode lights
      // up the Reconnect button. Also opportunistically refresh the cached
      // consent_expiration_at so the dated banner copy ("Chase will
      // disconnect on May 21") reflects whatever Plaid reports now.
      const message =
        ITEM_ERROR_FALLBACK_MESSAGES[webhook_code] ??
        `Plaid reported "${webhook_code}" for this bank.`;
      await db
        .update(plaidItemsTable)
        .set({ lastSyncError: message, lastSyncErrorCode: webhook_code })
        .where(eq(plaidItemsTable.id, item.id));
      try {
        await refreshConsentExpirationForItem(item.id);
      } catch (e) {
        req.log.warn(
          { err: e },
          "Consent refresh after PENDING_* webhook failed",
        );
      }
    } else if (
      webhook_code === "USER_PERMISSION_REVOKED" ||
      webhook_code === "USER_ACCOUNT_REVOKED"
    ) {
      const message = ITEM_ERROR_FALLBACK_MESSAGES[webhook_code]!;
      await db
        .update(plaidItemsTable)
        .set({ lastSyncError: message, lastSyncErrorCode: webhook_code })
        .where(eq(plaidItemsTable.id, item.id));
    } else if (webhook_code === "LOGIN_REPAIRED") {
      // The user re-authed (in another flow) and Plaid says everything is
      // healthy again — clear the chip and resync to pull anything that
      // accumulated while the item was locked out.
      await db
        .update(plaidItemsTable)
        .set({ lastSyncError: null, lastSyncErrorCode: null })
        .where(eq(plaidItemsTable.id, item.id));
      try {
        // (#665) `forceRefresh: true` — user just re-authed in another
        // flow, so ask Plaid to pull fresh data from the bank rather
        // than replaying its cached cursor state.
        await syncPlaidItemSerialized(item.userId, item.id, { forceRefresh: true });
      } catch (e) {
        req.log.warn(
          { err: e },
          "Post-LOGIN_REPAIRED sync failed (non-fatal)",
        );
      }
    }
    // NEW_ACCOUNTS_AVAILABLE / WEBHOOK_UPDATE_ACKNOWLEDGED are intentionally
    // ignored — we don't auto-add accounts (could surprise the user) and
    // the acknowledgement is informational.
  }
  res.sendStatus(200);
});

// (#253) Manual trigger for the daily consent_expiration_time refresh
// job. The same code path runs unattended at 03:17 UTC (see index.ts);
// this endpoint exists so an operator (or an integration test) can
// kick it for the caller's items on demand and inspect the per-item
// outcome. Best-effort by design: per-item failures surface in the
// response body but never fail the request.
router.post(
  "/plaid/refresh-consent-expirations",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      const results = await refreshConsentExpirationForUser(req.householdId!);
      res.json({
        scanned: results.length,
        updated: results.filter((r) => r.changed && !r.error).length,
        failed: results.filter((r) => !!r.error).length,
        items: results,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Refresh failed";
      req.log.error({ err: e }, "Plaid consent refresh failed");
      res.status(500).json({ error: msg });
    }
  },
);

// (#262) Manual trigger for the daily disconnect-reminder sweep. Same
// code path runs unattended at 03:32 UTC (see index.ts); this endpoint
// exists so an operator (or an integration test) can kick it for the
// caller's items on demand and inspect the per-item outcome. Best-
// effort by design: per-item failures surface in the response body but
// never fail the request.
router.post(
  "/plaid/send-expiration-reminders",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      const results = await sendExpirationRemindersForUser(req.userId!);
      res.json({
        scanned: results.length,
        sent: results.filter((r) => !r.error && r.channel !== "skipped").length,
        skipped: results.filter((r) => r.channel === "skipped").length,
        failed: results.filter((r) => !!r.error).length,
        items: results,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Reminder sweep failed";
      req.log.error({ err: e }, "Plaid disconnect reminder sweep failed");
      res.status(500).json({ error: msg });
    }
  },
);

// (#397) Owner-gated manual trigger for the daily malformed-token
// sweep (#369) + spike alert (#371). Same code path runs unattended
// at 03:02 UTC (see index.ts); this endpoint exists so an operator
// who just investigated an alert can re-run the sweep immediately to
// confirm the fix worked instead of waiting until tomorrow morning.
// Returns the same `{ scanned, flagged, flaggedItems }` summary the
// cron logs and additionally re-evaluates the spike alert so the
// caller can observe a confirmation alert (or "all clear" /
// below-threshold skip) inline. Best-effort by design: an alert
// dispatch failure is reported via the response body but never fails
// the request — the underlying sweep already ran.
router.post(
  "/plaid/run-malformed-token-sweep",
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const summary = await flagMalformedAccessTokens();
      req.log.info(
        { scanned: summary.scanned, flagged: summary.flagged },
        "Manual Plaid malformed access_token sweep complete",
      );
      let alert: Awaited<ReturnType<typeof maybeAlertOnMalformedTokenSpike>> | null = null;
      try {
        alert = await maybeAlertOnMalformedTokenSpike(summary);
        if (alert.channel !== "skipped") {
          req.log.info(
            {
              channel: alert.channel,
              recipient: alert.recipient,
              flagged: summary.flagged,
            },
            "Plaid malformed-token spike alert dispatched (manual trigger)",
          );
        }
      } catch (err) {
        req.log.warn(
          { err },
          "Plaid malformed-token spike alert threw unexpectedly (manual trigger)",
        );
      }
      res.json({
        scanned: summary.scanned,
        flagged: summary.flagged,
        flaggedItems: summary.flaggedItems,
        alert,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sweep failed";
      req.log.error({ err: e }, "Manual Plaid malformed access_token sweep failed");
      res.status(500).json({ error: msg });
    }
  },
);

// (#279) Per-item recent sync history. The Settings → Linked banks
// "Recent activity" expander hits this once when the user opens it.
// Returns the most recent ~20 attempts (any product) ordered newest
// first; the client handles re-sorting in memory so columns can be
// re-clicked without an extra round-trip.
router.get(
  "/plaid/items/:id/sync-attempts",
  requireAuth,
  async (req, res): Promise<void> => {
    const itemRowId = String(req.params.id);
    const [item] = await db
      .select({ id: plaidItemsTable.id })
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, itemRowId),
          eq(plaidItemsTable.householdId, req.householdId!),
        ),
      );
    if (!item) {
      res.status(404).json({ error: "Plaid item not found" });
      return;
    }
    const attempts = await listRecentSyncAttempts(
      req.userId!,
      itemRowId,
      PLAID_SYNC_ATTEMPT_LIST_LIMIT,
    );
    res.json({ attempts });
  },
);

/**
 * (#651) Force-unstick a Plaid item whose `/transactions/sync` cursor
 * has drifted past real bank activity. Clears `cursor` (and any stale
 * sync-error fields) on the caller's item, then runs one fresh sync
 * which re-pages the historical window. Existing rows update in place
 * via the unique index on `transactions.plaid_transaction_id`, so this
 * never produces duplicates.
 *
 * Authorization: caller must be authenticated AND the item must belong
 * to the caller's household. Synthetic seed items and items with
 * malformed access tokens are rejected (those need different recovery
 * paths — re-link, not cursor reset).
 */
/**
 * (#725) Manually clear the `refreshProductDisabledAt` short-circuit
 * stamp on a Plaid item. Surfaced as a "Re-enable refresh" link on the
 * Settings bank tile so a user whose Plaid client just had the
 * `transactions_refresh` add-on enabled (e.g. Plaid approved a product-
 * add request) can unblock live refresh calls immediately instead of
 * waiting up to 7 days for the auto-retry window. Idempotent — safe to
 * click multiple times. The next manual Sync after this call also
 * self-heals via the auto-clear in `syncPlaidItem`, so this route is
 * just the explicit user-driven path.
 */
router.post(
  "/plaid/items/:id/clear-refresh-disabled",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = String(req.params.id);
    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, id),
          eq(plaidItemsTable.householdId, req.householdId!),
        ),
      );
    if (!item) {
      res.status(404).json({ error: "Plaid item not found" });
      return;
    }
    if (item.refreshProductDisabledAt) {
      await db
        .update(plaidItemsTable)
        .set({ refreshProductDisabledAt: null })
        .where(eq(plaidItemsTable.id, item.id));
      req.log.info(
        {
          itemRowId: item.id,
          plaidItemIdExternal: item.itemId,
          institutionName: item.institutionName,
        },
        "[plaid-clear-refresh-disabled] cleared by user from Settings",
      );
    }
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.itemId, item.id),
          eq(plaidAccountsTable.householdId, req.householdId!),
        ),
      );
    res.json(
      serializePlaidItemDetail(
        { ...item, refreshProductDisabledAt: null },
        accts,
      ),
    );
  },
);

router.post(
  "/plaid/items/:itemId/reset-cursor",
  requireAuth,
  async (req, res): Promise<void> => {
    const itemId = String(req.params.itemId ?? "");
    if (!itemId) {
      res.status(400).json({ error: "itemId is required" });
      return;
    }
    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, itemId),
          eq(plaidItemsTable.householdId, req.householdId!),
        ),
      );
    if (!item) {
      res.status(404).json({ error: "Plaid item not found" });
      return;
    }
    if (isSyntheticPlaidItem(item)) {
      res.status(400).json({
        error: "Synthetic seed items cannot have their cursor reset.",
      });
      return;
    }
    if (!isValidPlaidAccessToken(item.accessToken)) {
      res.status(409).json({
        error: MALFORMED_PLAID_TOKEN_MESSAGE,
        code: "ITEM_LOGIN_REQUIRED",
        action: "relink",
      });
      return;
    }
    try {
      await db
        .update(plaidItemsTable)
        .set({
          cursor: null,
          lastSyncError: null,
          lastSyncErrorCode: null,
        })
        .where(eq(plaidItemsTable.id, item.id));
      req.log.info(
        {
          itemRowId: item.id,
          plaidItemIdExternal: item.itemId,
          institutionName: item.institutionName,
        },
        "[plaid-reset-cursor] cursor cleared, triggering fresh sync",
      );
      // (#665) Admin "reset cursor & resync" is an explicit user
      // action — pair it with a /transactions/refresh so the resync
      // walks fresh data, not whatever Plaid had cached when the
      // cursor got stuck.
      const result = await syncPlaidItemSerialized(req.userId!, item.id, {
        forceRefresh: true,
        syncOrigin: "manual",
      });
      res.json({
        ok: true,
        item: {
          id: item.id,
          institutionName: item.institutionName,
        },
        sync: result,
      });
    } catch (e) {
      const { message: msg } = extractPlaidError(e);
      req.log.error(
        { err: e, itemRowId: item.id },
        "[plaid-reset-cursor] reset/sync failed",
      );
      res.status(500).json({ error: msg });
    }
  },
);

router.post("/plaid/sync", requireAuth, async (req, res): Promise<void> => {
  const { itemId, force } = req.body ?? {};
  // (#665, reversed) This endpoint is the manual "Sync" button (and the
  // post-link first-sync trigger). It now defaults to the FREE
  // /transactions/sync cursor walk ONLY — no billable /transactions/refresh
  // — because every plain Sync click was billing Plaid a refresh per linked
  // bank (the household saw the "Transactions Refresh" counter climb steadily
  // in July). The cursor sync still returns everything Plaid has already
  // ingested; it just doesn't force Plaid to re-poll the bank right now.
  // Callers that genuinely need a fresh upstream pull — linking a bank,
  // reconnecting one, re-enabling a rate-limited item, or the explicit
  // "Force refresh" button — opt in with body `{ force: true }`. Only a
  // literal `true` bills a refresh, so a fat-fingered or absent body always
  // takes the cheap path.
  const forceRefresh = force === true;
  try {
    // (#671 follow-up) Always prune orphan Plaid transactions for the
    // household on a manual Sync click — covers the itemId-only path
    // too, which is the exact path the post-relink first-sync trigger
    // uses (it passes the brand-new item's id). Without this, the
    // ghost twins from the previously-deleted item survive and flood
    // the forecast review bucket with duplicates of every line the
    // relinked item brings back.
    // (#754) Refresh the plaid_accounts directory from Plaid's truth
    // BEFORE the orphan prune runs. If the old dedupePlaidAccountsForUser
    // mask-collision bug previously deleted a row (e.g. Amex Delta
    // SkyMiles Gold ··1009 colliding with Platinum ··1009), this
    // recreates it via the shared upsert helper's tiered (mask + name)
    // candidate match. Without this, the prune would see the deleted
    // row's transactions as "orphans" (their plaid_account_id has no
    // matching plaid_accounts row) and delete them too. Best-effort
    // per item — a single account-refresh failure must not block the
    // user-initiated sync.
    const itemsToRefresh = itemId
      ? await db
          .select({ id: plaidItemsTable.id })
          .from(plaidItemsTable)
          .where(
            and(
              eq(plaidItemsTable.id, String(itemId)),
              eq(plaidItemsTable.householdId, req.householdId!),
            ),
          )
      : await db
          .select({ id: plaidItemsTable.id })
          .from(plaidItemsTable)
          .where(eq(plaidItemsTable.householdId, req.householdId!));
    // (#speed) Refresh every item's accounts in PARALLEL — each is an
    // independent best-effort Plaid balance/directory call, so there's no
    // reason to wait for them one at a time before the prune.
    await Promise.all(
      itemsToRefresh.map(async (it) => {
        const r = await refreshPlaidAccountsForItem({
          userId: req.userId!,
          itemRowId: it.id,
          logger: req.log,
        });
        if (r.inserted > 0 || r.error) {
          req.log.info(
            {
              plaidItemRowId: it.id,
              upserted: r.upserted,
              inserted: r.inserted,
              updated: r.updated,
              refreshError: r.error,
            },
            r.inserted > 0
              ? "[plaid-sync] pre-prune account refresh re-materialized previously-missing plaid_accounts rows"
              : "[plaid-sync] pre-prune account refresh skipped or partial",
          );
        }
      }),
    );
    await pruneOrphanPlaidTransactionsForHousehold(req.householdId!);
    const results = itemId
      ? [
          await syncPlaidItemSerialized(req.userId!, String(itemId), {
            forceRefresh,
            syncOrigin: "manual",
          }),
        ]
      : await syncAllForUser(req.userId!, req.householdId!, {
          forceRefresh,
          syncOrigin: "manual",
        });
    // (#651) The Amex page's "Refresh from Plaid" button calls this
    // endpoint expecting the live Plaid liability balance to update too
    // — but `syncPlaidItem` only walks /transactions/sync. Without a
    // companion liabilities fetch, `plaid_accounts.liability_balance` and
    // `liability_last_fetched_at` stay stale and the Amex Ending Balance
    // tile reads "Updated 1 week ago" right after the user clicks
    // refresh. Trigger `fetchLiabilitiesForItem` for every successfully
    // synced item that has at least one debt-eligible account on file —
    // this naturally skips bank-only items so we don't waste a Plaid
    // call (and avoid the INVALID_PRODUCT error spam from clients
    // without the liabilities product enabled). Each call is best-
    // effort: a per-item failure must not 500 the sync response since
    // the transactions sync already succeeded.
    // (#speed) Fetch liabilities for every synced item in PARALLEL — each is
    // an independent best-effort per-item call; no need to serialize them.
    await Promise.all(
      results.map(async (r) => {
        if (r.error) return;
        if (!r.plaidItemRowId) return;
        const [hasLiabilityAcct] = await db
          .select({ id: plaidAccountsTable.id })
          .from(plaidAccountsTable)
          .where(
            and(
              eq(plaidAccountsTable.itemId, r.plaidItemRowId),
              sql`(${plaidAccountsTable.type} in ('credit','loan') or ${plaidAccountsTable.liabilityKind} is not null)`,
            ),
          )
          .limit(1);
        if (!hasLiabilityAcct) return;
        try {
          await fetchLiabilitiesForItem(req.userId!, r.plaidItemRowId);
        } catch (liabErr) {
          req.log.warn(
            { err: liabErr, plaidItemRowId: r.plaidItemRowId },
            "fetchLiabilitiesForItem after /plaid/sync failed — Ending Balance tile may stay stale until next refresh",
          );
        }
      }),
    );
    // (#662) Roll the per-item silent-drop count up into a top-level
    // total so the toast layer can eventually distinguish "0 added —
    // nothing new" from "0 added — N rows filtered by the first-sync
    // import cutoff" without having to walk every item.
    const skippedPreCutoff = results.reduce(
      (sum, r) => sum + (r.skippedPreCutoff ?? 0),
      0,
    );
    res.json({ items: results, skippedPreCutoff });
  } catch (e) {
    const { message: msg } = extractPlaidError(e);
    req.log.error(
      { err: e, ...plaidLogContext(e, "POST /plaid/sync") },
      "Plaid sync failed",
    );
    res.status(500).json({ error: msg });
  }
});

export default router;

import { and, eq } from "drizzle-orm";
import {
  db,
  plaidItemsTable,
  plaidAccountsTable,
} from "@workspace/db";
import {
  plaid,
  isValidPlaidAccessToken,
  MALFORMED_PLAID_TOKEN_MESSAGE,
} from "./plaid";
import { logger } from "./logger";
import {
  extractPlaidError,
  markItemMalformedToken,
  plaidLogContext,
} from "./plaidSync";
import { recordPlaidSyncAttempt } from "./plaidSyncAttempts";

export type LiabilityRow = {
  accountId: string;
  kind: "credit" | "student" | "mortgage";
  balance: number | null;
  apr: number | null; // decimal, e.g. 0.1999
  minPayment: number | null;
  // (#44) Day-of-month derived from Plaid's
  // next_payment_due_date / last_statement_issue_date so we can
  // pre-fill the suggested debt's dueDay/statementDay.
  dueDay: number | null;
  statementDay: number | null;
};

// (#44) Plaid liabilities expose dates as ISO strings in the bank's
// local timezone (e.g. "2026-05-21"). We only need the day-of-month for
// the debts schema, and pulling it via UTC string parsing avoids any
// host-timezone drift that would otherwise nudge the date by ±1 day.
export function dayOfMonthFromIso(s: string | null | undefined): number | null {
  if (!s || typeof s !== "string") return null;
  const m = /^\d{4}-\d{2}-(\d{2})/.exec(s);
  if (!m) return null;
  const day = Number(m[1]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return day;
}

function pickBestApr(aprs: Array<{ apr_percentage: number; apr_type?: string }> | undefined): number | null {
  if (!aprs || aprs.length === 0) return null;
  const purchase = aprs.find((a) => a.apr_type === "purchase_apr");
  if (purchase && purchase.apr_percentage > 0) return purchase.apr_percentage / 100;
  const max = aprs.reduce(
    (best, a) => (a.apr_percentage > best ? a.apr_percentage : best),
    0,
  );
  return max > 0 ? max / 100 : null;
}

export class PlaidLiabilitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidLiabilitiesError";
  }
}

// Plaid returns INVALID_PRODUCT on /liabilities/get when the calling
// client isn't approved for the liabilities product. That is an expected,
// recoverable state for this app (we run with optional_products disabled
// by default), so callers should treat it as "no liability data
// available" rather than a hard error.
function isLiabilitiesNotEnabled(e: unknown): boolean {
  const ax = e as {
    response?: { data?: { error_code?: string; error_type?: string } };
  };
  const code = ax?.response?.data?.error_code ?? "";
  return code === "INVALID_PRODUCT" || code === "PRODUCTS_NOT_SUPPORTED";
}

export async function fetchLiabilitiesForItem(
  userId: string,
  itemRowId: string,
): Promise<LiabilityRow[]> {
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(
      and(eq(plaidItemsTable.id, itemRowId), eq(plaidItemsTable.userId, userId)),
    );
  if (!item) return [];
  // (#366) Centralized malformed-token guard. Without this, a bad
  // row-level access_token would cascade into Plaid 400s on
  // /accounts/get + /liabilities/get that the existing catch path
  // would persist as the chip text. Short-circuit to the synthetic
  // "needs reconnect" state so debt-only users still see the same
  // Reconnect CTA on the Avalanche page that bank-only users see on
  // Settings.
  if (!isValidPlaidAccessToken(item.accessToken)) {
    await markItemMalformedToken(itemRowId);
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "liabilities",
      success: false,
      errorCode: "ITEM_LOGIN_REQUIRED",
      errorMessage: MALFORMED_PLAID_TOKEN_MESSAGE,
    });
    logger.warn(
      { userId, itemRowId },
      "[plaid-liabilities] short-circuit: stored access_token failed isValidPlaidAccessToken — flagged as needs-reconnect, no Plaid call made",
    );
    return [];
  }
  let acctErr: unknown = null;
  let liabErr: unknown = null;
  // Always fetch latest balances via /accounts/get so debt-like accounts
  // that aren't returned by /liabilities/get (e.g. unsupported subtypes,
  // generic loans) still get a fresh balance.
  let acctResp;
  try {
    acctResp = await plaid().accountsGet({ access_token: item.accessToken });
  } catch (e) {
    acctResp = null;
    acctErr = e;
  }
  let resp = null as Awaited<ReturnType<ReturnType<typeof plaid>["liabilitiesGet"]>> | null;
  try {
    resp = await plaid().liabilitiesGet({ access_token: item.accessToken });
  } catch (e) {
    resp = null;
    // INVALID_PRODUCT means this Plaid client isn't approved for the
    // liabilities product — that's an expected state for the bank-only
    // configuration. Don't treat it as a fatal error; fall through with
    // whatever /accounts/get returned so balance refresh still works.
    if (isLiabilitiesNotEnabled(e)) {
      logger.warn(
        { userId, itemRowId, ...plaidLogContext(e, "/liabilities/get") },
        "Liabilities not enabled on this Plaid client — falling back to /accounts/get balances only",
      );
    } else {
      liabErr = e;
    }
  }
  // (#43) Persist liability/balance fetch failures on the parent Plaid
  // item so the Avalanche debt rows can render the same "sync failing"
  // chip + Reconnect affordance that /transactions/sync already powers.
  // Otherwise debt-only users (who never call /plaid/sync) would never
  // see a badge when their bank link breaks.
  //
  // - Both fetches failed → record the most actionable error and throw.
  // - /accounts/get failed (balance refresh dead) → record the error.
  // - /accounts/get succeeded but /liabilities/get failed with a real,
  //   non-recoverable Plaid error code (e.g. ITEM_LOGIN_REQUIRED) →
  //   record so the user can act before APR/min-payment go fully stale.
  // - Both succeeded (or only INVALID_PRODUCT) → clear any stale error
  //   so the badge drops once the bank is healthy again.
  const fetchErr = acctErr ?? liabErr;
  if (!acctResp && !resp) {
    if (fetchErr) {
      const { code, message } = extractPlaidError(fetchErr);
      await db
        .update(plaidItemsTable)
        .set({
          lastSyncError: `Liability refresh failed: ${message}`,
          lastSyncErrorCode: code,
        })
        .where(
          and(
            eq(plaidItemsTable.id, itemRowId),
            eq(plaidItemsTable.userId, userId),
          ),
        );
      // (#279) Audit the failed liability fetch so the Recent activity
      // panel surfaces it alongside transaction sync failures.
      await recordPlaidSyncAttempt({
        userId,
        plaidItemId: itemRowId,
        kind: "liabilities",
        success: false,
        errorCode: code,
        errorMessage: message,
      });
    }
    throw new PlaidLiabilitiesError(
      `Plaid fetch failed: ${String(acctErr ?? liabErr)}`,
    );
  }
  if (fetchErr) {
    const { code, message } = extractPlaidError(fetchErr);
    await db
      .update(plaidItemsTable)
      .set({
        lastSyncError: `Liability refresh failed: ${message}`,
        lastSyncErrorCode: code,
      })
      .where(
        and(
          eq(plaidItemsTable.id, itemRowId),
          eq(plaidItemsTable.userId, userId),
        ),
      );
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "liabilities",
      success: false,
      errorCode: code,
      errorMessage: message,
    });
  } else if (acctResp) {
    await db
      .update(plaidItemsTable)
      .set({
        lastSyncError: null,
        lastSyncErrorCode: null,
      })
      .where(
        and(
          eq(plaidItemsTable.id, itemRowId),
          eq(plaidItemsTable.userId, userId),
        ),
      );
    // (#279) Successful liability fetch — record so users see "fetched
    // ok" rows in Settings. Note INVALID_PRODUCT (handled silently
    // above) lands here too, which is the right call: from the user's
    // perspective the bank is healthy on the calls we *do* make.
    await recordPlaidSyncAttempt({
      userId,
      plaidItemId: itemRowId,
      kind: "liabilities",
      success: true,
      errorCode: null,
      errorMessage: null,
    });
  }
  const liab = resp?.data.liabilities;
  const accountsById = new Map(
    (acctResp?.data.accounts ?? resp?.data.accounts ?? []).map((a) => [
      a.account_id,
      a,
    ]),
  );
  const debtSubtypes = new Set([
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
  const now = new Date();

  // Step 1: refresh balance for every debt-like account.
  for (const a of accountsById.values()) {
    const sub = (a.subtype ?? "").toLowerCase();
    const isDebt = a.type === "credit" || a.type === "loan" || debtSubtypes.has(sub);
    if (!isDebt) continue;
    const bal = a.balances?.current;
    if (bal == null) continue;
    await db
      .update(plaidAccountsTable)
      .set({
        liabilityBalance: bal.toFixed(2),
        liabilityLastFetchedAt: now,
      })
      .where(
        and(
          eq(plaidAccountsTable.userId, userId),
          eq(plaidAccountsTable.accountId, a.account_id),
        ),
      );
  }

  // Step 2: enrich with APR + min payment from /liabilities/get when present.
  const out: LiabilityRow[] = [];
  if (!liab) return out;

  for (const c of liab.credit ?? []) {
    if (!c.account_id) continue;
    const acc = accountsById.get(c.account_id);
    out.push({
      accountId: c.account_id,
      kind: "credit",
      balance: acc?.balances?.current ?? null,
      apr: pickBestApr(c.aprs),
      minPayment: c.minimum_payment_amount ?? null,
      dueDay: dayOfMonthFromIso(c.next_payment_due_date),
      statementDay: dayOfMonthFromIso(c.last_statement_issue_date),
    });
  }
  for (const s of liab.student ?? []) {
    if (!s.account_id) continue;
    const acc = accountsById.get(s.account_id);
    const aprPct = (s as { interest_rate_percentage?: number }).interest_rate_percentage;
    out.push({
      accountId: s.account_id,
      kind: "student",
      balance: acc?.balances?.current ?? null,
      apr: aprPct != null ? aprPct / 100 : null,
      minPayment: s.minimum_payment_amount ?? null,
      // Plaid student liabilities expose `expected_payoff_date` and
      // `last_statement_issue_date`; use the next-payment due-date when
      // available so the suggested due-day matches the credit case.
      dueDay: dayOfMonthFromIso(
        (s as { next_payment_due_date?: string | null }).next_payment_due_date,
      ),
      statementDay: dayOfMonthFromIso(
        (s as { last_statement_issue_date?: string | null }).last_statement_issue_date,
      ),
    });
  }
  for (const m of liab.mortgage ?? []) {
    if (!m.account_id) continue;
    const acc = accountsById.get(m.account_id);
    const irPct = m.interest_rate?.percentage;
    out.push({
      accountId: m.account_id,
      kind: "mortgage",
      balance: acc?.balances?.current ?? null,
      apr: irPct != null ? irPct / 100 : null,
      minPayment: m.next_monthly_payment ?? null,
      dueDay: dayOfMonthFromIso(m.next_payment_due_date),
      // Mortgage payloads don't include a statement date, so this stays null.
      statementDay: null,
    });
  }

  for (const r of out) {
    // Balance was already cached in Step 1 from /accounts/get; here we only
    // enrich kind/APR/min payment so a missing field doesn't clobber state.
    const patch: Record<string, unknown> = {
      liabilityKind: r.kind,
      liabilityLastFetchedAt: now,
    };
    if (r.apr != null) patch.liabilityApr = r.apr.toFixed(4);
    if (r.minPayment != null)
      patch.liabilityMinPayment = r.minPayment.toFixed(2);
    if (r.dueDay != null) patch.liabilityDueDay = r.dueDay;
    if (r.statementDay != null) patch.liabilityStatementDay = r.statementDay;
    await db
      .update(plaidAccountsTable)
      .set(patch)
      .where(
        and(
          eq(plaidAccountsTable.userId, userId),
          eq(plaidAccountsTable.accountId, r.accountId),
        ),
      );
  }
  return out;
}

export async function fetchLiabilitiesForUser(
  userId: string,
): Promise<LiabilityRow[]> {
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, userId));
  const out: LiabilityRow[] = [];
  for (const it of items) {
    const rows = await fetchLiabilitiesForItem(userId, it.id);
    out.push(...rows);
  }
  return out;
}

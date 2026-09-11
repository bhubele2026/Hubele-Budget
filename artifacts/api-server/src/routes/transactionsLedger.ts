import { Router, type IRouter, type Response } from "express";
import {
  BulkReviewMatchingTransactionsBody,
  GetTransactionsBalancesQueryParams,
  GetTransactionsLedgerQueryParams,
  getTransactionsLedgerQueryLimitMax,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  LEDGER_FILTER_KEYS,
  LedgerRequestError,
  balanceUnavailableReason,
  bulkReviewMatching,
  checkLedgerFilter,
  decodeLedgerCursor,
  hasNul,
  parseBalanceDates,
  parseBoolParam,
  readLedgerBalances,
  readLedgerPage,
  resolveLedgerAccounts,
  resolveLedgerScope,
} from "../lib/bankLedger";

/**
 * (PR13) The paginated bank ledger: one page of the Chase register, the
 * balances on it, and review-by-filter. All of the logic is in lib/bankLedger;
 * these handlers only validate and delegate. GET /transactions is unchanged for
 * its other callers.
 */
const router: IRouter = Router();

function sendLedgerError(res: Response, err: unknown): boolean {
  if (!(err instanceof LedgerRequestError)) return false;
  res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  return true;
}

const orUndefined = (v: string | undefined) => (v === undefined || v === "" ? undefined : v);

/** Postgres refuses a NUL byte in text; refuse it here, in every query value, rather than answer 500. */
function queryHasNul(query: unknown): boolean {
  return Object.values((query ?? {}) as Record<string, unknown>).some((v) =>
    (Array.isArray(v) ? v : [v]).some((x) => typeof x === "string" && hasNul(x)),
  );
}

router.get("/transactions/ledger", requireAuth, async (req, res): Promise<void> => {
  if (queryHasNul(req.query)) {
    res.status(400).json({ error: "query values must not contain a NUL byte", code: "invalid_query" });
    return;
  }
  // `zod.coerce.number()` would also take "1e1" or "0x10": the limit is plain digits.
  const rawLimit = (req.query as Record<string, unknown>).limit;
  if (rawLimit !== undefined && !(typeof rawLimit === "string" && /^[0-9]+$/.test(rawLimit))) {
    res.status(400).json({ error: "limit must be a whole number", code: "invalid_limit" });
    return;
  }
  const q = GetTransactionsLedgerQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message, code: "invalid_query" });
    return;
  }
  try {
    const { limit } = q.data;
    if (!Number.isInteger(limit) || limit < 1 || limit > getTransactionsLedgerQueryLimitMax) {
      throw new LedgerRequestError(
        400,
        "invalid_limit",
        `limit must be a whole number from 1 to ${getTransactionsLedgerQueryLimitMax}`,
      );
    }
    const filter = checkLedgerFilter({
      from: q.data.from,
      to: q.data.to,
      search: q.data.search,
      reviewed: parseBoolParam(q.data.reviewed, "reviewed"),
      pending: parseBoolParam(q.data.pending, "pending"),
      uncategorized: parseBoolParam(q.data.uncategorized, "uncategorized"),
      categoryId: q.data.categoryId,
      source: q.data.source,
      member: q.data.member,
    });
    const cursor = q.data.cursor ? decodeLedgerCursor(q.data.cursor) : null;
    const scope = await resolveLedgerScope(
      req.householdId!,
      req.householdOwnerId!,
      orUndefined(q.data.account),
    );
    res.json(await readLedgerPage(scope, filter, limit, cursor));
  } catch (err) {
    if (!sendLedgerError(res, err)) throw err;
  }
});

router.get("/transactions/balances", requireAuth, async (req, res): Promise<void> => {
  if (queryHasNul(req.query)) {
    res.status(400).json({ error: "query values must not contain a NUL byte", code: "invalid_query" });
    return;
  }
  const q = GetTransactionsBalancesQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message, code: "invalid_query" });
    return;
  }
  try {
    const dates = parseBalanceDates(q.data.dates);
    const scope = await resolveLedgerScope(
      req.householdId!,
      req.householdOwnerId!,
      orUndefined(q.data.account),
    );
    res.json({
      balances: await readLedgerBalances(scope, dates),
      balanceUnavailableReason: balanceUnavailableReason(scope),
      anchor: scope.anchor,
      account: { via: scope.via, plaidAccountIds: scope.plaidAccountIds },
    });
  } catch (err) {
    if (!sendLedgerError(res, err)) throw err;
  }
});

router.post(
  "/transactions/bulk-review-matching",
  requireAuth,
  async (req, res): Promise<void> => {
    // A misspelt key must not widen the filter to every row: refuse it instead
    // of letting the schema strip it.
    const rawFilter = (req.body as { filter?: unknown } | undefined)?.filter;
    if (rawFilter && typeof rawFilter === "object" && !Array.isArray(rawFilter)) {
      const unknown = Object.keys(rawFilter).filter((k) => !LEDGER_FILTER_KEYS.includes(k));
      if (unknown.length > 0) {
        res.status(400).json({
          error: `unknown filter field: ${unknown.join(", ")}`,
          code: "invalid_filter",
        });
        return;
      }
    }
    const parsed = BulkReviewMatchingTransactionsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "invalid_body" });
      return;
    }
    try {
      const { filter: body, reviewed, expectedCount } = parsed.data;
      if (!Number.isInteger(expectedCount)) {
        throw new LedgerRequestError(400, "invalid_body", "expectedCount must be a whole number");
      }
      const { account, ...rest } = body;
      if (account !== undefined && hasNul(account)) {
        throw new LedgerRequestError(400, "invalid_account", "account must be a uuid");
      }
      const filter = checkLedgerFilter(rest);
      const accounts = await resolveLedgerAccounts(
        req.householdId!,
        req.householdOwnerId!,
        orUndefined(account),
      );
      // (PR14 second review N1) Marking rows reviewed by filter must leave pending
      // rows out. The sync's removed-row delete and vanished-pending sweep skip a
      // reviewed row (plaidSync.ts), so a reviewed pending hold survives when the
      // bank drops it and stays counted. One row at a time is still allowed; a
      // filter that could shield up to 1,000 rows is not. Checked after the
      // account so a refused account still answers with its own code.
      if (reviewed && filter.pending !== false) {
        throw new LedgerRequestError(
          400,
          "pending_not_excluded",
          "reviewing by filter must exclude pending rows: send filter.pending = false",
        );
      }
      res.json(await bulkReviewMatching(accounts, filter, reviewed, expectedCount));
    } catch (err) {
      if (!sendLedgerError(res, err)) throw err;
    }
  },
);

export default router;

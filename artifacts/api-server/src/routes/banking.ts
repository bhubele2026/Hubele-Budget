import { Router, type IRouter } from "express";
import { GetBankingReviewQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { LedgerRequestError, hasNul } from "../lib/bankLedger";
import { buildBankingReview } from "../lib/bankingReview";
import { computeNeedsYou, NEEDS_YOU_DEFAULT_LIMIT, NEEDS_YOU_MAX_LIMIT } from "../lib/needsYou";
import { autoDoneSinceDefault, listAutoDone, runBankAutoSort } from "../lib/bankAutoSort";
import { householdTodayISO } from "../lib/householdClock";

/**
 * (S4) The banking review: one bank account's period and what was not in the
 * plan. All of the logic is in lib/bankingReview (and avalanche-core's
 * `placeBankReviewRow`); this handler only validates and delegates. Read-only.
 */
const router: IRouter = Router();

router.get("/banking/review", requireAuth, async (req, res): Promise<void> => {
  const query = (req.query ?? {}) as Record<string, unknown>;
  // Postgres refuses a NUL byte in text; refuse it here, in every value, rather than answer 500.
  if (Object.values(query).some((v) => (Array.isArray(v) ? v : [v]).some((x) => typeof x === "string" && hasNul(x)))) {
    res.status(400).json({ error: "query values must not contain a NUL byte", code: "invalid_query" });
    return;
  }
  // `zod.coerce.number()` would also take "1e1" or "0x10": the counts are plain digits.
  for (const key of ["rowsPerBucket", "limit"] as const) {
    const raw = query[key];
    if (raw !== undefined && !(typeof raw === "string" && /^[0-9]{1,3}$/.test(raw))) {
      res.status(400).json({ error: `${key} must be a whole number`, code: key === "limit" ? "invalid_limit" : "invalid_rows_per_bucket" });
      return;
    }
  }
  const q = GetBankingReviewQueryParams.safeParse(query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message, code: "invalid_query" });
    return;
  }
  try {
    const { account, from, to, rowsPerBucket, bucket, kind, cursor, limit } = q.data;
    res.json(
      await buildBankingReview(req.householdId!, req.householdOwnerId!, {
        account: account === undefined || account === "" ? undefined : account,
        from,
        to,
        rowsPerBucket,
        bucket,
        kind,
        cursor: cursor === undefined || cursor === "" ? undefined : cursor,
        limit,
      }),
    );
  } catch (err) {
    if (err instanceof LedgerRequestError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
      return;
    }
    throw err;
  }
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string): boolean => DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && v >= "2000-01-01";

/** A `since` query value: a YYYY-MM-DD day, not after today; absent = a week back. */
function sinceOf(raw: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }): string | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || !isDay(raw) || raw > householdTodayISO()) {
    res.status(400).json({ error: "since must be a YYYY-MM-DD day, not after today", code: "invalid_since" });
    return null;
  }
  return raw;
}

/**
 * ⭐ (BANK-AUTO) THE ONE LIST: every charge H2 still needs a person for, after
 * the auto-sort did what it was sure of — the rows waiting for a match and the
 * categorization queue, one item per charge — and `count`, the number every
 * badge shows (lib/needsYou.ts). Read-only.
 */
router.get("/banking/needs-you", requireAuth, async (req, res): Promise<void> => {
  const rawLimit = req.query.limit;
  let limit = NEEDS_YOU_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" || !/^[0-9]{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > NEEDS_YOU_MAX_LIMIT) {
      res.status(400).json({ error: `limit must be a whole number from 1 to ${NEEDS_YOU_MAX_LIMIT}`, code: "invalid_limit" });
      return;
    }
    limit = Number(rawLimit);
  }
  const since = sinceOf(req.query.since, res);
  if (since === null) return;
  res.json(await computeNeedsYou(req.householdId!, req.householdOwnerId!, { limit, ...(since ? { since } : {}) }));
});

/**
 * ⭐ (BANK-AUTO) What the auto-sort did since `since` that still stands, each
 * with the id its undo takes: a match → POST /forecast/resolutions/{undoId}/undo
 * with `{ restore: [] }`; a category → POST /category-decisions/{undoId}/undo.
 */
router.get("/banking/auto-done", requireAuth, async (req, res): Promise<void> => {
  const since = sinceOf(req.query.since, res);
  if (since === null) return;
  res.json(await listAutoDone(req.householdId!, since ?? autoDoneSinceDefault(householdTodayISO())));
});

/**
 * ⭐ (BANK-AUTO) Run the auto-sort for the household now (it also runs after
 * every bank sync). Owner only. `dryRun=1` reports what it would do and writes
 * nothing.
 */
router.post("/banking/auto-sort", requireAuth, async (req, res): Promise<void> => {
  if (!req.householdOwnerId || (req.actualUserId ?? req.userId) !== req.householdOwnerId) {
    res.status(403).json({ error: "Forbidden: owner only" });
    return;
  }
  const raw = req.query.dryRun;
  if (raw !== undefined && raw !== "0" && raw !== "1" && raw !== "true" && raw !== "false") {
    res.status(400).json({ error: "dryRun must be 1 or 0", code: "invalid_dry_run" });
    return;
  }
  const dryRun = raw === "1" || raw === "true";
  res.json(await runBankAutoSort(req.householdId!, req.householdOwnerId, { dryRun }));
});

export default router;

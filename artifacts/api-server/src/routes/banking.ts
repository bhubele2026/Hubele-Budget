import { Router, type IRouter } from "express";
import { GetBankingReviewQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { LedgerRequestError, hasNul } from "../lib/bankLedger";
import { buildBankingReview } from "../lib/bankingReview";

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

export default router;

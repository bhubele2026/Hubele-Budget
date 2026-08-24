import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { archiveExpiredOneTime, buildBillsSummary } from "../lib/billsSummary";

const router: IRouter = Router();

// Re-exported for `routes/recurring.ts` and `routes/forecast.ts`, which have
// imported it from here since before it had a lib to live in. The
// implementation moved to `lib/billsSummary.ts` with the rest of the summary;
// this keeps their import paths (and the blast radius of that move) unchanged.
export { archiveExpiredOneTime };

router.get("/bills/summary", requireAuth, async (req, res): Promise<void> => {
  // ⚠️ The body of this handler now lives in `lib/billsSummary.ts`, unchanged.
  // It moved so `/api/spine` can derive "next bill" and "bills due" from the
  // SAME rows this page reads rather than from a second query of its own —
  // which is the only way two surfaces can be guaranteed to name the same bill.
  const monthParam = typeof req.query.month === "string" ? req.query.month : "";
  const summary = await buildBillsSummary(
    req.householdId!,
    req.householdOwnerId!,
    monthParam,
  );
  res.json(summary);
});

export default router;

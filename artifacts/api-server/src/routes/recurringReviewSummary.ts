// Recurring review summary — POST /reports/recurring-review-summary.
//
// Takes the client-detected new recurring charges (structured facts) and returns
// a short Fable 5 read. The model only writes language; every dollar figure is
// computed in our code (the client detector) and validated here before use.

import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { PostReportsRecurringReviewSummaryBody } from "@workspace/api-zod";
import {
  generateRecurringReviewSummary,
  type ReviewCharge,
} from "../lib/recurringReviewSummary";

const router: IRouter = Router();

router.post(
  "/reports/recurring-review-summary",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = PostReportsRecurringReviewSummaryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid recurring-review payload" });
      return;
    }
    const charges: ReviewCharge[] = parsed.data.charges.map((c) => ({
      merchant: c.merchant,
      annual: c.annual,
      monthly: c.monthly,
      cadence: c.cadence,
      confidence: c.confidence,
    }));
    const summary = await generateRecurringReviewSummary(charges);
    res.json(summary);
  },
);

export default router;

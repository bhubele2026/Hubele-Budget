import { Router, type IRouter, type RequestHandler } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { buildReviewProposals } from "../lib/reviewProposals";

/**
 * ⭐ (F2) PROPOSED FIXES — `GET /review/proposals`. The household OWNER only
 * (a member gets 403 `owner_only`). Read-only: every item is a proposal he
 * applies himself with an existing app action; this route writes nothing. All
 * of the logic is in lib/reviewProposals.ts.
 */
const router: IRouter = Router();

/** The signed-in user must be the household's owner, not merely a member of it. */
const requireHouseholdOwner: RequestHandler = (req, res, next) => {
  if (!req.actualUserId || req.actualUserId !== req.householdOwnerId) {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  next();
};

router.get("/review/proposals", requireAuth, requireHouseholdOwner, async (req, res): Promise<void> => {
  res.json(await buildReviewProposals(req.householdId!, req.householdOwnerId!));
});

export default router;

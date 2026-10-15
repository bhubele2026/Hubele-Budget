import { Router, type IRouter, type RequestHandler, type Response } from "express";
import {
  ApplyReviewProposalBody,
  ApplyReviewProposalParams,
  ApplyReviewProposalQueryParams,
  UndoAppliedReviewProposalParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { buildReviewProposals } from "../lib/reviewProposals";
import {
  CorrectionRefusal,
  applyCorrection,
  listAppliedCorrections,
  previewCorrection,
  undoCorrection,
} from "../lib/reviewCorrections";

/**
 * ⭐ (F2) PROPOSED FIXES — `GET /review/proposals`. The household OWNER only
 * (a member gets 403 `owner_only`). Read-only: every item is a proposal; the
 * GET writes nothing. All of the logic is in lib/reviewProposals.ts.
 *
 * (Q2) The owner applies one with `POST /review/proposals/:key/apply`
 * (`?dryRun=1` previews it, writing nothing), undoes it whole with
 * `POST /review/proposals/applied/:id/undo`, and sees them in
 * `GET /review/proposals/applied`. Owner only, all of them. The logic is in
 * lib/reviewCorrections.ts.
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

/** A refused fix or undo answers its own status and words; anything else is a real error. */
function refused(res: Response, e: unknown): boolean {
  if (!(e instanceof CorrectionRefusal)) return false;
  res.status(e.status).json(e.body());
  return true;
}

router.get("/review/proposals", requireAuth, requireHouseholdOwner, async (req, res): Promise<void> => {
  res.json(await buildReviewProposals(req.householdId!, req.householdOwnerId!));
});

router.get("/review/proposals/applied", requireAuth, requireHouseholdOwner, async (req, res): Promise<void> => {
  res.json(await listAppliedCorrections(req.householdId!));
});

router.post("/review/proposals/:key/apply", requireAuth, requireHouseholdOwner, async (req, res): Promise<void> => {
  const params = ApplyReviewProposalParams.safeParse(req.params);
  const query = ApplyReviewProposalQueryParams.safeParse(req.query);
  const body = ApplyReviewProposalBody.safeParse(req.body);
  if (!params.success || !query.success || !body.success) {
    const err = !params.success ? params.error : !query.success ? query.error : body.error!;
    res.status(400).json({ error: err.message });
    return;
  }
  const dryRun = query.data.dryRun !== undefined;
  try {
    const args = [req.householdId!, req.householdOwnerId!, req.userId!, params.data.key, body.data] as const;
    res.json(dryRun ? await previewCorrection(...args) : await applyCorrection(...args));
  } catch (e) {
    if (!refused(res, e)) throw e;
  }
});

router.post("/review/proposals/applied/:id/undo", requireAuth, requireHouseholdOwner, async (req, res): Promise<void> => {
  const params = UndoAppliedReviewProposalParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Not found.", code: "not_found" });
    return;
  }
  try {
    res.json(await undoCorrection(req.householdId!, req.userId!, params.data.id));
  } catch (e) {
    if (!refused(res, e)) throw e;
  }
});

export default router;

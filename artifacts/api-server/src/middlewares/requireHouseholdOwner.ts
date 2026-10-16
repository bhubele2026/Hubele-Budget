import type { RequestHandler } from "express";

/**
 * The signed-in user must be the household's OWNER, not merely a member of it.
 * A member gets 403 `owner_only`. Runs after `requireAuth`, which resolves
 * `actualUserId` and `householdOwnerId`; no Clerk call (unlike `requireOwner`,
 * which looks the email up per request).
 *
 * Shared by proposed fixes (F2/Q2), the week adjustments (V5) and the What's
 * new read report (WN).
 */
export const requireHouseholdOwner: RequestHandler = (req, res, next) => {
  if (!req.actualUserId || req.actualUserId !== req.householdOwnerId) {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  next();
};

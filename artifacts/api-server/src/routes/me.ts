import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { isOwnerEmail, loadUserEmail } from "../middlewares/requireOwner";
import { clerkClient } from "@clerk/express";

const router: IRouter = Router();

router.get("/me", requireAuth, async (req, res): Promise<void> => {
  // (#623) Identity in /me is the SIGNED-IN user, not the household
  // owner. `req.userId` is remapped to the owner for invited members
  // so every data route reads the shared household — but the profile
  // shown in the UI (name, email, owner badge) must reflect who is
  // actually using the app right now.
  const actualUserId = req.actualUserId ?? req.userId!;
  let email: string | null = null;
  let displayName: string | null = null;
  try {
    const user = await clerkClient.users.getUser(actualUserId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    email = primary?.emailAddress ?? null;
    displayName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.username ||
      null;
  } catch {
    email = await loadUserEmail(actualUserId);
  }
  res.json({
    userId: actualUserId,
    email,
    displayName,
    isOwner: isOwnerEmail(email),
  });
});

export default router;

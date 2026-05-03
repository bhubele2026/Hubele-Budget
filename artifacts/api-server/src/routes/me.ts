import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { isOwnerEmail, loadUserEmail } from "../middlewares/requireOwner";
import { clerkClient } from "@clerk/express";

const router: IRouter = Router();

router.get("/me", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  let email: string | null = null;
  let displayName: string | null = null;
  try {
    const user = await clerkClient.users.getUser(userId);
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
    email = await loadUserEmail(userId);
  }
  res.json({
    userId,
    email,
    displayName,
    isOwner: isOwnerEmail(email),
  });
});

export default router;

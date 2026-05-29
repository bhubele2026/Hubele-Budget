import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, userUiPreferencesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { isOwnerEmail, loadUserEmail } from "../middlewares/requireOwner";
import { UpdateUiPreferencesBody } from "@workspace/api-zod";
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

// (#860) Per-USER UI preferences. Unlike /settings (household-owner
// scoped), these are keyed by the signed-in user's Clerk id so two
// members of the same household keep independent UI state. Used for the
// sidebar collapse/expand choice so it follows the user across devices.
router.get(
  "/me/ui-preferences",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.actualUserId ?? req.userId!;
    const [row] = await db
      .select()
      .from(userUiPreferencesTable)
      .where(eq(userUiPreferencesTable.userId, userId));
    res.json((row?.preferences as Record<string, unknown> | null) ?? {});
  },
);

router.put(
  "/me/ui-preferences",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = UpdateUiPreferencesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const userId = req.actualUserId ?? req.userId!;
    const [existing] = await db
      .select()
      .from(userUiPreferencesTable)
      .where(eq(userUiPreferencesTable.userId, userId));
    const merged = {
      ...((existing?.preferences as Record<string, unknown> | null) ?? {}),
      ...parsed.data,
    };
    const [row] = await db
      .insert(userUiPreferencesTable)
      .values({ userId, preferences: merged })
      .onConflictDoUpdate({
        target: userUiPreferencesTable.userId,
        set: { preferences: merged, updatedAt: new Date() },
      })
      .returning();
    res.json((row?.preferences as Record<string, unknown> | null) ?? {});
  },
);

export default router;

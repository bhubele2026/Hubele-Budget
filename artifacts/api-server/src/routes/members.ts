import { Router, type IRouter, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireOwner, isOwnerEmail, loadUserEmail } from "../middlewares/requireOwner";

const router: IRouter = Router();

router.get("/members", requireOwner, async (_req: Request, res: Response): Promise<void> => {
  const result = await clerkClient.users.getUserList({
    orderBy: "-created_at",
    limit: 200,
  });
  const users = Array.isArray(result)
    ? result
    : (result as { data: typeof result.data }).data;
  type ClerkUser = (typeof users)[number];
  type ClerkEmail = ClerkUser["emailAddresses"][number];
  const members = users.map((u: ClerkUser) => {
    const primary =
      u.emailAddresses.find((e: ClerkEmail) => e.id === u.primaryEmailAddressId) ??
      u.emailAddresses[0];
    const email = primary?.emailAddress ?? null;
    const displayName =
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
      u.username ||
      null;
    return {
      id: u.id,
      email,
      displayName,
      imageUrl: u.imageUrl ?? null,
      isOwner: isOwnerEmail(email),
      createdAt: u.createdAt ?? null,
      lastSignInAt: u.lastSignInAt ?? null,
    };
  });
  res.json(members);
});

router.delete(
  "/members/:id",
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: "Missing member id" });
      return;
    }
    if (req.userId && id === req.userId) {
      res.status(400).json({ error: "You cannot remove yourself" });
      return;
    }
    try {
      const targetEmail = await loadUserEmail(id);
      if (isOwnerEmail(targetEmail)) {
        res.status(400).json({ error: "Cannot remove the owner" });
        return;
      }
      await clerkClient.users.deleteUser(id);
      await db.delete(profilesTable).where(eq(profilesTable.id, id));
      res.status(204).end();
    } catch (err: unknown) {
      const e = err as { status?: number; errors?: Array<{ message?: string }>; message?: string };
      const status = typeof e.status === "number" ? e.status : 500;
      const message =
        e.errors?.[0]?.message || e.message || "Failed to remove member";
      res.status(status).json({ error: message });
    }
  },
);

export default router;

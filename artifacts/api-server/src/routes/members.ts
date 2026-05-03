import { Router, type IRouter, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { requireOwner, isOwnerEmail } from "../middlewares/requireOwner";

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

export default router;

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { clerkClient } from "@clerk/express";
import { db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "./requireAuth";

declare global {
  namespace Express {
    interface Request {
      userEmail?: string | null;
      isOwner?: boolean;
    }
  }
}

const DEFAULT_OWNER_EMAIL = "h2hubele@gmail.com";

export function getOwnerEmail(): string {
  return (process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL).toLowerCase().trim();
}

export async function loadUserEmail(userId: string): Promise<string | null> {
  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    return primary?.emailAddress ?? null;
  } catch {
    return null;
  }
}

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().trim() === getOwnerEmail();
}

async function requireOwnerCore(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const email = await loadUserEmail(req.userId);
  req.userEmail = email;
  req.isOwner = isOwnerEmail(email);
  if (!req.isOwner) {
    res.status(403).json({ error: "Forbidden: owner only" });
    return;
  }
  if (email) {
    await db
      .update(profilesTable)
      .set({ email })
      .where(eq(profilesTable.id, req.userId));
  }
  next();
}

export const requireOwner: RequestHandler[] = [
  requireAuth as RequestHandler,
  (req, res, next) => {
    requireOwnerCore(req, res, next).catch(next);
  },
];

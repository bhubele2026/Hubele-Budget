import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const ensuredUsers = new Set<string>();

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId =
    (auth?.sessionClaims as { userId?: string } | undefined)?.userId ??
    auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  if (!ensuredUsers.has(userId)) {
    try {
      await db
        .insert(profilesTable)
        .values({ id: userId })
        .onConflictDoNothing();
      ensuredUsers.add(userId);
    } catch (e) {
      req.log.warn({ err: e }, "Failed to ensure profile row");
    }
  }
  next();
}

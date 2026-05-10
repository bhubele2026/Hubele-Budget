import { Router, type IRouter, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import {
  db,
  profilesTable,
  householdMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  requireOwner,
  isOwnerEmail,
  loadUserEmail,
} from "../middlewares/requireOwner";
import { evictHouseholdCacheFor } from "../middlewares/requireAuth";

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

/**
 * (#623) Revoke any Clerk invitations (pending OR accepted) addressed
 * to `email`. We revoke even accepted invitations because
 * `requireAuth` consults `accepted` invitations as the bootstrap
 * signal for re-joining a removed member's household; leaving them in
 * place would silently re-add the member on next sign-in (their Clerk
 * deletion notwithstanding, if the member re-registers via a fresh
 * invite).
 *
 * We page through both statuses; Clerk's API caps at ~100/page.
 */
/**
 * (#623) Fail-closed: a list/revoke API failure here MUST throw rather
 * than silently fall through to user/membership delete. Otherwise the
 * removed member could re-sign-in via a still-pending invitation
 * before the household_members row delete takes hold (or worse, after
 * — invitations are the bootstrap signal in requireAuth). The DELETE
 * handler catches the throw and returns 502 so the owner can retry.
 *
 * "Already revoked" per-invitation errors are still tolerated (those
 * carry a Clerk-specific 4xx code we ignore via best-effort), but a
 * page fetch error or non-already-revoked revoke error aborts.
 */
async function revokeAllInvitationsForEmail(email: string): Promise<number> {
  const target = email.toLowerCase().trim();
  if (!target) return 0;
  const statuses = ["pending", "accepted"] as const;
  const pageSize = 100;
  const max = 1000;
  let revoked = 0;
  for (const status of statuses) {
    let offset = 0;
    while (offset < max) {
      let page: Array<{ id: string; emailAddress: string; status: string }>;
      const result = await clerkClient.invitations.getInvitationList({
        status,
        orderBy: "-created_at",
        limit: pageSize,
        offset,
      });
      page = Array.isArray(result)
        ? result
        : (result as { data: typeof page }).data;
      if (!page || page.length === 0) break;
      for (const inv of page) {
        if (inv.emailAddress?.toLowerCase().trim() !== target) continue;
        try {
          await clerkClient.invitations.revokeInvitation(inv.id);
          revoked++;
        } catch (err) {
          // Tolerate already-revoked / already-accepted (Clerk returns
          // 400 or 422 on those); rethrow anything else so the DELETE
          // handler can fail closed.
          const e = err as {
            status?: number;
            errors?: Array<{ code?: string }>;
          };
          const status = e?.status ?? 0;
          const code = e?.errors?.[0]?.code ?? "";
          const isAlreadyRevoked =
            status === 400 ||
            status === 422 ||
            code === "invitation_already_revoked" ||
            code === "invitation_already_accepted";
          if (!isAlreadyRevoked) throw err;
        }
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }
  }
  return revoked;
}

router.delete(
  "/members/:id",
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: "Missing member id" });
      return;
    }
    // Self-removal guard. The signed-in actor is `req.actualUserId`
    // (alias `req.userId`); we never want the owner to lock
    // themselves out by removing themselves from their own household.
    const actorId = req.actualUserId ?? req.userId;
    if (actorId && id === actorId) {
      res.status(400).json({ error: "You cannot remove yourself" });
      return;
    }
    try {
      const targetEmail = await loadUserEmail(id);
      if (isOwnerEmail(targetEmail)) {
        res.status(400).json({ error: "Cannot remove the owner" });
        return;
      }
      // (#623) Order: revoke invitations first (so a re-sign-in
      // can't race past the membership delete), then drop Clerk
      // user, then drop the membership row + profile, then evict
      // any in-process cache entry for this user. If the
      // invitation revoke step throws (Clerk list/revoke failure
      // on anything other than already-revoked), abort with 502 —
      // we MUST NOT proceed to deleteUser/membership delete with
      // pending invitations still acting as a re-join bootstrap.
      if (targetEmail) {
        try {
          await revokeAllInvitationsForEmail(targetEmail);
        } catch (revokeErr) {
          const re = revokeErr as { message?: string };
          res.status(502).json({
            error:
              "Couldn't revoke pending invitations from Clerk; aborting member removal so the user can't re-join. Please try again. " +
              (re?.message ?? ""),
          });
          return;
        }
      }
      await clerkClient.users.deleteUser(id);
      // Removing the household_members row is what actually revokes
      // shared-data access — every protected route filters by
      // householdId, which is resolved from this row in
      // requireAuth. Without it, the user is treated as a stranger
      // and gets their own empty household if they ever sign in
      // again.
      await db
        .delete(householdMembersTable)
        .where(eq(householdMembersTable.userId, id));
      await db.delete(profilesTable).where(eq(profilesTable.id, id));
      evictHouseholdCacheFor(id);
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

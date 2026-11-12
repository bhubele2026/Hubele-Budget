// PERF HARNESS ONLY — a stand-in for `@clerk/express` in the local perf server bundle (`scripts/perf/build-server.mjs`).
// It is NEVER in the production build: only that script aliases it in, and it writes to its own folder.
//
// Who is signed in: the `x-perf-user` request header (the harness's browser context sends it), else PERF_USER_ID.
// Nothing is verified — the perf server listens on 127.0.0.1 only and its database name must end in `_perf`.
// The real `requireAuth` still runs: it resolves the household from `household_members`, as in production.
// PERF_CLERK_API_MS (default 0) delays each Backend API call (`/me`'s getUser in production is a network call).
import type { NextFunction, Request, Response } from "express";

const apiDelay = async () => {
  const ms = Number(process.env.PERF_CLERK_API_MS ?? 0);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
};

const userOf = (id: string) => ({
  id,
  firstName: "Perf",
  lastName: "Owner",
  username: "perf",
  imageUrl: "",
  primaryEmailAddressId: "email_perf",
  emailAddresses: [{ id: "email_perf", emailAddress: process.env.OWNER_EMAIL ?? "owner@example.com" }],
});

export function clerkMiddleware(_opts?: unknown) {
  return (_req: Request, _res: Response, next: NextFunction) => next();
}

export function getAuth(req: Request) {
  const h = req.headers["x-perf-user"];
  const id = (Array.isArray(h) ? h[0] : h) || process.env.PERF_USER_ID || null;
  return { userId: id, sessionClaims: id ? { userId: id } : undefined, sessionId: id ? "sess_perf" : null };
}

export const clerkClient = {
  users: {
    async getUser(id: string) {
      await apiDelay();
      return userOf(id);
    },
    async getUserList(_q?: unknown) {
      await apiDelay();
      const id = process.env.PERF_USER_ID;
      return { data: id ? [userOf(id)] : [], totalCount: id ? 1 : 0 };
    },
    async deleteUser(_id: string) {
      throw new Error("perf stub: no user deletes");
    },
  },
  invitations: {
    async getInvitationList(_q?: unknown) {
      await apiDelay();
      return { data: [], totalCount: 0 };
    },
    async createInvitation(_q?: unknown) {
      throw new Error("perf stub: no invitations");
    },
    async revokeInvitation(_id: string) {
      throw new Error("perf stub: no invitations");
    },
  },
};

export default { clerkMiddleware, getAuth, clerkClient };

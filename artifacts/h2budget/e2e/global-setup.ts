import { clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

/**
 * Purge stale e2e users (anything with the +clerk_test address tag) before
 * starting the suite. Clerk dev instances are capped at 100 users; if a prior
 * run aborted before its afterAll cleanup, the next run starts failing with
 * `user_quota_exceeded` (surfaced as 403 Forbidden by createUser). Sweeping at
 * setup keeps the harness self-healing.
 */
async function purgeStaleTestUsers(): Promise<void> {
  const clerkBackend = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY!,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
  });
  let purged = 0;
  // Walk the user list in pages until no +clerk_test addresses remain.
  // Each createUser in the suite uses `<prefix>-<rand>+clerk_test@example.com`.
  for (let i = 0; i < 10; i += 1) {
    const list = await clerkBackend.users.getUserList({ limit: 100 });
    const stale = list.data.filter((u) =>
      (u.emailAddresses ?? []).some((e) =>
        e.emailAddress.includes("+clerk_test@"),
      ),
    );
    if (stale.length === 0) break;
    for (const u of stale) {
      try {
        await clerkBackend.users.deleteUser(u.id);
        purged += 1;
      } catch {
        // Best-effort; if a user is already gone we just move on.
      }
    }
  }
  if (purged > 0) {
    // eslint-disable-next-line no-console
    console.log(`[e2e setup] purged ${purged} stale Clerk test user(s)`);
  }
}

export default async function globalSetup() {
  if (
    !process.env.CLERK_PUBLISHABLE_KEY ||
    !process.env.CLERK_SECRET_KEY
  ) {
    throw new Error(
      "CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must be set for Playwright tests.",
    );
  }
  await purgeStaleTestUsers();
  await clerkSetup();
}

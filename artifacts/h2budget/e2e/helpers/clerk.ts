import { expect, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

/**
 * Shared Clerk-backed Playwright harness used by the self-heal e2e specs.
 * Each spec calls createTestUser() to provision a fresh user via the Clerk
 * Backend SDK, then signInAndOpen() to drive the Clerk-hosted SignIn form
 * (including the deterministic test-mode email-verification step) and land
 * on the page under test. Provisioned users are tracked in a per-process
 * registry so each spec's afterAll can clean them up.
 */

const clerkSecret = process.env.CLERK_SECRET_KEY!;
const clerkPub = process.env.CLERK_PUBLISHABLE_KEY!;

export const clerkBackend = createClerkClient({
  secretKey: clerkSecret,
  publishableKey: clerkPub,
});

export type ProvisionedUser = {
  userId: string;
  email: string;
  password: string;
};

export async function createTestUser(
  prefix: string,
  registry: string[],
): Promise<ProvisionedUser> {
  // The "+clerk_test" suffix triggers Clerk's deterministic test-mode email
  // verification (any code submission is accepted as "424242"), which lets us
  // satisfy the new-device verification step Clerk shows after the password
  // step in test instances.
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `${prefix}-${suffix}+clerk_test@example.com`;
  const password = `Pw-${suffix}-${Math.random().toString(36).slice(2, 8)}!A1`;
  const user = await clerkBackend.users.createUser({
    emailAddress: [email],
    password,
    skipPasswordChecks: true,
    skipPasswordRequirement: false,
  });
  registry.push(user.id);
  return { userId: user.id, email, password };
}

export async function cleanupTestUsers(registry: string[]): Promise<void> {
  for (const id of registry) {
    try {
      await clerkBackend.users.deleteUser(id);
    } catch {
      // Best-effort cleanup; CI prod environment may strip the user already.
    }
  }
}

export async function signInAndOpen(
  page: Page,
  email: string,
  // The provisioned password is kept in the signature for symmetry with
  // createTestUser(), but the email-based sign-in path no longer uses it
  // — the Backend SDK mints a sign-in token instead.
  _password: string,
  path: string,
): Promise<void> {
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[console.error]", msg.text());
  });
  await setupClerkTestingToken({ page });
  // Navigate to /sign-in so a Clerk-aware page is mounted; clerk.signIn
  // drives Clerk's JS API directly and bypasses the new-device email
  // verification and any second-factor screens the dev instance enforces.
  await page.goto("/sign-in");
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { Clerk?: { loaded: boolean } }).Clerk !==
        "undefined" &&
      (window as unknown as { Clerk: { loaded: boolean } }).Clerk.loaded === true,
    null,
    { timeout: 30_000 },
  );
  // Email-based sign-in uses the Backend SDK to mint a sign-in token and
  // exchanges it via the ticket strategy — no MFA, no email verification.
  await clerk.signIn({ page, emailAddress: email });
  // Wait for an active session before navigating to the page under test.
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session,
      ),
    null,
    { timeout: 30_000 },
  );
  await page.goto(path);
}

// Re-export so specs can keep their existing import shape if preferred.
export { expect };

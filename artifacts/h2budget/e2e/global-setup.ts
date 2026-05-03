import { clerkSetup } from "@clerk/testing/playwright";

export default async function globalSetup() {
  if (
    !process.env.CLERK_PUBLISHABLE_KEY ||
    !process.env.CLERK_SECRET_KEY
  ) {
    throw new Error(
      "CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must be set for Playwright tests.",
    );
  }
  await clerkSetup();
}

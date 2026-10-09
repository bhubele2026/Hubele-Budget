#!/usr/bin/env node
/**
 * Classic baseline screenshots (S0 of the H2 reinvention, 2026-10-07).
 *
 * Signs in through Clerk exactly as the classic e2e suite does
 * (artifacts/h2budget/e2e/helpers/clerk.ts: testing token, then a backend-
 * minted sign-in ticket — no password, no MFA), opens every route of the app
 * (served at `/` since the switch on 2026-10-09; it was `/classic` when these
 * baselines were first taken), and saves a full-page PNG at a phone and a
 * desktop size.
 * Each later stage's review note compares its screens against these.
 *
 * Output: screenshots/classic-baseline/<390x844|1280x800>/<route>.png
 * (gitignored: screens of a signed-in household are never committed).
 *
 * Needs a running server with the build (`pnpm run build`, then
 * `node artifacts/api-server/dist/index.mjs`) and a Clerk DEVELOPMENT
 * instance's keys. Not run in CI.
 *
 *   CLERK_PUBLISHABLE_KEY=pk_test_… CLERK_SECRET_KEY=sk_test_… \
 *   CAPTURE_BASE_URL=http://localhost:3098 \
 *   [CAPTURE_EMAIL=someone+clerk_test@example.com] \
 *   node scripts/capture-classic.mjs
 *
 * CAPTURE_EMAIL names an existing user to sign in as (use a demo household,
 * never real data). Without it a throwaway `+clerk_test` user is created for
 * the run and deleted afterwards, so the screens show an empty household.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(repoRoot, "screenshots", "classic-baseline");

// Playwright and the Clerk testing helpers are dev dependencies of the classic
// app, not of this scripts folder: resolve them from there.
const fromClassic = createRequire(path.join(repoRoot, "artifacts/h2budget/package.json"));
const load = (id) => import(pathToFileURL(fromClassic.resolve(id)).href);

const BASE_URL = (process.env.CAPTURE_BASE_URL ?? "http://localhost:3098").replace(/\/$/, "");
const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  { name: "1280x800", width: 1280, height: 800, isMobile: false, deviceScaleFactor: 1 },
];
// Every classic route (artifacts/h2budget/src/App.tsx), minus redirects and
// /plaid-oauth (it needs a live Plaid hand-off). Paths are classic-relative.
const ROUTES = [
  "/home",
  "/banking",
  "/forecast/overview",
  "/forecast",
  "/review",
  "/bills",
  "/bills/all",
  "/budget",
  "/allowances",
  "/reports",
  "/reports/spending",
  "/reports/debt",
  "/reports/cashflow",
  "/reports/budget",
  "/reports/behavior",
  "/transactions",
  "/amex",
  "/debts",
  "/avalanche",
  "/mapping-rules",
  "/settings",
];

function slug(route) {
  return route.replace(/^\//, "").replace(/\//g, "-") || "root";
}

async function main() {
  if (!process.env.CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (a development instance) must be set.");
  }
  // @playwright/test is CommonJS that re-exports through `module.exports =`,
  // which Node's named-export detection cannot see: read it off the default.
  const playwright = await load("@playwright/test");
  const chromium = playwright.chromium ?? playwright.default.chromium;
  const { clerk, clerkSetup, setupClerkTestingToken } = await load("@clerk/testing/playwright");
  const { createClerkClient } = await load("@clerk/backend");

  const backend = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  });

  // The testing token that lets Playwright past Clerk's bot protection.
  await clerkSetup();

  let email = process.env.CAPTURE_EMAIL;
  let throwawayUserId = null;
  if (!email) {
    const suffix = Math.random().toString(36).slice(2, 10);
    email = `capture-classic-${suffix}+clerk_test@example.com`;
    const user = await backend.users.createUser({
      emailAddress: [email],
      password: `Pw-${suffix}-${Math.random().toString(36).slice(2, 8)}!A1`,
      skipPasswordChecks: true,
    });
    throwawayUserId = user.id;
  }

  const browser = await chromium.launch({ headless: true });
  const saved = [];
  try {
    for (const vp of VIEWPORTS) {
      const dir = path.join(outRoot, vp.name);
      mkdirSync(dir, { recursive: true });
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        deviceScaleFactor: vp.deviceScaleFactor,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();

      // The signed-out front door first.
      await page.goto(`${BASE_URL}/sign-in`);
      await page.waitForFunction(() => window.Clerk?.loaded === true, null, { timeout: 30_000 });
      await page.screenshot({ path: path.join(dir, "sign-in.png"), fullPage: true });
      saved.push(`${vp.name}/sign-in.png`);

      await setupClerkTestingToken({ page });
      await clerk.signIn({ page, emailAddress: email });
      await page.waitForFunction(() => Boolean(window.Clerk?.session), null, { timeout: 30_000 });

      for (const route of ROUTES) {
        await page.goto(`${BASE_URL}${route}`);
        await page.waitForLoadState("networkidle").catch(() => {});
        // Charts draw in JS; give a lazy route's chunk and its first paint a beat.
        await page.waitForTimeout(800);
        const file = `${slug(route)}.png`;
        await page.screenshot({ path: path.join(dir, file), fullPage: true });
        saved.push(`${vp.name}/${file}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    if (throwawayUserId) await backend.users.deleteUser(throwawayUserId).catch(() => {});
  }
  console.log(`[capture-classic] ${saved.length} screenshots in ${path.relative(repoRoot, outRoot)}/`);
}

main().catch((err) => {
  console.error(`[capture-classic] FAIL: ${err?.message ?? err}`);
  process.exit(1);
});

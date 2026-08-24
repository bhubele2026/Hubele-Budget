import { defineConfig } from "@playwright/test";

// Point the suite at a running dev/preview server. The app deploys on Render
// now, so there is no Replit dev domain to infer — start the web package with
// an explicit PORT (vite.config.ts requires one when serving) and pass the
// matching PLAYWRIGHT_BASE_URL, or rely on Vite's own default port below.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

// THE THEME GUARD'S APP: the real H2 Budget web app (its own index.html,
// main.tsx, App.tsx and vite.config.ts), with two things swapped out so it runs
// with no network and no database:
//   - Clerk → `stubs/` (a signed-in invented person, "Alex"; signed out when the
//     browser holds `guard:signed-out` = "1"),
//   - every `/api/*` call → `api/middleware.mjs`, an invented household
//     ("Cedar Hollow Bank", "Card A" …). Nothing here is real.
// Used by `scripts/verify-theme.mts` (dev server and production build + preview).
//
//   PORT=5251 BASE_PATH=/ pnpm --filter @workspace/h2budget exec vite --config theme-guard/vite.config.mjs
//
// GUARD_APP=<dir> points it at another checkout's `artifacts/h2budget` (the
// "before" build for the light-unchanged proof).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeConfig } from "vite";
import { fixtureApi } from "./api/middleware.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = process.env.GUARD_APP ? path.resolve(process.env.GUARD_APP) : path.resolve(here, "..");
process.env.PORT ||= "5251";
process.env.BASE_PATH ||= "/";
process.env.VITE_CLERK_PUBLISHABLE_KEY ||= "pk_test_guard";
// "dev" is the build id the app's "a new version is available" banner ignores (the fixture's /api/version says "dev" too);
// with a real id the banner would sit over the foot of every page.
process.env.APP_BUILD_ID = "dev";

const { default: base } = await import(pathToFileURL(path.join(app, "vite.config.ts")).href);

export default mergeConfig(base, {
  cacheDir: path.join(app, "tmp/theme-guard-vite-cache"),
  plugins: [fixtureApi({ log: !!process.env.GUARD_LOG })],
  resolve: {
    alias: [
      { find: /^@clerk\/react\/internal$/, replacement: path.join(here, "stubs/clerk-internal.ts") },
      { find: /^@clerk\/react$/, replacement: path.join(here, "stubs/clerk-react.tsx") },
      { find: /^@clerk\/themes$/, replacement: path.join(here, "stubs/clerk-themes.ts") },
    ],
  },
  server: { host: "127.0.0.1", fs: { strict: true, allow: [path.resolve(app, "../.."), path.resolve(here, "../..")] } },
  preview: { host: "127.0.0.1" },
  build: process.env.GUARD_OUT ? { outDir: path.resolve(process.env.GUARD_OUT), emptyOutDir: true } : {},
  clearScreen: false,
  logLevel: process.env.GUARD_LOG ? "info" : "warn",
});

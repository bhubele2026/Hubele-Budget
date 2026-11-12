// PERF HARNESS ONLY — the real H2 Budget web app (its own index.html, main.tsx, App.tsx, vite.config.ts) with Clerk's
// browser SDK swapped for the theme guard's signed-in stand-in (`artifacts/h2budget/theme-guard/stubs/`). Unlike the
// theme guard, `/api/*` is NOT stubbed: the page talks to the local perf server (`server-entry.ts`), which serves this
// build from the same origin. Built by run.mts into PERF_WEB_OUT; never part of `pnpm run build`.
//
// What this cannot show: Clerk's own boot (clerk-js from Clerk's CDN, the session refresh) — the stand-in is ready at
// once. The app's optimistic routes (the auth hint) mean a returning signed-in browser does not wait for it.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../artifacts/h2budget");
// Vite is the web app's dependency, not this folder's: resolve it from there.
const { mergeConfig } = await import(pathToFileURL(createRequire(path.join(app, "package.json")).resolve("vite")).href);
const stubs = path.join(app, "theme-guard/stubs");
process.env.BASE_PATH ||= "/";
process.env.VITE_CLERK_PUBLISHABLE_KEY ||= "pk_test_perf";

const { default: base } = await import(pathToFileURL(path.join(app, "vite.config.ts")).href);

export default mergeConfig(base, {
  cacheDir: path.join(app, "tmp/perf-vite-cache"),
  resolve: {
    alias: [
      { find: /^@clerk\/react\/internal$/, replacement: path.join(stubs, "clerk-internal.ts") },
      { find: /^@clerk\/react$/, replacement: path.join(stubs, "clerk-react.tsx") },
      { find: /^@clerk\/themes$/, replacement: path.join(stubs, "clerk-themes.ts") },
    ],
  },
  build: { outDir: path.resolve(process.env.PERF_WEB_OUT ?? "/private/tmp/claude-501/perf/web-dist"), emptyOutDir: true },
  logLevel: "warn",
});

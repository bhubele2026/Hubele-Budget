import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
// @ts-expect-error -- plain .mjs shared module, no type declarations
import { resolveBuildId } from "../../scripts/build-id.mjs";

// (#823/#833) Per-deploy build identifier baked into the web bundle. The
// API server (artifacts/api-server/build.mjs) resolves it the SAME way
// (shared module: scripts/build-id.mjs) so the loaded bundle and
// `/api/version` agree on what's "current" per deploy. The client poller
// compares them and prompts a reload when they differ. Resolution order:
// APP_BUILD_ID env → .app-build-id file (written once by the deploy
// pre-build hook so both bundles match even with no git) → git short hash
// → "dev" (the client ignores "dev", so the check no-ops — the safe
// failure mode). See scripts/build-id.mjs for the rationale.
const buildId: string = resolveBuildId();

const isServe =
  process.argv.includes("serve") ||
  process.argv.includes("dev") ||
  process.argv.includes("preview");

const rawPort = process.env.PORT;

if (isServe && !rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = rawPort ? Number(rawPort) : 5173;

if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (isServe && !basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  define: {
    __APP_VERSION__: JSON.stringify(buildId),
  },
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  esbuild: {
    // Strip `console.*` and `debugger` from production bundles so they
    // aren't shipped to users (keeps the bundle small AND avoids
    // accidentally leaking diagnostic noise into the browser console
    // in prod). `console.error` and `console.warn` are kept so genuine
    // runtime errors still surface for users to report.
    drop: process.env.NODE_ENV === "production" ? ["debugger"] : [],
    pure:
      process.env.NODE_ENV === "production"
        ? ["console.log", "console.debug", "console.info", "console.trace"]
        : [],
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    sourcemap: false,
    // Split the bulky third-party libs into their own chunks so the
    // main entry stays lean and the browser can cache vendor code
    // across deploys (only the app chunk changes on most releases).
    //
    // FUNCTION form on purpose (not the object form): the object form
    // resolves package ENTRIES ("recharts", "react-dom") and drags every
    // shared dependency into whichever chunk claims it first — that is
    // exactly how the entry came to statically preload vendor-charts and
    // how react-dom fell into vendor-clerk. The function form assigns by
    // module PATH only; shared deps fall to Rollup's natural split, and
    // vendor-charts is only ever pulled by the lazy routes that actually
    // import recharts. Guarded by scripts/check-entry-graph.mjs in CI.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            /\.pnpm\/(recharts@|d3-|victory-vendor@|react-smooth@|recharts-scale@)/.test(
              id,
            )
          ) {
            return "vendor-charts";
          }
          // clsx is pinned here deliberately: it is shared by the app's
          // cn()/cva utilities AND by recharts. Left unassigned, Rollup
          // colours it into vendor-charts, which makes the ENTRY statically
          // import the whole 451 KB charts chunk just to reach clsx
          // (observed 2026-08-23; check-entry-graph.mjs caught it).
          if (
            /\.pnpm\/(react@|react-dom@|scheduler@|wouter@|clsx@)/.test(id)
          ) {
            return "vendor-react";
          }
          if (id.includes("@clerk")) return "vendor-clerk";
          if (id.includes("@tanstack")) return "vendor-query";
          if (id.includes("@dnd-kit")) return "vendor-dnd";
          return undefined;
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});

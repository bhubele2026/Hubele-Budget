import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
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
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
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
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "wouter"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-clerk": ["@clerk/react", "@clerk/themes"],
          "vendor-dnd": [
            "@dnd-kit/core",
            "@dnd-kit/sortable",
            "@dnd-kit/utilities",
          ],
          "vendor-charts": ["recharts"],
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

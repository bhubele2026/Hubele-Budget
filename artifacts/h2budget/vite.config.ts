import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createRequire } from "module";
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

/**
 * Rewrites the `__INTER_WOFF2__` placeholder in index.html to the real URL of
 * the Inter latin woff2, so the font can be PRELOADED without anyone
 * hardcoding a content hash that goes stale on the next build.
 *
 * A webfont discovered inside a stylesheet is always one round trip late: the
 * browser has to fetch and parse the CSS before it learns the font exists.
 * Preloading it starts the download alongside the CSS instead.
 *
 * In a build the file has already been emitted by the CSS pipeline (the
 * `@import "@fontsource-variable/inter/wght.css"` in index.css), so we look its
 * hashed name up in the bundle rather than emitting a SECOND copy — two copies
 * would mean the browser preloads one file and then downloads a different one.
 * In dev nothing is emitted, so we point at the resolved node_modules path,
 * which Vite serves directly.
 */
function interPreload(): Plugin {
  const FILE = "inter-latin-wght-normal.woff2";
  return {
    name: "h2-inter-preload",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        let href: string | undefined;
        if (ctx.bundle) {
          const hit = Object.values(ctx.bundle).find(
            (a) => a.type === "asset" && a.fileName.includes("inter-latin-wght-normal"),
          );
          if (hit) href = `${(basePath ?? "").replace(/\/$/, "")}/${hit.fileName}`;
        } else {
          const require = createRequire(import.meta.url);
          const pkg = require.resolve("@fontsource-variable/inter/package.json");
          href = `/@fs${path.join(path.dirname(pkg), "files", FILE)}`;
        }
        // No font resolved (a dependency change, a renamed subset) — drop the
        // tag rather than shipping a preload that 404s and warns in every
        // console. The font still loads via the stylesheet, one hop later.
        return href
          ? html.replace("__INTER_WOFF2__", href)
          : html.replace(/\n\s*<link rel="preload" href="__INTER_WOFF2__"[^>]*>/, "");
      },
    },
  };
}

export default defineConfig({
  base: basePath,
  define: {
    __APP_VERSION__: JSON.stringify(buildId),
  },
  // ⚠️ Tailwind's optimize pass is ON. It had been disabled, which shipped the
  // stylesheet unminified with every declaration written out long-hand — 110 KB
  // of CSS on a 90 KB budget, and the single largest render-blocking asset on
  // the open path. Turning it on is a byte-for-byte-equivalent minify (Lightning
  // CSS), not a rewrite: same cascade, same output, ~60% smaller.
  plugins: [react(), tailwindcss(), interPreload()],
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
